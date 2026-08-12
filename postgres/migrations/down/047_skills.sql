BEGIN;
DROP TABLE IF EXISTS skill_routing_events;
DROP TABLE IF EXISTS skill_routing_state;
DROP TABLE IF EXISTS skill_search_index;
DROP INDEX IF EXISTS artifact_versions_artifact_checksum_uidx;
DELETE FROM schema_migrations WHERE version='047_skills';
COMMIT;
