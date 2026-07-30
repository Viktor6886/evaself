-- Откат 017: снять расширение цепочки, вернуть единственную активную
-- конфигурацию. Столбцы удаляются вместе с данными о лимитах и бюджетах —
-- это осознанно: без роутера они бессмысленны.
BEGIN;

DROP INDEX IF EXISTS llm_providers_chain_idx;

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_quality_tier_check,
    DROP CONSTRAINT IF EXISTS llm_providers_priority_check,
    DROP CONSTRAINT IF EXISTS llm_providers_timeouts_check,
    DROP CONSTRAINT IF EXISTS llm_providers_retries_check,
    DROP CONSTRAINT IF EXISTS llm_providers_concurrency_check,
    DROP CONSTRAINT IF EXISTS llm_providers_generation_defaults_check;

ALTER TABLE llm_providers
    DROP COLUMN IF EXISTS enabled,
    DROP COLUMN IF EXISTS priority,
    DROP COLUMN IF EXISTS connect_timeout_ms,
    DROP COLUMN IF EXISTS request_timeout_ms,
    DROP COLUMN IF EXISTS max_retries,
    DROP COLUMN IF EXISTS max_rpm,
    DROP COLUMN IF EXISTS max_tpm,
    DROP COLUMN IF EXISTS max_concurrency,
    DROP COLUMN IF EXISTS max_output_tokens,
    DROP COLUMN IF EXISTS max_latency_ms,
    DROP COLUMN IF EXISTS supports_tools,
    DROP COLUMN IF EXISTS supports_json,
    DROP COLUMN IF EXISTS supports_vision,
    DROP COLUMN IF EXISTS supports_streaming,
    DROP COLUMN IF EXISTS quality_tier,
    DROP COLUMN IF EXISTS languages,
    DROP COLUMN IF EXISTS sensitive_data_allowed,
    DROP COLUMN IF EXISTS price_in_micro,
    DROP COLUMN IF EXISTS price_out_micro,
    DROP COLUMN IF EXISTS currency,
    DROP COLUMN IF EXISTS daily_budget_micro,
    DROP COLUMN IF EXISTS monthly_budget_micro,
    DROP COLUMN IF EXISTS generation_defaults;

-- Больше одной активной строки быть не могло и раньше, но после отката
-- уникальный индекс восстанавливается только если данные это позволяют.
UPDATE llm_providers SET is_active = false
 WHERE is_active
   AND id <> (SELECT id FROM llm_providers WHERE is_active ORDER BY updated_at DESC LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_one_active_uidx
    ON llm_providers ((is_active)) WHERE is_active;

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_protocol_check;
DELETE FROM llm_providers WHERE protocol <> 'openai-compatible';
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_protocol_check
    CHECK (protocol IN ('openai-compatible'));

DELETE FROM schema_migrations WHERE version = '017_llm_router_providers';

COMMIT;
