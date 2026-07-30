-- =====================================================================
-- LLM Router, часть 1 из 3: провайдеры.
--
-- До этой миграции таблица описывала ровно одну активную конфигурацию:
-- уникальный частичный индекс llm_providers_one_active_uidx физически
-- запрещал вторую. Роутеру нужна цепочка, поэтому индекс снимается, а
-- вместо него появляется приоритет и признак включённости.
--
-- Столбец is_active сохраняется: он по-прежнему означает «конфигурация,
-- которой настроен Letta App Server», то есть сам роутер. Ломать
-- существующий код настройки App Server эта миграция не должна.
--
-- Все ADD COLUMN идут с IF NOT EXISTS, миграция идемпотентна.
-- =====================================================================

BEGIN;

-- Anthropic-совместимые провайдеры отличаются форматом запроса, а не
-- транспортом: system prompt отдельным полем, свои роли и tool calling.
ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_protocol_check;
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_protocol_check
    CHECK (protocol IN ('openai-compatible', 'anthropic-compatible'));

-- Цепочка вместо единственного активного.
DROP INDEX IF EXISTS llm_providers_one_active_uidx;

ALTER TABLE llm_providers
    ADD COLUMN IF NOT EXISTS enabled                boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS priority               integer NOT NULL DEFAULT 100,

    -- таймауты и повторы
    ADD COLUMN IF NOT EXISTS connect_timeout_ms     integer NOT NULL DEFAULT 10000,
    ADD COLUMN IF NOT EXISTS request_timeout_ms     integer NOT NULL DEFAULT 180000,
    ADD COLUMN IF NOT EXISTS max_retries            integer NOT NULL DEFAULT 2,

    -- лимиты скорости и параллелизма
    ADD COLUMN IF NOT EXISTS max_rpm                integer,
    ADD COLUMN IF NOT EXISTS max_tpm                bigint,
    ADD COLUMN IF NOT EXISTS max_concurrency        integer NOT NULL DEFAULT 8,

    -- ограничения модели
    ADD COLUMN IF NOT EXISTS max_output_tokens      integer NOT NULL DEFAULT 4096,
    ADD COLUMN IF NOT EXISTS max_latency_ms         integer,

    -- профиль возможностей: по нему выбирается совместимый резерв
    ADD COLUMN IF NOT EXISTS supports_tools         boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS supports_json          boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS supports_vision        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS supports_streaming     boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS quality_tier           smallint NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS languages              text[] NOT NULL DEFAULT ARRAY['ru', 'en'],
    ADD COLUMN IF NOT EXISTS sensitive_data_allowed boolean NOT NULL DEFAULT false,

    -- стоимость и бюджеты, в минорных единицах валюты на миллион токенов
    ADD COLUMN IF NOT EXISTS price_in_micro         bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS price_out_micro        bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS currency               text NOT NULL DEFAULT 'USD',
    ADD COLUMN IF NOT EXISTS daily_budget_micro     bigint,
    ADD COLUMN IF NOT EXISTS monthly_budget_micro   bigint,

    -- параметры генерации по умолчанию
    ADD COLUMN IF NOT EXISTS generation_defaults    jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_quality_tier_check,
    DROP CONSTRAINT IF EXISTS llm_providers_priority_check,
    DROP CONSTRAINT IF EXISTS llm_providers_timeouts_check,
    DROP CONSTRAINT IF EXISTS llm_providers_retries_check,
    DROP CONSTRAINT IF EXISTS llm_providers_concurrency_check,
    DROP CONSTRAINT IF EXISTS llm_providers_generation_defaults_check;

ALTER TABLE llm_providers
    -- 1 — лучшее качество, 5 — самое слабое. Резерв не должен оказаться
    -- заметно слабее основного без явного решения администратора.
    ADD CONSTRAINT llm_providers_quality_tier_check
        CHECK (quality_tier BETWEEN 1 AND 5),
    ADD CONSTRAINT llm_providers_priority_check
        CHECK (priority BETWEEN 0 AND 10000),
    ADD CONSTRAINT llm_providers_timeouts_check
        CHECK (connect_timeout_ms BETWEEN 1000 AND 120000
           AND request_timeout_ms BETWEEN 5000 AND 600000
           AND connect_timeout_ms <= request_timeout_ms),
    -- Ноль повторов допустим: он означает «сразу к резерву».
    ADD CONSTRAINT llm_providers_retries_check
        CHECK (max_retries BETWEEN 0 AND 5),
    ADD CONSTRAINT llm_providers_concurrency_check
        CHECK (max_concurrency BETWEEN 1 AND 256),
    ADD CONSTRAINT llm_providers_generation_defaults_check
        CHECK (jsonb_typeof(generation_defaults) = 'object');

-- Порядок обхода цепочки: приоритет, затем стабильный тай-брейк по имени,
-- чтобы два провайдера с одинаковым приоритетом не менялись местами между
-- запросами.
CREATE INDEX IF NOT EXISTS llm_providers_chain_idx
    ON llm_providers (enabled, priority, lower(name))
    WHERE enabled;

-- Существующая единственная конфигурация становится головой цепочки.
UPDATE llm_providers SET priority = 0 WHERE is_active AND priority = 100;

INSERT INTO schema_migrations (version) VALUES ('017_llm_router_providers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
