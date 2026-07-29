-- =====================================================================
-- Графовая память PostgreSQL: FTS + trigram + связи
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS memory_nodes (
    id                bigserial PRIMARY KEY,
    user_id           bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_type         text NOT NULL,
    canonical_key     text NOT NULL,
    title             text NOT NULL,
    text_content      text,
    content_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status            text NOT NULL DEFAULT 'active',
    confidence        numeric(4,3) NOT NULL DEFAULT 1,
    sensitivity       text NOT NULL DEFAULT 'normal',
    source_type       text NOT NULL,
    source_id         text,
    source_quote      text,
    valid_from        timestamptz,
    valid_to          timestamptz,
    last_accessed_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_nodes_type_check CHECK (node_type IN (
        'profile_fact', 'interest', 'value', 'anti_goal', 'goal',
        'goal_result', 'task', 'person', 'relationship', 'event',
        'obstacle', 'strategy', 'psychological_feature', 'artifact',
        'review', 'decision'
    )),
    CONSTRAINT memory_nodes_status_check CHECK (status IN (
        'active', 'unconfirmed', 'disputed', 'superseded', 'archived'
    )),
    CONSTRAINT memory_nodes_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT memory_nodes_sensitivity_check
        CHECK (sensitivity IN ('normal', 'sensitive', 'high'))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_user_canonical_uidx
    ON memory_nodes (user_id, node_type, canonical_key);
CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_user_id_uidx
    ON memory_nodes (user_id, id);
CREATE INDEX IF NOT EXISTS memory_nodes_user_type_status_idx
    ON memory_nodes (user_id, node_type, status);
CREATE INDEX IF NOT EXISTS memory_nodes_user_canonical_idx
    ON memory_nodes (user_id, canonical_key);
CREATE INDEX IF NOT EXISTS memory_nodes_content_json_gin_idx
    ON memory_nodes USING gin (content_json jsonb_path_ops);
CREATE INDEX IF NOT EXISTS memory_nodes_text_fts_idx
    ON memory_nodes USING gin (
        to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(text_content, ''))
    );
CREATE INDEX IF NOT EXISTS memory_nodes_text_trgm_idx
    ON memory_nodes USING gin (
        (COALESCE(title, '') || ' ' || COALESCE(text_content, '')) gin_trgm_ops
    );

CREATE TABLE IF NOT EXISTS memory_edges (
    id                bigserial PRIMARY KEY,
    user_id           bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    from_node_id      bigint NOT NULL,
    relation_type     text NOT NULL,
    to_node_id        bigint NOT NULL,
    weight            numeric(8,4) NOT NULL DEFAULT 1,
    confidence        numeric(4,3) NOT NULL DEFAULT 1,
    status            text NOT NULL DEFAULT 'active',
    source_type       text NOT NULL,
    source_id         text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_edges_from_fk
        FOREIGN KEY (user_id, from_node_id)
        REFERENCES memory_nodes (user_id, id) ON DELETE CASCADE,
    CONSTRAINT memory_edges_to_fk
        FOREIGN KEY (user_id, to_node_id)
        REFERENCES memory_nodes (user_id, id) ON DELETE CASCADE,
    CONSTRAINT memory_edges_relation_check CHECK (relation_type IN (
        'belongs_to', 'aligned_with', 'constrained_by', 'part_of',
        'depends_on', 'advances', 'blocks', 'helps_with', 'effective_for',
        'uses', 'produced_by', 'evaluates', 'involves', 'supports'
    )),
    CONSTRAINT memory_edges_weight_check CHECK (weight >= 0 AND weight <= 100),
    CONSTRAINT memory_edges_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT memory_edges_status_check
        CHECK (status IN ('active', 'disputed', 'archived')),
    CONSTRAINT memory_edges_not_self_check CHECK (from_node_id <> to_node_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_edges_relation_uidx
    ON memory_edges (user_id, from_node_id, relation_type, to_node_id);
CREATE INDEX IF NOT EXISTS memory_edges_from_idx
    ON memory_edges (user_id, from_node_id, status);
CREATE INDEX IF NOT EXISTS memory_edges_to_idx
    ON memory_edges (user_id, to_node_id, status);
CREATE INDEX IF NOT EXISTS memory_edges_relation_idx
    ON memory_edges (user_id, relation_type);

DROP TRIGGER IF EXISTS trg_memory_nodes_updated_at ON memory_nodes;
CREATE TRIGGER trg_memory_nodes_updated_at
    BEFORE UPDATE ON memory_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_memory_edges_updated_at ON memory_edges;
CREATE TRIGGER trg_memory_edges_updated_at
    BEFORE UPDATE ON memory_edges
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('012_graph_memory')
ON CONFLICT (version) DO NOTHING;

COMMIT;
