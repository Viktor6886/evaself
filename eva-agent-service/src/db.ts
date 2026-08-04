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
import { AsyncLocalStorage } from "node:async_hooks";
import { databaseUnavailable } from "./errors.js";

export interface UserRow {
  id: number;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string;
  language_mode: "auto" | "fixed";
  preferred_language: string | null;
  last_message_language: string | null;
  timezone: string;
  city: string | null;
  country_code: string | null;
  timezone_source: string | null;
  timezone_confidence: string | null;
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

export interface LlmProviderRow {
  id: string;
  name: string;
  protocol: "openai-compatible";
  base_url: string;
  model: string;
  context_window: number;
  additional_parameters: Record<string, unknown>;
  api_key_encrypted: string;
  is_active: boolean;
  last_checked_at: Date | null;
  last_check_ok: boolean | null;
  last_check_message: string | null;
  last_models: unknown[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface ModelMapping {
  agentId: string;
  conversationIds: string[];
}

export interface SdkSettingsRow {
  id: number;
  agent_name_prefix: string;
  default_description: string;
  default_persona: string;
  default_human_template: string;
  default_tags: string[];
  permission_mode: "standard" | "acceptEdits" | "unrestricted" | "strict";
  reasoning_effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  memfs_enabled: boolean;
  system_prompt: string | null;
  base_tools: string[] | null;
  allowed_tools: string[] | null;
  disallowed_tools: string[];
  skill_sources: Array<"bundled" | "global" | "agent" | "project">;
  system_info_reminder: boolean;
  dreaming: Record<string, unknown>;
  model_settings: Record<string, unknown>;
  default_context_window: number | null;
  conversation_summary: string;
  conversation_description: string;
  conversation_hidden: boolean;
  create_conversation: boolean;
  session_pool_size: number;
  session_idle_ms: number;
  turn_timeout_ms: number;
  app_server_request_timeout_ms: number;
  created_at: Date;
  updated_at: Date;
}

export interface AgentRuntimeContext {
  userId: number;
  telegramId: number;
  chatId: number;
  conversationId: string;
  purpose:
    | "chat"
    | "scheduler"
    | "maintenance"
    | "profile"
    | "goal_review"
    | "partner_analysis"
    | "research";
  timezone: string;
  responseMode: "text" | "voice" | "both";
  useEmoji: boolean;
}

export interface AdminAuditInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  status?: "success" | "failed" | "rolled_back";
  before?: unknown;
  after?: unknown;
  details?: Record<string, unknown>;
}

export interface SttUsageAttempt {
  configId: string | null;
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  isFallback: boolean;
  errorCode: string | null;
}

export class Database {
  private pool: pg.Pool | null = null;
  private poolView: pg.Pool | null = null;
  private readonly connectionString: string;
  private readonly queryMetrics = new AsyncLocalStorage<{ count: number }>();

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
    this.poolView = this.instrumentPool(this.pool);
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
    this.poolView = null;
  }

  private require(): pg.Pool {
    if (!this.poolView) throw databaseUnavailable("the service has no database connection");
    return this.poolView;
  }

  async withQueryMetrics<T>(
    work: () => Promise<T>,
  ): Promise<{ result: T; queryCount: number }> {
    const counter = { count: 0 };
    const result = await this.queryMetrics.run(counter, work);
    return { result, queryCount: counter.count };
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

  async setUserState(userId: number, state: "onboarding" | "active" | "paused"): Promise<void> {
    await this.require().query(
      "UPDATE users SET state = $2, consent_at = COALESCE(consent_at, now()) WHERE id = $1",
      [userId, state],
    );
  }

  async attachTelegramUpdateToUser(updateId: number, userId: number): Promise<void> {
    await this.require().query(
      "UPDATE telegram_updates SET user_id = $2 WHERE update_id = $1",
      [updateId, userId],
    );
  }

  async recordUserMessage(userId: number): Promise<void> {
    await this.require().query(
      `INSERT INTO heartbeat_state (user_id, last_user_message_at)
       VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_user_message_at = now()`,
      [userId],
    );
  }

  async getUserOverview(telegramId: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.require().query(
      "SELECT * FROM v_user_overview WHERE telegram_id = $1",
      [telegramId],
    );
    return rows[0] ?? null;
  }

  async getAgentRuntimeContext(conversationId: string): Promise<AgentRuntimeContext | null> {
    const { rows } = await this.require().query<{
      user_id: string;
      telegram_id: string;
      chat_id: string | null;
      conversation_id: string;
      purpose: AgentRuntimeContext["purpose"];
      timezone: string;
      response_mode: "text" | "voice" | "both";
      use_emoji: boolean;
    }>(
      `SELECT u.id AS user_id,
              u.telegram_id,
              COALESCE(t.chat_id, u.telegram_id) AS chat_id,
              c.conversation_id,
              c.purpose,
              u.timezone,
              COALESCE(p.response_mode, 'text') AS response_mode,
              COALESCE(p.use_emoji, true) AS use_emoji
         FROM agent_conversations c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN user_preferences p ON p.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT chat_id FROM telegram_updates
            WHERE user_id = u.id AND chat_id IS NOT NULL
            ORDER BY received_at DESC LIMIT 1
         ) t ON true
        WHERE c.conversation_id = $1
        LIMIT 1`,
      [conversationId],
    );
    const row = rows[0];
    return row
      ? {
          userId: Number(row.user_id),
          telegramId: Number(row.telegram_id),
          chatId: Number(row.chat_id ?? row.telegram_id),
          conversationId: row.conversation_id,
          purpose: row.purpose,
          timezone: row.timezone,
          responseMode: row.response_mode,
          useEmoji: row.use_emoji,
        }
      : null;
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
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<AgentLinkRow>(
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
      const row = rows[0]!;
      if (input.conversationId) {
        await client.query(
          `INSERT INTO agent_conversations (user_id, agent_id, conversation_id, purpose)
           VALUES ($1, $2, $3, 'chat')
           ON CONFLICT (conversation_id) DO UPDATE SET
             status = 'active', archived_at = NULL, purpose = 'chat'`,
          [input.userId, input.agentId, input.conversationId],
        );
      }
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Point a user's link at a different conversation (e.g. "start over"). */
  async setConversation(agentId: string, conversationId: string): Promise<void> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ user_id: string }>(
        `UPDATE agent_links SET conversation_id = $2
          WHERE agent_id = $1
        RETURNING user_id`,
        [agentId, conversationId],
      );
      if (rows[0]) {
        await client.query(
          `
            -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
            UPDATE agent_conversations
              SET status = 'archived', archived_at = now()
            WHERE agent_id = $1
              AND purpose = 'chat'
              AND status = 'active'
              AND conversation_id <> $2`,
          [agentId, conversationId],
        );
        await client.query(
          `INSERT INTO agent_conversations (user_id, agent_id, conversation_id, purpose)
           VALUES ($1, $2, $3, 'chat')
           ON CONFLICT (conversation_id) DO UPDATE SET
             status = 'active', archived_at = NULL, purpose = 'chat'`,
          [rows[0].user_id, agentId, conversationId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAgentUsed(agentId: string): Promise<void> {
    await this.require().query(
      `
        -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
        UPDATE agent_links
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

  async listModelMappings(): Promise<ModelMapping[]> {
    const { rows } = await this.require().query<{
      agent_id: string;
      conversation_ids: string[];
    }>(
      `
        -- tenant: system — инвентарь всех агентов для сверки с App Server, строк пользователей не отдаёт
        SELECT a.agent_id,
              array_remove(array_agg(DISTINCT c.conversation_id), NULL) AS conversation_ids
         FROM agent_links a
         LEFT JOIN agent_conversations c ON c.agent_id = a.agent_id
        WHERE a.status = 'active' AND a.runtime = 'letta-app-server'
        GROUP BY a.agent_id
        ORDER BY a.agent_id`,
    );
    return rows.map((row) => ({
      agentId: row.agent_id,
      conversationIds: row.conversation_ids ?? [],
    }));
  }

  async setAgentModels(model: string): Promise<void> {
    await this.require().query(
      `
        -- tenant: system — смена модели применяется ко всем активным агентам сразу
        UPDATE agent_links
          SET model = $1
        WHERE status = 'active' AND runtime = 'letta-app-server'`,
      [model],
    );
  }

  /** Archive a PostgreSQL mapping after its Letta agent was explicitly deleted. */
  async archiveAgentLink(agentId: string): Promise<void> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
          UPDATE agent_links
            SET status = 'archived', conversation_id = NULL
          WHERE agent_id = $1 AND status = 'active'`,
        [agentId],
      );
      await client.query(
        `
          -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
          UPDATE agent_conversations
            SET status = 'archived', archived_at = COALESCE(archived_at, now())
          WHERE agent_id = $1 AND status = 'active'`,
        [agentId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runtime modules share this bounded pool. SQL values must always be
   * supplied separately, never interpolated into a query string.
   */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    return await this.require().query<T>(text, values);
  }

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private instrumentPool(pool: pg.Pool): pg.Pool {
    return new Proxy(pool, {
      get: (target, property) => {
        if (property === "query") {
          return (...args: unknown[]) => {
            this.incrementQueryCount();
            return Reflect.apply(target.query, target, args);
          };
        }
        if (property === "connect") {
          return async () => this.instrumentClient(await target.connect());
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private instrumentClient(client: pg.PoolClient): pg.PoolClient {
    return new Proxy(client, {
      get: (target, property) => {
        if (property === "query") {
          return (...args: unknown[]) => {
            this.incrementQueryCount();
            return Reflect.apply(target.query, target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private incrementQueryCount(): void {
    const metrics = this.queryMetrics.getStore();
    if (metrics) metrics.count += 1;
  }

  // -----------------------------------------------------------------
  // protected administrative audit
  // -----------------------------------------------------------------

  async recordAdminAudit(input: AdminAuditInput): Promise<void> {
    await this.require().query(
      `INSERT INTO admin_audit_log
         (action, target_type, target_id, status, before_data, after_data, details)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        input.action.slice(0, 200),
        input.targetType.slice(0, 100),
        input.targetId?.slice(0, 300) ?? null,
        input.status ?? "success",
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        JSON.stringify(input.details ?? {}),
      ],
    );
  }

  async listAdminAudit(input: {
    limit?: number;
    targetType?: string;
    targetId?: string;
  } = {}): Promise<Array<Record<string, unknown>>> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const { rows } = await this.require().query(
      `SELECT id, actor, action, target_type, target_id, status,
              before_data, after_data, details, created_at
         FROM admin_audit_log
        WHERE ($2::text IS NULL OR target_type = $2)
          AND ($3::text IS NULL OR target_id = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit, input.targetType ?? null, input.targetId ?? null],
    );
    return rows;
  }

  // -----------------------------------------------------------------
  // Letta Agent SDK settings
  // -----------------------------------------------------------------

  async getSdkSettings(): Promise<SdkSettingsRow> {
    const { rows } = await this.require().query<SdkSettingsRow>(
      "SELECT * FROM sdk_settings WHERE id = 1",
    );
    if (!rows[0]) throw databaseUnavailable("sdk_settings row is missing");
    return rows[0];
  }

  async saveSdkSettings(input: SdkSettingsRow): Promise<SdkSettingsRow> {
    const { rows } = await this.require().query<SdkSettingsRow>(
      `UPDATE sdk_settings SET
         agent_name_prefix = $1,
         default_description = $2,
         default_persona = $3,
         default_human_template = $4,
         default_tags = $5,
         permission_mode = $6,
         reasoning_effort = $7,
         memfs_enabled = $8,
         system_prompt = $9,
         base_tools = $10,
         allowed_tools = $11,
         disallowed_tools = $12,
         skill_sources = $13,
         system_info_reminder = $14,
         dreaming = $15::jsonb,
         model_settings = $16::jsonb,
         default_context_window = $17,
         conversation_summary = $18,
         conversation_description = $19,
         conversation_hidden = $20,
         create_conversation = $21,
         session_pool_size = $22,
         session_idle_ms = $23,
         turn_timeout_ms = $24,
         app_server_request_timeout_ms = $25
       WHERE id = 1
       RETURNING *`,
      [
        input.agent_name_prefix,
        input.default_description,
        input.default_persona,
        input.default_human_template,
        input.default_tags,
        input.permission_mode,
        input.reasoning_effort,
        input.memfs_enabled,
        input.system_prompt,
        input.base_tools,
        input.allowed_tools,
        input.disallowed_tools,
        input.skill_sources,
        input.system_info_reminder,
        JSON.stringify(input.dreaming),
        JSON.stringify(input.model_settings),
        input.default_context_window,
        input.conversation_summary,
        input.conversation_description,
        input.conversation_hidden,
        input.create_conversation,
        input.session_pool_size,
        input.session_idle_ms,
        input.turn_timeout_ms,
        input.app_server_request_timeout_ms,
      ],
    );
    return rows[0]!;
  }

  // -----------------------------------------------------------------
  // LLM providers
  // -----------------------------------------------------------------

  async countLlmProviders(): Promise<number> {
    const { rows } = await this.require().query<{ count: string }>(
      "SELECT count(*) AS count FROM llm_providers",
    );
    return Number(rows[0]?.count ?? 0);
  }

  async listLlmProviders(): Promise<LlmProviderRow[]> {
    const { rows } = await this.require().query<LlmProviderRow>(
      `SELECT * FROM llm_providers
       ORDER BY is_active DESC, lower(name), created_at`,
    );
    return rows;
  }

  async getLlmProvider(id: string): Promise<LlmProviderRow | null> {
    const { rows } = await this.require().query<LlmProviderRow>(
      "SELECT * FROM llm_providers WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  }

  async getActiveLlmProvider(): Promise<LlmProviderRow | null> {
    const { rows } = await this.require().query<LlmProviderRow>(
      "SELECT * FROM llm_providers WHERE is_active = true LIMIT 1",
    );
    return rows[0] ?? null;
  }

  async createLlmProvider(input: {
    name: string;
    protocol: "openai-compatible";
    baseUrl: string;
    model: string;
    contextWindow: number;
    additionalParameters: Record<string, unknown>;
    apiKeyEncrypted: string;
  }): Promise<LlmProviderRow> {
    const { rows } = await this.require().query<LlmProviderRow>(
      `INSERT INTO llm_providers
         (name, protocol, base_url, model, context_window,
          additional_parameters, api_key_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        input.name,
        input.protocol,
        input.baseUrl,
        input.model,
        input.contextWindow,
        JSON.stringify(input.additionalParameters),
        input.apiKeyEncrypted,
      ],
    );
    return rows[0]!;
  }

  async updateLlmProvider(input: {
    id: string;
    name: string;
    protocol: "openai-compatible";
    baseUrl: string;
    model: string;
    contextWindow: number;
    additionalParameters: Record<string, unknown>;
    apiKeyEncrypted: string;
  }): Promise<LlmProviderRow | null> {
    const { rows } = await this.require().query<LlmProviderRow>(
      `UPDATE llm_providers SET
         name = $2,
         protocol = $3,
         base_url = $4,
         model = $5,
         context_window = $6,
         additional_parameters = $7::jsonb,
         api_key_encrypted = $8,
         last_checked_at = NULL,
         last_check_ok = NULL,
         last_check_message = NULL,
         last_models = NULL
       WHERE id = $1
       RETURNING *`,
      [
        input.id,
        input.name,
        input.protocol,
        input.baseUrl,
        input.model,
        input.contextWindow,
        JSON.stringify(input.additionalParameters),
        input.apiKeyEncrypted,
      ],
    );
    return rows[0] ?? null;
  }

  async recordLlmCheck(
    id: string,
    result: { ok: boolean; message: string; models: unknown[] | null },
  ): Promise<LlmProviderRow | null> {
    const { rows } = await this.require().query<LlmProviderRow>(
      `UPDATE llm_providers SET
         last_checked_at = now(),
         last_check_ok = $2,
         last_check_message = $3,
         last_models = $4::jsonb
       WHERE id = $1
       RETURNING *`,
      [id, result.ok, result.message, result.models === null ? null : JSON.stringify(result.models)],
    );
    return rows[0] ?? null;
  }

  /** Legacy Letta connector selection. Route chains remain independent. */
  async activateLlmProvider(id: string): Promise<LlmProviderRow | null> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE llm_providers SET is_active = false WHERE is_active");
      const { rows } = await client.query<LlmProviderRow>(
        "UPDATE llm_providers SET is_active = true WHERE id = $1 RETURNING *",
        [id],
      );
      await client.query("COMMIT");
      return rows[0] ?? null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteInactiveLlmProvider(id: string): Promise<boolean> {
    const result = await this.require().query(
      "DELETE FROM llm_providers WHERE id = $1 AND is_active = false",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
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

  async isLlmSingleProviderSelected(id: string): Promise<boolean> {
    const { rowCount } = await this.require().query(
      "SELECT 1 FROM llm_routing_settings WHERE singleton AND single_provider_id = $1",
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Persist the real STT path used by Telegram voice messages. */
  async recordSttUsage(input: {
    useCase: string;
    attempts: SttUsageAttempt[];
    audioSeconds: number;
    idempotencyKey: string | null;
  }): Promise<void> {
    if (input.attempts.length === 0) return;
    await this.transaction(async (client) => {
      if (input.idempotencyKey) {
        // Serialise duplicate webhook deliveries without a schema-wide unique
        // index: existing installations may already contain historical repeats.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [input.idempotencyKey],
        );
      }
      for (const [index, attempt] of input.attempts.slice(0, 6).entries()) {
        await client.query(
          `INSERT INTO stt_usage_events
             (use_case, config_id, provider, model, outcome, attempt_index, is_fallback,
              audio_seconds, latency_ms, error_code, idempotency_key)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            WHERE $11::text IS NULL
               OR NOT EXISTS (
                    SELECT 1 FROM stt_usage_events
                     WHERE idempotency_key = $11 AND attempt_index = $6
                  )`,
          [
            input.useCase,
            attempt.configId,
            attempt.provider,
            attempt.model,
            attempt.ok ? "success" : "failure",
            index + 1,
            attempt.isFallback,
            index === 0 ? input.audioSeconds : 0,
            attempt.latencyMs,
            attempt.errorCode,
            input.idempotencyKey,
          ],
        );
      }
    });
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
      `
        -- tenant: system — агрегаты для /health и обзора: только количества, ни одной пользовательской строки
        SELECT
         (SELECT count(*) FROM users)                                    AS users,
         (SELECT count(*) FROM agent_links WHERE status = 'active')      AS agents,
         (SELECT count(*) FROM agent_links
           WHERE status = 'active' AND conversation_id IS NOT NULL)      AS conversations,
         (SELECT count(*) FROM crisis_events WHERE handled = false)      AS open_crisis_events`,
    );
    return rows[0] ?? {};
  }
}
