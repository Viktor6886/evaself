-- The additive priority column is retained: dropping it would destroy values
-- written by a newer application during rollback. Old code ignores it.

BEGIN;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_priority_check;

DELETE FROM schema_migrations WHERE version = '034_parallel_outbox';

COMMIT;
