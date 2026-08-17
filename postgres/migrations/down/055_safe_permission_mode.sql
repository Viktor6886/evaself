BEGIN;
-- Возврат прежнего умолчания. Значение в строке не трогаем: какой режим
-- выбран сейчас — решение установки, и откат схемы его не отменяет.
ALTER TABLE sdk_settings
  ALTER COLUMN permission_mode SET DEFAULT 'unrestricted';
DELETE FROM schema_migrations WHERE version='055_safe_permission_mode';
COMMIT;
