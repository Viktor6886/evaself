-- =====================================================================
-- Move from the Letta REST server to the Letta App Server + Agent SDK.
-- ---------------------------------------------------------------------
-- The mapping the whole architecture now depends on is
--
--     users.id  ->  agent_links.agent_id  ->  agent_links.conversation_id
--
-- `conversation_id` is what the Agent SDK resumes; without it a restart
-- would start a brand new conversation and the person would meet a
-- stranger. It is therefore stored, backed up and restored.
--
-- Idempotent, like every migration here.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. conversation and runtime columns
-- ---------------------------------------------------------------------
ALTER TABLE agent_links
    ADD COLUMN IF NOT EXISTS conversation_id text,
    -- 'letta-app-server' for agents created through the Agent SDK;
    -- 'letta-rest' marks anything left over from v0.1.0.
    ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'letta-app-server',
    ADD COLUMN IF NOT EXISTS app_server_url text;

-- Agents created before this migration came from the old REST server and
-- cannot be resumed by the SDK; mark them so the difference is visible.
UPDATE agent_links
   SET runtime = 'letta-rest'
 WHERE conversation_id IS NULL
   AND created_at < now()
   AND runtime = 'letta-app-server'
   AND agent_id LIKE 'agent-%'
   AND EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001_init')
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '003_agent_sdk');

CREATE INDEX IF NOT EXISTS agent_links_conversation_idx
    ON agent_links (conversation_id) WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_links_runtime_idx ON agent_links (runtime);

ALTER TABLE agent_links
    DROP CONSTRAINT IF EXISTS agent_links_runtime_check;
ALTER TABLE agent_links
    ADD CONSTRAINT agent_links_runtime_check
        CHECK (runtime IN ('letta-app-server', 'letta-rest'));

-- ---------------------------------------------------------------------
-- 2. conversation history, so "start over" does not lose the old thread
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_conversations (
    id              bigserial PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    agent_id        text        NOT NULL,
    conversation_id text        NOT NULL,
    title           text,
    status          text        NOT NULL DEFAULT 'active',
    message_count   bigint      NOT NULL DEFAULT 0,
    started_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz,
    archived_at     timestamptz,
    meta            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_conversations_status_check
        CHECK (status IN ('active', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_conversations_uidx
    ON agent_conversations (conversation_id);
CREATE INDEX IF NOT EXISTS agent_conversations_agent_idx
    ON agent_conversations (agent_id, started_at DESC);

DROP TRIGGER IF EXISTS trg_agent_conversations_updated_at ON agent_conversations;
CREATE TRIGGER trg_agent_conversations_updated_at
    BEFORE UPDATE ON agent_conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 3. the overview view gains the conversation
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE cannot insert a column in the middle of an existing
-- view's column list, so the view is dropped and rebuilt. Nothing depends
-- on it except NocoDB, which re-reads the schema.
DROP VIEW IF EXISTS v_user_overview;
CREATE VIEW v_user_overview AS
SELECT
    u.id,
    u.telegram_id,
    u.username,
    u.first_name,
    u.state,
    u.is_blocked,
    u.language_code,
    u.timezone,
    COALESCE(s.plan, 'free')            AS plan,
    COALESCE(s.status, 'none')          AS subscription_status,
    s.current_period_end,
    a.agent_id                          AS letta_agent_id,
    a.conversation_id                   AS letta_conversation_id,
    a.runtime                           AS agent_runtime,
    a.message_count,
    a.last_message_at,
    u.created_at,
    u.last_seen_at
FROM users u
LEFT JOIN LATERAL (
    SELECT * FROM subscriptions
    WHERE user_id = u.id AND status IN ('trialing', 'active', 'past_due')
    ORDER BY created_at DESC LIMIT 1
) s ON true
LEFT JOIN LATERAL (
    SELECT * FROM agent_links
    WHERE user_id = u.id AND kind = 'eva' AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
) a ON true;

-- ---------------------------------------------------------------------
-- 4. what an operator wants to see about the agent runtime
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_agent_runtime AS
SELECT
    u.telegram_id,
    u.username,
    a.agent_id,
    a.conversation_id,
    a.runtime,
    a.model,
    a.status,
    a.message_count,
    a.last_message_at,
    (a.conversation_id IS NULL) AS needs_conversation
FROM agent_links a
JOIN users u ON u.id = a.user_id
WHERE a.status = 'active'
ORDER BY a.last_message_at DESC NULLS LAST;

INSERT INTO schema_migrations (version) VALUES ('003_agent_sdk')
ON CONFLICT (version) DO NOTHING;

COMMIT;
