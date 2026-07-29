-- =====================================================================
-- Разделение пользовательского чата и служебных conversations по purpose
-- =====================================================================

BEGIN;

ALTER TABLE agent_conversations
    ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'chat',
    ADD COLUMN IF NOT EXISTS parent_conversation_id text,
    ADD COLUMN IF NOT EXISTS last_handoff_at timestamptz;

UPDATE agent_conversations
   SET purpose = 'chat'
 WHERE purpose IS NULL
    OR purpose NOT IN (
        'chat', 'scheduler', 'maintenance', 'profile',
        'goal_review', 'partner_analysis', 'research'
    );

ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_purpose_check;
ALTER TABLE agent_conversations
    ADD CONSTRAINT agent_conversations_purpose_check CHECK (purpose IN (
        'chat', 'scheduler', 'maintenance', 'profile',
        'goal_review', 'partner_analysis', 'research'
    ));

ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_parent_fk;
ALTER TABLE agent_conversations
    ADD CONSTRAINT agent_conversations_parent_fk
        FOREIGN KEY (parent_conversation_id)
        REFERENCES agent_conversations (conversation_id)
        ON DELETE SET NULL;

-- Старые версии могли оставить больше одной active conversation. Сохраняем
-- историю и архивируем только дубликаты одного purpose перед unique index.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY agent_id, purpose
               ORDER BY updated_at DESC, id DESC
           ) AS position
      FROM agent_conversations
     WHERE status = 'active'
)
UPDATE agent_conversations c
   SET status = 'archived',
       archived_at = COALESCE(archived_at, now())
  FROM ranked r
 WHERE c.id = r.id
   AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS agent_conversations_active_purpose_uidx
    ON agent_conversations (agent_id, purpose)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_conversations_user_purpose_idx
    ON agent_conversations (user_id, purpose, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_conversations_parent_idx
    ON agent_conversations (parent_conversation_id)
    WHERE parent_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_highlights (
    id                    bigserial PRIMARY KEY,
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    conversation_id       text NOT NULL
                          REFERENCES agent_conversations (conversation_id)
                          ON DELETE CASCADE,
    source_message_id     text,
    highlight_type        text NOT NULL DEFAULT 'event',
    title                 text NOT NULL,
    content               text NOT NULL,
    source_quote          text,
    importance            numeric(4,3) NOT NULL DEFAULT 0.5,
    status                text NOT NULL DEFAULT 'active',
    occurred_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversation_highlights_type_check CHECK (highlight_type IN (
        'event', 'decision', 'commitment', 'insight', 'artifact', 'source'
    )),
    CONSTRAINT conversation_highlights_importance_check
        CHECK (importance >= 0 AND importance <= 1),
    CONSTRAINT conversation_highlights_status_check
        CHECK (status IN ('active', 'superseded', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_highlights_source_uidx
    ON conversation_highlights (conversation_id, source_message_id, highlight_type)
    WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_highlights_user_idx
    ON conversation_highlights (user_id, status, importance DESC, created_at DESC);

DROP TRIGGER IF EXISTS trg_conversation_highlights_updated_at ON conversation_highlights;
CREATE TRIGGER trg_conversation_highlights_updated_at
    BEFORE UPDATE ON conversation_highlights
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('013_conversation_purposes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
