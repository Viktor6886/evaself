-- Откат 022: убрать заметки панели и индекс поиска по имени.
--
-- Согласование is_blocked/state не откатывается: прежнее состояние было
-- противоречивым (диалог заблокирован, а пользователь числится активным),
-- восстанавливать его нечем и незачем. Оба флага остаются согласованными.

BEGIN;

DROP INDEX IF EXISTS users_first_name_trgm;
DROP TABLE IF EXISTS admin_user_notes;

DELETE FROM schema_migrations WHERE version = '022_users_admin';

COMMIT;
