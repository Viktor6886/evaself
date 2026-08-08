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

-- The additive model-state table and compatibility triggers are retained.
-- Old Router versions continue using llm_breaker_state; new versions remain
-- safe if this down migration runs before all new replicas have stopped.

COMMENT ON COLUMN telegram_outbox.priority IS
    'Не используется: миграция 034 откачена. Столбец сохранён, чтобы не потерять значения.';

DELETE FROM schema_migrations WHERE version = '034_outbox_priority';

COMMIT;
