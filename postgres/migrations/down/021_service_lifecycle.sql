-- Откат 021: вернуть прежний список операций.
-- Записи о start/stop удаляются: без них ограничение не восстановится.
BEGIN;

DELETE FROM admin_operations WHERE kind IN ('start', 'stop');

ALTER TABLE admin_operations DROP CONSTRAINT IF EXISTS admin_operations_kind_check;
ALTER TABLE admin_operations ADD CONSTRAINT admin_operations_kind_check
    CHECK (kind IN ('restart', 'backup', 'restore',
                    'update-check', 'update', 'rollback', 'migration'));

DELETE FROM schema_migrations WHERE version = '021_service_lifecycle';

COMMIT;
