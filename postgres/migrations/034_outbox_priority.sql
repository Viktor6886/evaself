-- =====================================================================
-- Приоритет доставки Telegram.
--
-- Доставка перестаёт быть очередью в порядке поступления. Сообщение
-- кризисного монитора и «печатает…» — не равноценные события, и когда
-- очередь длинная, разница между ними становится разницей между
-- вовремя и никогда.
--
-- Числа, а не имена: сортировать очередь по тексту значило бы завести
-- порядок, который не виден в самом значении. Меньшее число — выше
-- приоритет, шаг 10 оставляет место между ступенями.
--
--    10  кризис
--    20  готовый ответ пользователю
--    30  команды и платежи
--    40  напоминания
--    50  typing и служебные статусы
--
-- Умолчание 20: строка, которую поставили в очередь, ничего о себе не
-- сказав, — это ответ человеку. Ошибиться в эту сторону безопаснее.
--
-- =====================================================================

BEGIN;

ALTER TABLE telegram_outbox
    ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 20;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_priority_check;
ALTER TABLE telegram_outbox
    ADD CONSTRAINT telegram_outbox_priority_check
    CHECK (priority IN (10, 20, 30, 40, 50));

-- Порядок выборки: приоритет, затем готовность, затем возраст.
-- `chat_id` в индексе — для проверки «нет ли у этого чата более
-- раннего незавершённого сообщения», без которой параллельная выборка
-- переставила бы части одного ответа местами.
CREATE INDEX IF NOT EXISTS telegram_outbox_priority_idx
    ON telegram_outbox (priority, available_at, id)
    WHERE status IN ('pending', 'sending', 'retry');

CREATE INDEX IF NOT EXISTS telegram_outbox_chat_pending_idx
    ON telegram_outbox (chat_id, priority, id)
    WHERE status IN ('pending', 'sending', 'retry');

-- Model-scoped breaker state is canonical for the new Router. The original
-- provider-only table remains a compatibility projection, so old and new
-- replicas can overlap during a rolling rollout without changing its PK.
CREATE TABLE IF NOT EXISTS llm_breaker_model_state (
    provider_id        uuid        NOT NULL REFERENCES llm_providers (id) ON DELETE CASCADE,
    model              text        NOT NULL,
    state              text        NOT NULL DEFAULT 'closed',
    consecutive_errors smallint    NOT NULL DEFAULT 0,
    first_error_at     timestamptz,
    opened_at          timestamptz,
    probe_after        timestamptz,
    last_error_code    text,
    last_success_at    timestamptz,
    pinned_out         boolean     NOT NULL DEFAULT false,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, model),
    CONSTRAINT llm_breaker_model_state_check CHECK (state IN ('closed', 'open', 'half_open'))
);

DROP TRIGGER IF EXISTS trg_llm_breaker_model_state_updated_at ON llm_breaker_model_state;
CREATE TRIGGER trg_llm_breaker_model_state_updated_at
    BEFORE UPDATE ON llm_breaker_model_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO llm_breaker_model_state
    (provider_id, model, state, consecutive_errors, first_error_at, opened_at,
     probe_after, last_error_code, last_success_at, pinned_out, updated_at)
SELECT b.provider_id, p.model, b.state, b.consecutive_errors, b.first_error_at,
       b.opened_at, b.probe_after, b.last_error_code, b.last_success_at,
       b.pinned_out, b.updated_at
  FROM llm_breaker_state b
  JOIN llm_providers p ON p.id = b.provider_id
ON CONFLICT (provider_id, model) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_provider_breaker_to_model()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_model text;
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
    SELECT model INTO current_model FROM llm_providers WHERE id = NEW.provider_id;
    IF current_model IS NULL THEN RETURN NEW; END IF;
    INSERT INTO llm_breaker_model_state
        (provider_id, model, state, consecutive_errors, first_error_at, opened_at,
         probe_after, last_error_code, last_success_at, pinned_out)
    VALUES
        (NEW.provider_id, current_model, NEW.state, NEW.consecutive_errors,
         NEW.first_error_at, NEW.opened_at, NEW.probe_after, NEW.last_error_code,
         NEW.last_success_at, NEW.pinned_out)
    ON CONFLICT (provider_id, model) DO UPDATE SET
        state = EXCLUDED.state,
        consecutive_errors = EXCLUDED.consecutive_errors,
        first_error_at = EXCLUDED.first_error_at,
        opened_at = EXCLUDED.opened_at,
        probe_after = EXCLUDED.probe_after,
        last_error_code = EXCLUDED.last_error_code,
        last_success_at = EXCLUDED.last_success_at,
        pinned_out = EXCLUDED.pinned_out;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sync_model_breaker_to_provider()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_model text;
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
    SELECT model INTO current_model FROM llm_providers WHERE id = NEW.provider_id;
    IF current_model IS DISTINCT FROM NEW.model THEN RETURN NEW; END IF;
    INSERT INTO llm_breaker_state
        (provider_id, state, consecutive_errors, first_error_at, opened_at,
         probe_after, last_error_code, last_success_at, pinned_out)
    VALUES
        (NEW.provider_id, NEW.state, NEW.consecutive_errors, NEW.first_error_at,
         NEW.opened_at, NEW.probe_after, NEW.last_error_code, NEW.last_success_at,
         NEW.pinned_out)
    ON CONFLICT (provider_id) DO UPDATE SET
        state = EXCLUDED.state,
        consecutive_errors = EXCLUDED.consecutive_errors,
        first_error_at = EXCLUDED.first_error_at,
        opened_at = EXCLUDED.opened_at,
        probe_after = EXCLUDED.probe_after,
        last_error_code = EXCLUDED.last_error_code,
        last_success_at = EXCLUDED.last_success_at,
        pinned_out = EXCLUDED.pinned_out;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_provider_breaker_to_model ON llm_breaker_state;
CREATE TRIGGER trg_provider_breaker_to_model
    AFTER INSERT OR UPDATE ON llm_breaker_state
    FOR EACH ROW EXECUTE FUNCTION sync_provider_breaker_to_model();

DROP TRIGGER IF EXISTS trg_model_breaker_to_provider ON llm_breaker_model_state;
CREATE TRIGGER trg_model_breaker_to_provider
    AFTER INSERT OR UPDATE ON llm_breaker_model_state
    FOR EACH ROW EXECUTE FUNCTION sync_model_breaker_to_provider();

CREATE OR REPLACE FUNCTION sync_provider_model_breaker_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE model_row llm_breaker_model_state%ROWTYPE;
BEGIN
    SELECT * INTO model_row
      FROM llm_breaker_model_state
     WHERE provider_id = NEW.id AND model = NEW.model;
    INSERT INTO llm_breaker_state
        (provider_id, state, consecutive_errors, first_error_at, opened_at,
         probe_after, last_error_code, last_success_at, pinned_out)
    VALUES
        (NEW.id, COALESCE(model_row.state, 'closed'), COALESCE(model_row.consecutive_errors, 0),
         model_row.first_error_at, model_row.opened_at, model_row.probe_after,
         model_row.last_error_code, model_row.last_success_at,
         COALESCE(model_row.pinned_out, false))
    ON CONFLICT (provider_id) DO UPDATE SET
        state = EXCLUDED.state,
        consecutive_errors = EXCLUDED.consecutive_errors,
        first_error_at = EXCLUDED.first_error_at,
        opened_at = EXCLUDED.opened_at,
        probe_after = EXCLUDED.probe_after,
        last_error_code = EXCLUDED.last_error_code,
        last_success_at = EXCLUDED.last_success_at,
        pinned_out = EXCLUDED.pinned_out;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_provider_model_breaker_projection ON llm_providers;
CREATE TRIGGER trg_provider_model_breaker_projection
    AFTER UPDATE OF model ON llm_providers
    FOR EACH ROW
    WHEN (OLD.model IS DISTINCT FROM NEW.model)
    EXECUTE FUNCTION sync_provider_model_breaker_projection();

-- Production route chains are operator-owned. Seed only an empty target and
-- copy the complete ordered source chain, including every configured fallback;
-- never invent a provider or credential and never overwrite admin choices.
INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'fast', source.provider_id, source.position
  FROM llm_route_providers source
 WHERE source.route_code = 'chat'
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'fast')
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'classifier', source.provider_id, source.position
  FROM llm_route_providers source
 WHERE source.route_code = CASE
     WHEN EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'json') THEN 'json'
     ELSE 'chat'
   END
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'classifier')
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'research', source.provider_id, source.position
  FROM llm_route_providers source
 WHERE source.route_code = CASE
     WHEN EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'deep') THEN 'deep'
     ELSE 'chat'
   END
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'research')
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('034_outbox_priority')
ON CONFLICT (version) DO NOTHING;

COMMIT;
