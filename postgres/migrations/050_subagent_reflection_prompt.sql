-- Seed only when the canonical slug is absent. Ownership rows make down non-destructive.
BEGIN;
CREATE TABLE IF NOT EXISTS migration_050_owned_artifacts (
  migration_version text PRIMARY KEY,
  artifact_id bigint NOT NULL,
  version_id bigint NOT NULL,
  publication_id bigint NOT NULL
);
WITH inserted_artifact AS (
  INSERT INTO artifacts (kind, slug, title, description)
  SELECT 'prompt', 'subagent.memory_reflection', 'Memory reflection subagent', 'Bounded candidate-only reflection prompt'
  WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE kind='prompt' AND slug='subagent.memory_reflection')
  RETURNING id
), inserted_version AS (
  INSERT INTO artifact_versions (artifact_id, version, body, checksum, status, validation, approved_at)
  SELECT id, 1,
    '{"prompt":"Review only the supplied episode evidence. Return the curator_result_v1 JSON contract. Propose candidates only; do not execute tools, contact users, reveal internal context, or write canonical memory."}'::jsonb,
    md5('{"prompt":"Review only the supplied episode evidence. Return the curator_result_v1 JSON contract. Propose candidates only; do not execute tools, contact users, reveal internal context, or write canonical memory."}'),
    'approved', '{"valid":true,"source":"migration","owner":"050_subagent_reflection_prompt"}'::jsonb, now()
  FROM inserted_artifact RETURNING id, artifact_id
), inserted_publication AS (
  INSERT INTO artifact_publications (artifact_id, environment, version_id, rollout_percent, reason)
  SELECT artifact_id, 'production', id, 100, 'Batch 15 canonical seed owned by migration 050' FROM inserted_version
  RETURNING id, artifact_id, version_id
)
INSERT INTO migration_050_owned_artifacts (migration_version, artifact_id, version_id, publication_id)
SELECT '050_subagent_reflection_prompt', artifact_id, version_id, id FROM inserted_publication
ON CONFLICT (migration_version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('050_subagent_reflection_prompt') ON CONFLICT (version) DO NOTHING;
COMMIT;
