-- =====================================================================
-- Откат 034.
--
-- Колонки не удаляются: `DROP COLUMN` уничтожает значения, а правило
-- «down-миграция не уничтожает исходные строки» распространяется и на
-- столбцы. Снимаются только индексы и ограничение — после отката
-- очередь снова разбирается в порядке поступления, как до 034.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS telegram_outbox_priority_idx;
DROP INDEX IF EXISTS telegram_outbox_chat_pending_idx;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_priority_check;

COMMENT ON COLUMN telegram_outbox.priority IS
    'Не используется: миграция 034 откачена. Столбец сохранён, чтобы не потерять значения.';

DELETE FROM schema_migrations WHERE version = '034_outbox_priority';

COMMIT;
