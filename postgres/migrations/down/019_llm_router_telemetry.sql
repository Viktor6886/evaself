-- Откат 019: телеметрия, расходы, breaker.
BEGIN;
DROP VIEW IF EXISTS v_llm_provider_health;
DROP TRIGGER IF EXISTS trg_llm_breaker_state_updated_at ON llm_breaker_state;
DROP TABLE IF EXISTS llm_breaker_state;
DROP TABLE IF EXISTS llm_spend_ledger;
DROP TABLE IF EXISTS llm_requests;
DELETE FROM schema_migrations WHERE version = '019_llm_router_telemetry';
COMMIT;
