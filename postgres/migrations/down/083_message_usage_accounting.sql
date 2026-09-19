BEGIN;

-- Откат удаляет только добавленные служебные маркеры. Сами сообщения,
-- outbox-строки и агрегированные usage_counters остаются неизменными.
ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_usage_amount_check;

ALTER TABLE telegram_outbox
    DROP COLUMN IF EXISTS usage_charged,
    DROP COLUMN IF EXISTS usage_amount,
    DROP COLUMN IF EXISTS usage_metric;

DELETE FROM schema_migrations WHERE version = '083_message_usage_accounting';

COMMIT;
