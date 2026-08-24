BEGIN;
DROP TABLE IF EXISTS goal_program_runs;
DELETE FROM schema_migrations WHERE version = '065_goal_program_runs';
COMMIT;
