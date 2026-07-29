-- Обратная миграция фазы 1. Требует явного запуска оператором.
BEGIN;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS secret_records;
DROP TABLE IF EXISTS config_versions;
DROP TABLE IF EXISTS system_settings;
DROP TABLE IF EXISTS sudo_grants;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS admin_users;
DELETE FROM schema_migrations WHERE version = '014_admin_panel_phase1';

COMMIT;
