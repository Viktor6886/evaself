BEGIN;

DROP TABLE IF EXISTS mcp_server_policies;
DROP TABLE IF EXISTS tool_gateway_leases;
DROP TABLE IF EXISTS tool_gateway_state;
DROP TABLE IF EXISTS tool_approval_rules;
DROP TABLE IF EXISTS tool_approvals;
ALTER TABLE agent_conversations
  DROP COLUMN IF EXISTS selected_skill_tools,
  DROP COLUMN IF EXISTS current_task_tools;
DELETE FROM schema_migrations WHERE version = '041_tool_gateway';

COMMIT;
