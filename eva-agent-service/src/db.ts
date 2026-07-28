/**
 * PostgreSQL access.
 *
 * The mapping this service owns is the one the whole architecture depends on:
 *
 *     user_id  ->  agent_id  ->  conversation_id
 *
 * It lives in `agent_links` (see postgres/migrations/003_agent_sdk.sql) so
 * that a restart, a restore, or a migration to another VPS all pick the same
 * agent and the same conversation back up.
 */

import pg from "pg";
import { databaseUnavailable } from "./errors.js";

export interface UserRow {
  id: number;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string;
  state: string;
  is_blocked: boolean;
  created_at: Date;
  last_seen_at: Date | null;
}

export interface AgentLinkRow {
  id: number;
  user_id: number;
  kind: string;
  agent_id: string;
  conversation_id: string | null;
  agent_name: string | null;
  model: string | null;
  runtime: string;
  status: string;
  message_count: string;
  last_message_at: Date | null;
}

export class Database {
  private pool: pg.Pool | null = null;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  async connect(): Promise<void> {
    if (!this.connectionString) throw databaseUnavailable("DATABASE_URL is empty");
    this.pool = new pg.Pool({
      connectionString: this.connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private require(): pg.Pool {
    if (!this.pool) throw databaseUnavailable("the service has no database connection");
    return this.pool;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.require().query("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    } catch (error) {
      throw databaseUnavailable(
        `database ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // -----------------------------------------------------------------
  // users
  // -----------------------------------------------------------------

  async upsertUser(input: {
    telegramId: number;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    languageCode?: string | null;
  }): Promise<UserRow> {
    const { rows } = await this.require().query<UserRow>(
      `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, last_seen_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'ru'), now())
       ON CONFLICT (telegram_id) DO UPDATE SET
         username      = COALESCE(EXCLUDED.username, users.username),
         first_name    = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name     = COALESCE(EXCLUDED.last_name, users.last_name),
         language_code = COALESCE(EXCLUDED.language_code, users.language_code),
         last_seen_at  = now()
       RETURNING *`,
      [
        input.telegramId,
        input.username ?? null,
        input.firstName ?? null,
        input.lastName ?? null,
        input.languageCode ?? null,
      ],
    );
    return rows[0]!;
  }

  async getUserOverview(telegramId: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.require().query(
      "SELECT * FROM v_user_overview WHERE telegram_id = $1",
      [telegramId],
    );
    return rows[0] ?? null;
  }

  // -----------------------------------------------------------------
  // user -> agent -> conversation
  // -----------------------------------------------------------------

  async getAgentLink(telegramId: number, kind = "eva"): Promise<AgentLinkRow | null> {
    const { rows } = await this.require().query<AgentLinkRow>(
      `SELECT a.* FROM agent_links a
        JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1 AND a.kind = $2 AND a.status = 'active'
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [telegramId, kind],
    );
    return rows[0] ?? null;
  }

  async saveAgentLink(input: {
    userId: number;
    agentId: string;
    conversationId: string | null;
    agentName: string | null;
    model: string | null;
    kind?: string;
  }): Promise<AgentLinkRow> {
    const { rows } = await this.require().query<AgentLinkRow>(
      `INSERT INTO agent_links
         (user_id, kind, agent_id, conversation_id, agent_name, model, runtime)
       VALUES ($1, $2, $3, $4, $5, $6, 'letta-app-server')
       ON CONFLICT (agent_id) DO UPDATE SET
         conversation_id = COALESCE(EXCLUDED.conversation_id, agent_links.conversation_id),
         agent_name      = EXCLUDED.agent_name,
         model           = EXCLUDED.model,
         runtime         = 'letta-app-server',
         status          = 'active'
       RETURNING *`,
      [
        input.userId,
        input.kind ?? "eva",
        input.agentId,
        input.conversationId,
        input.agentName,
        input.model,
      ],
    );
    return rows[0]!;
  }

  /** Point a user's link at a different conversation (e.g. "start over"). */
  async setConversation(agentId: string, conversationId: string): Promise<void> {
    await this.require().query(
      "UPDATE agent_links SET conversation_id = $2 WHERE agent_id = $1",
      [agentId, conversationId],
    );
  }

  async markAgentUsed(agentId: string): Promise<void> {
    await this.require().query(
      `UPDATE agent_links
          SET last_message_at = now(), message_count = message_count + 1
        WHERE agent_id = $1`,
      [agentId],
    );
  }

  async listAgentLinks(limit = 500): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.require().query(
      `SELECT u.telegram_id, a.agent_id, a.conversation_id, a.kind, a.runtime,
              a.status, a.message_count, a.last_message_at
         FROM agent_links a JOIN users u ON u.id = a.user_id
        WHERE a.status = 'active'
        ORDER BY a.created_at
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  // -----------------------------------------------------------------
  // usage & quotas
  // -----------------------------------------------------------------

  private static periodStart(period: string): string {
    const now = new Date();
    if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    if (period === "week") {
      const day = (now.getUTCDay() + 6) % 7;
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() - day);
      return monday.toISOString().slice(0, 10);
    }
    if (period === "total") return "1970-01-01";
    return now.toISOString().slice(0, 10);
  }

  async incrementUsage(telegramId: number, metric: string, amount = 1, period = "day"): Promise<number> {
    const { rows } = await this.require().query<{ used: string }>(
      `INSERT INTO usage_counters (user_id, metric, period, period_start, used)
       SELECT id, $2, $3, $4, $5 FROM users WHERE telegram_id = $1
       ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
         SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
       RETURNING used`,
      [telegramId, metric, period, Database.periodStart(period), amount],
    );
    return Number(rows[0]?.used ?? 0);
  }

  async getQuotaStatus(telegramId: number): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.require().query(
      `SELECT metric, period, limit_value, used, remaining
         FROM v_quota_status WHERE telegram_id = $1`,
      [telegramId],
    );
    return rows;
  }

  async stats(): Promise<Record<string, unknown>> {
    const { rows } = await this.require().query(
      `SELECT
         (SELECT count(*) FROM users)                                    AS users,
         (SELECT count(*) FROM agent_links WHERE status = 'active')      AS agents,
         (SELECT count(*) FROM agent_links
           WHERE status = 'active' AND conversation_id IS NOT NULL)      AS conversations,
         (SELECT count(*) FROM crisis_events WHERE handled = false)      AS open_crisis_events`,
    );
    return rows[0] ?? {};
  }
}
