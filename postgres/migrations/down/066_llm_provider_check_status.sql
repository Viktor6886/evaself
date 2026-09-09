-- Откат: снимается только ограничение и колонка состояния.
--
-- last_check_ok, last_check_message и last_models не трогаются: они были и
-- до этой миграции и остаются единственным, на что смотрит старый код.
-- Потеря last_check_status безболезненна — следующая проверка её заполнит.

BEGIN;

ALTER TABLE llm_providers
    DROP CONSTRAINT IF EXISTS llm_providers_last_check_status_check;

ALTER TABLE llm_providers
    DROP COLUMN IF EXISTS last_check_status;

DELETE FROM schema_migrations WHERE version = '066_llm_provider_check_status';

COMMIT;
