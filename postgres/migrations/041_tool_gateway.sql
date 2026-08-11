BEGIN;

-- Durable, tenant-scoped SDK approvals and Tool Gateway policy state.
CREATE TABLE IF NOT EXISTS tool_approvals (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id text REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
  sdk_request_id text NOT NULL,
  tool_name text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('read','low_risk_write','sensitive_write','external_side_effect','destructive')),
  argument_fingerprint text NOT NULL CHECK (argument_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','approved_once','approved_session','denied','expired','cancelled','executed','failed')),
  decision text CHECK (decision IN ('allow','deny')),
  action_description text NOT NULL,
  affected_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_id text,
  expires_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sdk_request_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_pending ON tool_approvals (user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tool_approvals_recovery ON tool_approvals (conversation_id) WHERE status IN ('pending','approved_once','approved_session','denied');
CREATE INDEX IF NOT EXISTS idx_tool_approvals_execution_match ON tool_approvals (user_id, conversation_id, tool_name, argument_fingerprint, created_at, sdk_request_id) WHERE status IN ('approved_once','approved_session');
CREATE INDEX IF NOT EXISTS idx_tool_approvals_expiry ON tool_approvals (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;

ALTER TABLE agent_conversations
  ADD COLUMN IF NOT EXISTS current_task_tools text[] NULL,
  ADD COLUMN IF NOT EXISTS selected_skill_tools text[] NULL;

CREATE TABLE IF NOT EXISTS tool_approval_rules (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) > 0 AND position('*' in tool_name) = 0),
  decision text NOT NULL CHECK (decision IN ('allow','deny')),
  scope text NOT NULL CHECK (scope IN ('standing','session')),
  session_id text,
  max_risk text NOT NULL CHECK (max_risk IN ('read','low_risk_write','sensitive_write','external_side_effect','destructive')),
  expires_at timestamptz,
  revoked_at timestamptz,
  actor_type text NOT NULL CHECK (actor_type IN ('user','admin','system')),
  actor_id text NOT NULL,
  actor_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'session' AND session_id IS NOT NULL) OR (scope = 'standing' AND session_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_tool_approval_rules_active ON tool_approval_rules (user_id, tool_name, scope, session_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS tool_gateway_state (
  tool_name text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  breaker_state text NOT NULL DEFAULT 'closed' CHECK (breaker_state IN ('closed','open','half_open')),
  consecutive_errors integer NOT NULL DEFAULT 0,
  opened_at timestamptz,
  probe_after timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_gateway_leases (
  owner_id uuid PRIMARY KEY,
  tool_name text NOT NULL REFERENCES tool_gateway_state(tool_name) ON DELETE CASCADE,
  generation bigint NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (expires_at > acquired_at),
  CHECK (released_at IS NULL OR released_at >= acquired_at)
);
CREATE INDEX IF NOT EXISTS idx_tool_gateway_leases_live ON tool_gateway_leases (tool_name, expires_at) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_server_policies (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  url text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('http','sse')),
  allowed_tools text[] NOT NULL CHECK (cardinality(allowed_tools) > 0 AND NOT ('*' = ANY(allowed_tools))),
  secret_record_ids text[] NOT NULL CHECK (cardinality(secret_record_ids) > 0),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 30000),
  max_result_bytes integer NOT NULL CHECK (max_result_bytes BETWEEN 1 AND 4194304),
  created_by uuid NOT NULL REFERENCES admin_users(id),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tool_gateway_probe ON tool_gateway_state (probe_after) WHERE enabled AND breaker_state = 'open';
CREATE INDEX IF NOT EXISTS idx_mcp_server_policies_enabled ON mcp_server_policies (id) WHERE enabled;

DROP TRIGGER IF EXISTS trg_tool_approvals_updated_at ON tool_approvals;
CREATE TRIGGER trg_tool_approvals_updated_at BEFORE UPDATE ON tool_approvals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_tool_gateway_state_updated_at ON tool_gateway_state;
CREATE TRIGGER trg_tool_gateway_state_updated_at BEFORE UPDATE ON tool_gateway_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_tool_approval_rules_updated_at ON tool_approval_rules;
CREATE TRIGGER trg_tool_approval_rules_updated_at BEFORE UPDATE ON tool_approval_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_mcp_server_policies_updated_at ON mcp_server_policies;
CREATE TRIGGER trg_mcp_server_policies_updated_at BEFORE UPDATE ON mcp_server_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('041_tool_gateway') ON CONFLICT (version) DO NOTHING;
COMMIT;
