BEGIN;
DELETE FROM schema_migrations WHERE version = '048_context_management';
ALTER TABLE sdk_settings DROP CONSTRAINT IF EXISTS sdk_settings_context_management_check;
ALTER TABLE sdk_settings DROP COLUMN IF EXISTS automatic_context_management;
COMMIT;
