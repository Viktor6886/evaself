BEGIN;
DELETE FROM artifact_publications p USING migration_050_owned_artifacts o
 WHERE o.migration_version='050_subagent_reflection_prompt' AND p.id=o.publication_id;
ALTER TABLE artifact_versions DISABLE TRIGGER artifact_versions_immutable_trg;
DELETE FROM artifact_versions v USING migration_050_owned_artifacts o
 WHERE o.migration_version='050_subagent_reflection_prompt' AND v.id=o.version_id;
ALTER TABLE artifact_versions ENABLE TRIGGER artifact_versions_immutable_trg;
DELETE FROM artifacts a USING migration_050_owned_artifacts o
 WHERE o.migration_version='050_subagent_reflection_prompt' AND a.id=o.artifact_id;
DELETE FROM migration_050_owned_artifacts WHERE migration_version='050_subagent_reflection_prompt';
DROP TABLE IF EXISTS migration_050_owned_artifacts;
DELETE FROM schema_migrations WHERE version='050_subagent_reflection_prompt';
COMMIT;
