-- =====================================================================
-- Ротация провайдеров: цепочка вместо пары «основной + резерв».
--
-- Как было. У сценария распознавания было ровно два провайдера, и
-- вторая попытка допускалась ровно одна. Логика «дороже одного лишнего
-- запроса платить не хотим» верна для сбоя сети, но не для случая, ради
-- которого всё и затевалось: у провайдера кончились ВСЕ ключи. Тогда
-- второй провайдер — не роскошь, а единственный способ ответить
-- пользователю, и если не сработал он, то есть смысл в третьем.
--
-- Как стало. У сценария цепочка до шести провайдеров, порядок задаёт
-- администратор, перебор идёт сверху вниз. Ровно так же, как уже
-- устроен LLM Router: два разных механизма для одной и той же задачи в
-- одной системе — лишний повод ошибиться.
--
-- Ротацию можно выключить. Тогда работает только первый провайдер, а
-- отказ остаётся отказом. Это не теоретическая настройка: у провайдеров
-- разная цена и разное качество, и «лучше промолчать, чем ответить
-- дешёвой моделью» — законное решение владельца.
--
-- Три уровня отказоустойчивости не надо путать между собой:
--
--   ключ      (026) — тот же провайдер, та же цена. Внутри одной попытки.
--   провайдер (027) — другой провайдер, другая цена. Эта миграция.
--   сценарий  (024) — что вообще делать, если не смог никто.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Цепочка провайдеров распознавания
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_route_providers (
    use_case   text        NOT NULL REFERENCES stt_routes (use_case) ON DELETE CASCADE,
    config_id  uuid        NOT NULL REFERENCES stt_provider_configs (id) ON DELETE RESTRICT,

    -- Порядок перебора. 0 — основной, дальше резервы. Предел в пять
    -- резервов взят у LLM Router: цепочка длиннее — это уже не
    -- отказоустойчивость, а способ незаметно потратить деньги.
    position   smallint    NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid        NULL REFERENCES admin_users (id) ON DELETE SET NULL,

    PRIMARY KEY (use_case, config_id),
    CONSTRAINT stt_route_providers_position_check CHECK (position BETWEEN 0 AND 5)
);

-- Две конфигурации не могут занимать одну позицию: перебор перестал бы
-- быть определённым, а «кто первый» решал бы порядок строк в таблице.
CREATE UNIQUE INDEX IF NOT EXISTS stt_route_providers_position_uidx
    ON stt_route_providers (use_case, position);

CREATE INDEX IF NOT EXISTS stt_route_providers_config_idx
    ON stt_route_providers (config_id);

-- Выключатель ротации. Значение по умолчанию — включено: установка, где
-- резерв уже назначен, после обновления обязана вести себя как прежде.
ALTER TABLE stt_routes
    ADD COLUMN IF NOT EXISTS rotation_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- 2. Перенос назначенных провайдеров в цепочку
-- ---------------------------------------------------------------------
-- При повторном прогоне миграции старые колонки уже удалены. Обычный
-- INSERT всё равно разбирается PostgreSQL и падает ещё до IF, поэтому
-- обращение к legacy-схеме выполняем динамически только пока она есть.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'stt_routes'
           AND column_name = 'primary_config_id'
    ) THEN
        EXECUTE $sql$
            INSERT INTO stt_route_providers (use_case, config_id, position)
            SELECT use_case, primary_config_id, 0
              FROM stt_routes
             WHERE primary_config_id IS NOT NULL
            ON CONFLICT DO NOTHING
        $sql$;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'stt_routes'
           AND column_name = 'fallback_config_id'
    ) THEN
        EXECUTE $sql$
            INSERT INTO stt_route_providers (use_case, config_id, position)
            SELECT use_case, fallback_config_id, 1
              FROM stt_routes
             WHERE fallback_config_id IS NOT NULL
            ON CONFLICT DO NOTHING
        $sql$;
    END IF;
END $$;

-- Старые колонки убираются, а не остаются «для совместимости». Две
-- копии одной правды разъезжаются при первой же правке, и разбираться
-- потом, какая из них настоящая, придётся в проде.
ALTER TABLE stt_routes DROP CONSTRAINT IF EXISTS stt_routes_distinct_check;
ALTER TABLE stt_routes DROP COLUMN IF EXISTS primary_config_id;
ALTER TABLE stt_routes DROP COLUMN IF EXISTS fallback_config_id;

-- ---------------------------------------------------------------------
-- 3. Попыток на одно аудио теперь больше двух
-- ---------------------------------------------------------------------
-- Ограничение attempt_index BETWEEN 1 AND 2 было записью правила «не
-- более одного резерва» в схеме. Правило изменилось — ограничение тоже.
ALTER TABLE stt_usage_events DROP CONSTRAINT IF EXISTS stt_usage_attempt_check;
ALTER TABLE stt_usage_events ADD CONSTRAINT stt_usage_attempt_check
    CHECK (attempt_index BETWEEN 1 AND 6);

-- ---------------------------------------------------------------------
-- 4. Тот же выключатель для текстовых моделей
-- ---------------------------------------------------------------------
-- Цепочка у LLM Router уже была (018), а выключателя не было: роутер
-- всегда шёл до конца списка. Для маршрута chat, которым пользуется
-- Letta, это означало, что владелец не мог запретить подмену модели
-- разговора на резервную — а разница в стиле ответа заметна.
ALTER TABLE llm_routes
    ADD COLUMN IF NOT EXISTS rotation_enabled boolean NOT NULL DEFAULT true;

-- Причина «резерв отсечён выключенной ротацией» — такая же причина
-- несостоявшейся подмены, как несовместимость или открытый breaker, и
-- в телеметрии должна называться, а не выглядеть тишиной.
ALTER TABLE llm_requests DROP CONSTRAINT IF EXISTS llm_requests_switch_reason_check;
ALTER TABLE llm_requests ADD CONSTRAINT llm_requests_switch_reason_check CHECK (
    switch_reason IS NULL OR switch_reason IN (
        'rate_limited', 'server_error', 'connection_failed', 'timeout',
        'empty_response', 'invalid_response', 'model_error', 'quota_exhausted',
        'budget_exceeded', 'json_contract_failed', 'tool_calls_failed',
        'latency_exceeded', 'breaker_open', 'incompatible', 'rotation_disabled'
    )
);

INSERT INTO schema_migrations (version) VALUES ('027_provider_rotation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
