BEGIN;

-- Колонки удаляются вместе с содержимым: это текст сообщений Евы, и
-- откат схемы — единственное место, где его исчезновение ожидаемо.
-- Строки при этом остаются: слот проактивного сообщения защищает от
-- повторной отправки, и потеря строки означала бы второе сообщение.
DROP INDEX IF EXISTS task_events_sent_idx;
DROP INDEX IF EXISTS proactive_messages_sent_idx;

ALTER TABLE proactive_messages DROP CONSTRAINT IF EXISTS proactive_messages_text_len_check;
ALTER TABLE proactive_messages
    DROP COLUMN IF EXISTS sent_at,
    DROP COLUMN IF EXISTS message_text;

DELETE FROM schema_migrations WHERE version = '080_eva_own_messages';

COMMIT;
