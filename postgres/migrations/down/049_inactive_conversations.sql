BEGIN;

UPDATE agent_conversations
   SET status = 'archived', archived_at = COALESCE(archived_at, now())
 WHERE status = 'inactive';
ALTER TABLE agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_status_check;
ALTER TABLE agent_conversations ADD CONSTRAINT agent_conversations_status_check
    CHECK (status IN ('active', 'archived'));
DELETE FROM schema_migrations WHERE version = '049_inactive_conversations';

COMMIT;
