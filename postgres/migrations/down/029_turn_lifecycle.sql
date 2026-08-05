-- Откат шага 03. Записи жизненного цикла — производная информация:
-- ход пользователя и его ответ хранятся в telegram_updates и
-- telegram_outbox, и они этим откатом не затрагиваются.
BEGIN;

DROP INDEX IF EXISTS turn_transitions_run_idx;
DROP INDEX IF EXISTS turn_runs_update_idx;
DROP INDEX IF EXISTS turn_runs_active_idx;
DROP INDEX IF EXISTS turn_runs_user_recent_idx;

DROP TABLE IF EXISTS turn_transitions;
DROP TABLE IF EXISTS turn_runs;

DELETE FROM schema_migrations WHERE version = '029_turn_lifecycle';

COMMIT;
