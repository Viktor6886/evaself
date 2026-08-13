BEGIN;

ALTER TABLE agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_status_check;
ALTER TABLE agent_conversations ADD CONSTRAINT agent_conversations_status_check
    CHECK (status IN ('active', 'inactive', 'archived'));

INSERT INTO schema_migrations (version) VALUES ('049_inactive_conversations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
