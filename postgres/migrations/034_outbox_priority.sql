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

-- Breaker state is shared by every Router replica and isolated by both
-- provider profile and concrete model. A provider profile can be retargeted
-- to another model without inheriting the previous model's outage state.
ALTER TABLE llm_breaker_state
    ADD COLUMN IF NOT EXISTS model text;

UPDATE llm_breaker_state b
   SET model = p.model
  FROM llm_providers p
 WHERE p.id = b.provider_id
   AND b.model IS NULL;

ALTER TABLE llm_breaker_state
    ALTER COLUMN model SET NOT NULL;

DO $$
DECLARE key_columns smallint;
BEGIN
    SELECT array_length(conkey, 1)
      INTO key_columns
      FROM pg_constraint
     WHERE conrelid = 'llm_breaker_state'::regclass
       AND contype = 'p';
    IF key_columns IS DISTINCT FROM 2 THEN
        ALTER TABLE llm_breaker_state DROP CONSTRAINT llm_breaker_state_pkey;
        ALTER TABLE llm_breaker_state ADD PRIMARY KEY (provider_id, model);
    END IF;
END $$;

CREATE OR REPLACE VIEW v_llm_provider_health AS
SELECT p.id,
       p.name,
       p.enabled,
       p.priority,
       p.model,
       COALESCE(b.state, 'closed')          AS breaker_state,
       b.opened_at,
       b.probe_after,
       b.pinned_out,
       b.last_error_code,
       b.last_success_at,
       day.cost_micro                       AS spent_today_micro,
       p.daily_budget_micro,
       month.cost_micro                     AS spent_month_micro,
       p.monthly_budget_micro,
       recent.requests                      AS requests_1h,
       recent.failures                      AS failures_1h,
       recent.p95_latency_ms
  FROM llm_providers p
  LEFT JOIN llm_breaker_state b
         ON b.provider_id = p.id AND b.model = p.model
  LEFT JOIN llm_spend_ledger day
         ON day.provider_id = p.id
        AND day.period = 'day'
        AND day.period_start = (now() AT TIME ZONE 'UTC')::date
  LEFT JOIN llm_spend_ledger month
         ON month.provider_id = p.id
        AND month.period = 'month'
        AND month.period_start = date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date
  LEFT JOIN LATERAL (
      SELECT count(*) AS requests,
             count(*) FILTER (WHERE NOT succeeded) AS failures,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
        FROM llm_requests
       WHERE actual_provider_id = p.id
         AND started_at > now() - interval '1 hour'
  ) recent ON true;

INSERT INTO schema_migrations (version)
VALUES ('034_outbox_priority')
ON CONFLICT (version) DO NOTHING;

COMMIT;
