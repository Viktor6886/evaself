-- Откат: снимается только пул. api_key_encrypted не трогается — он и был
-- единственным ключом до этой миграции и остаётся им после отката, потому
-- что новый код держит в нём первый ключ пула. Провайдер после отката
-- продолжает работать, теряя лишь запасные ключи.

BEGIN;

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_api_keys_limit_check;

ALTER TABLE llm_providers
    DROP COLUMN IF EXISTS api_keys_encrypted;

DELETE FROM schema_migrations WHERE version = '069_llm_provider_key_pool';

COMMIT;
