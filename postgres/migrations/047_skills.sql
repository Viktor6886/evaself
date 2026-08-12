BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_artifact_checksum_uidx ON artifact_versions(artifact_id,checksum);

-- Canonical searchable projection of ArtifactRegistry versions. System rows have no owner;
-- declarative tenant skills carry owner_user_id and cannot cross the SQL tenant predicate.
CREATE TABLE IF NOT EXISTS skill_search_index (
  version_id bigint PRIMARY KEY REFERENCES artifact_versions(id) ON DELETE CASCADE,
  slug text NOT NULL, environment text NOT NULL,
  owner_user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN ('core','routable')),
  role text NOT NULL CHECK(role IN ('primary','auxiliary')),
  status text NOT NULL CHECK(status IN ('active','disabled','error')),
  checksum text NOT NULL, body jsonb NOT NULL,
  search_text text NOT NULL, search_document tsvector NOT NULL,
  embedding vector(1536), version integer NOT NULL,
  error_code text, indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_search_fts_idx ON skill_search_index USING gin(search_document);
CREATE INDEX IF NOT EXISTS skill_search_trgm_idx ON skill_search_index USING gin(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS skill_search_vector_idx ON skill_search_index USING hnsw(embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS skill_search_owner_idx ON skill_search_index(owner_user_id,category,status);
ALTER TABLE skill_search_index ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_search_tenant ON skill_search_index;
CREATE POLICY skill_search_tenant ON skill_search_index USING(owner_user_id IS NULL OR owner_user_id=NULLIF(current_setting('app.user_id', true),'')::bigint) WITH CHECK(owner_user_id IS NULL OR owner_user_id=NULLIF(current_setting('app.user_id', true),'')::bigint);

CREATE TABLE IF NOT EXISTS skill_routing_state (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
  skill_version_id bigint NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  topic_fingerprint text NOT NULL, scenario_state text NOT NULL DEFAULT 'active' CHECK(scenario_state IN ('active','completed')),
  turns integer NOT NULL DEFAULT 1 CHECK(turns>0), expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,conversation_id)
);
CREATE INDEX IF NOT EXISTS skill_routing_state_user_idx ON skill_routing_state(user_id,expires_at);
ALTER TABLE skill_routing_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_routing_state_tenant ON skill_routing_state;
CREATE POLICY skill_routing_state_tenant ON skill_routing_state USING(user_id=NULLIF(current_setting('app.user_id', true),'')::bigint) WITH CHECK(user_id=NULLIF(current_setting('app.user_id', true),'')::bigint);

CREATE TABLE IF NOT EXISTS skill_routing_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id text NOT NULL REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
 selected jsonb NOT NULL DEFAULT '[]',reason_code text NOT NULL,sticky boolean NOT NULL DEFAULT false,
 fallback boolean NOT NULL DEFAULT false,reranker_called boolean NOT NULL DEFAULT false,
 latency_ms numeric NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_routing_events_user_created_idx ON skill_routing_events(user_id,created_at DESC);
ALTER TABLE skill_routing_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_routing_events_tenant ON skill_routing_events;
CREATE POLICY skill_routing_events_tenant ON skill_routing_events USING(user_id=NULLIF(current_setting('app.user_id', true),'')::bigint) WITH CHECK(user_id=NULLIF(current_setting('app.user_id', true),'')::bigint);

-- Contract marker: production hybrid query is tenant scoped and always bounded.
COMMENT ON TABLE skill_search_index IS 'Hybrid FTS+pg_trgm+pgvector query ORDER BY score DESC LIMIT 10';
INSERT INTO schema_migrations(version) VALUES('047_skills') ON CONFLICT(version) DO NOTHING;
COMMIT;
