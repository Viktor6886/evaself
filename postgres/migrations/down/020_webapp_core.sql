-- Откат 020: новые таблицы Mini App и колонка типа записи.
BEGIN;

DROP TABLE IF EXISTS eva_focus_sessions;
DROP TABLE IF EXISTS eva_decisions;
DROP TABLE IF EXISTS daily_focus_selections;
DROP TABLE IF EXISTS user_checkins;

DROP INDEX IF EXISTS eva_notes_user_type_updated_idx;
ALTER TABLE eva_notes DROP CONSTRAINT IF EXISTS eva_notes_entry_type_check;
ALTER TABLE eva_notes DROP COLUMN IF EXISTS entry_type;

DELETE FROM schema_migrations WHERE version = '020_webapp_core';

COMMIT;
