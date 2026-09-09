BEGIN;

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_price_cached_in_check;
ALTER TABLE llm_providers DROP COLUMN IF EXISTS price_cached_in_micro;
ALTER TABLE llm_spend_ledger DROP COLUMN IF EXISTS cached_tokens_in;
ALTER TABLE llm_requests DROP COLUMN IF EXISTS cached_tokens_in;

DELETE FROM schema_migrations WHERE version = '078_llm_cached_input';

COMMIT;
