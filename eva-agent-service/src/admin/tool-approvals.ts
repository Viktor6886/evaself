import { TOOL_RISKS, type ToolRisk } from "../tools/approvals.js";

export interface ToolInventoryDatabase {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

const STATUS = {
  implemented: true,
  detail: "Durable tenant-scoped approvals активны; данные читаются из канонических таблиц.",
};

export class ToolApprovalService {
  constructor(private readonly db: ToolInventoryDatabase) {}

  async tools(days = 7): Promise<Record<string, unknown>> {
    const window = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
    const { rows: observed } = await this.db.query(
        `-- tenant: system — aggregate admin inventory
         SELECT tool_name, count(*) AS calls,
                count(*) FILTER (WHERE status = 'failed') AS failed,
                count(*) FILTER (WHERE status = 'running') AS running,
                max(created_at) AS last_call_at
           FROM tool_effects WHERE created_at > now() - make_interval(days => $1::int)
          GROUP BY tool_name ORDER BY calls DESC, tool_name LIMIT 200`, [window]);
    return { status: STATUS, window_days: window, observed_tools: observed };
  }

  async approvals(limit = 50): Promise<Record<string, unknown>> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const [pending, resolved, rules] = await Promise.all([
      this.db.query(`-- tenant: system — cross-user approval queue
        SELECT user_id, sdk_request_id, tool_name, risk, status, action_description, session_id, expires_at, created_at
          FROM tool_approvals WHERE status = 'pending' ORDER BY created_at LIMIT $1`, [bounded]),
      this.db.query(`-- tenant: system — cross-user resolved approvals
        SELECT user_id, sdk_request_id, tool_name, risk, status, decision, session_id, decided_at, created_at
          FROM tool_approvals WHERE status <> 'pending' ORDER BY decided_at DESC NULLS LAST LIMIT $1`, [bounded]),
      this.db.query(`-- tenant: system — cross-user active approval rules
        SELECT id, user_id, tool_name, decision, scope, session_id, max_risk, expires_at,
               actor_type, actor_id, actor_metadata, created_at
          FROM tool_approval_rules WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at DESC LIMIT $1`, [bounded]),
    ]);
    return { status: STATUS, pending: pending.rows, resolved: resolved.rows, standing_rules: rules.rows };
  }

  async createRule(input: { userId: number; toolName: string; decision: "allow" | "deny";
    scope: "standing" | "session"; sessionId?: string | null; maxRisk: ToolRisk;
    expiresAt?: string | null; actorId: string; actorMetadata?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.requireToolName(input.toolName);
    if (!TOOL_RISKS.includes(input.maxRisk)) throw new Error("Invalid max risk");
    if (input.scope === "session" && !input.sessionId) throw new Error("Session rule requires session_id");
    if (input.scope === "standing" && input.sessionId) throw new Error("Standing rule cannot have session_id");
    const { rows } = await this.db.query(
      `INSERT INTO tool_approval_rules (user_id, tool_name, decision, scope, session_id, max_risk, expires_at, actor_type, actor_id, actor_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'admin',$8,$9::jsonb)
       RETURNING id, user_id, tool_name, decision, scope, session_id, max_risk, expires_at, actor_type, actor_id, actor_metadata, created_at`,
      [input.userId, input.toolName, input.decision, input.scope, input.sessionId ?? null, input.maxRisk,
        input.expiresAt ?? null, input.actorId, JSON.stringify(input.actorMetadata ?? {})]);
    return rows[0]!;
  }

  async revokeRule(id: number, actorId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query(
      `-- tenant: system — audited cross-user rule revocation
       UPDATE tool_approval_rules SET revoked_at = now(), actor_metadata = actor_metadata || jsonb_build_object('revoked_by', $2::text)
        WHERE id = $1 AND revoked_at IS NULL RETURNING id, user_id, tool_name, revoked_at`, [id, actorId]);
    if (!rows[0]) throw new Error("Active approval rule not found");
    return rows[0];
  }

  /**
   * Правило подтверждения адресует ровно один инструмент. Набор
   * инструментов сессии определяет Letta, поэтому сверять имя не с чем —
   * но правило по маске выдало бы разрешение и тому, кого админ не видел.
   */
  private requireToolName(toolName: string): void {
    if (!toolName.trim() || toolName.includes("*")) throw new Error("Invalid tool name");
  }
}
