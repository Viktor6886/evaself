BEGIN;

ALTER TABLE sdk_settings
  ADD COLUMN IF NOT EXISTS automatic_context_management jsonb NOT NULL
  DEFAULT '{"enabled":false,"compaction_message_threshold":300,"rotation_message_threshold":600,"compaction_mode":"sliding_window","sliding_window_percentage":0.5}'::jsonb;

ALTER TABLE sdk_settings DROP CONSTRAINT IF EXISTS sdk_settings_context_management_check;
ALTER TABLE sdk_settings ADD CONSTRAINT sdk_settings_context_management_check CHECK (
  jsonb_typeof(automatic_context_management) = 'object'
  AND jsonb_typeof(automatic_context_management->'enabled') = 'boolean'
  AND (automatic_context_management->>'compaction_message_threshold')::integer >= 10
  AND (automatic_context_management->>'rotation_message_threshold')::integer
      > (automatic_context_management->>'compaction_message_threshold')::integer
  AND automatic_context_management->>'compaction_mode' IN ('sliding_window', 'all', 'self_compact_sliding_window', 'self_compact_all')
  AND (automatic_context_management->>'sliding_window_percentage')::numeric > 0
  AND (automatic_context_management->>'sliding_window_percentage')::numeric < 1
);

INSERT INTO schema_migrations (version) VALUES ('048_context_management')
ON CONFLICT (version) DO NOTHING;

COMMIT;
