-- =====================================================================
-- Откат 033.
--
-- Снимается только ограничение. Строк оно не трогало: `NOT VALID`
-- означает, что существующие записи не проверялись и не менялись,
-- поэтому откат ничего не теряет.
-- =====================================================================

BEGIN;

ALTER TABLE turn_runs
    DROP CONSTRAINT IF EXISTS turn_runs_owner_present;

DELETE FROM schema_migrations WHERE version = '033_turn_owner_constraint';

COMMIT;
