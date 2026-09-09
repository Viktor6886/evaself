-- Откат: список видов операций возвращается к прежнему.
--
-- Строки `start` и `stop`, если они успели появиться, переводятся в
-- `restart` — иначе ограничение не встанет обратно. Действие при этом не
-- теряется: сервис и время остались в самой строке, а `restart` — то,
-- чем эти операции и были для прежней схемы. Удалять их нельзя: это
-- журнал того, что человек делал с установкой.

BEGIN;

ALTER TABLE admin_operations
    DROP CONSTRAINT IF EXISTS admin_operations_kind_check;

UPDATE admin_operations SET kind = 'restart' WHERE kind IN ('start', 'stop');

ALTER TABLE admin_operations
    ADD CONSTRAINT admin_operations_kind_check
    CHECK (kind IN ('restart', 'backup', 'restore',
                    'update-check', 'update', 'rollback', 'migration'));

DELETE FROM schema_migrations WHERE version = '068_lifecycle_operation_kinds';

COMMIT;
