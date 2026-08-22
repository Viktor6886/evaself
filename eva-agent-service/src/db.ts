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
import {
  adminScope,
  assertQueryAllowed,
  bindUserId,
  currentScope,
  runInScope,
  systemScope,
  userScope,
  type AdminScope,
  type SystemScope,
  type UserScope,
} from "./tenancy/index.js";

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
  /**
   * Служебные отметки связки. Здесь же живёт `persona_version` — версия
   * repository prompt и канонического ядра памяти, доставленная агенту.
   * Это отпечаток развёртывания, а не копия prompt или блока.
   */
  meta?: Record<string, unknown> | null;
}

export interface LlmProviderRow {
  id: string;
  name: string;
  protocol: "openai-compatible" | "openai-responses" | "gemini-compatible" | "anthropic-compatible";
  base_url: string;
  model: string;
  context_window: number;
  max_output_tokens?: number;
  additional_parameters: Record<string, unknown>;
  api_key_encrypted: string;
  is_active: boolean;
  last_checked_at: Date | null;
  last_check_ok: boolean | null;
  last_check_message: string | null;
  last_models: unknown[] | null;
  created_at: Date;
  updated_at: Date;
  /**
   * Заявленный профиль возможностей (миграция 017). Заявление — это
   * намерение администратора; проверяет его capability probe.
   */
  supports_tools?: boolean;
  supports_json?: boolean;
  supports_vision?: boolean;
  supports_streaming?: boolean;
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
  base_tools: string[] | null;
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

  /** Dedicated connection for a caller-owned SQL transaction. */
  async transactionClient(): Promise<pg.PoolClient> {
    return this.require().connect();
  }

  async withQueryMetrics<T>(
    work: () => Promise<T>,
  ): Promise<{ result: T; queryCount: number }> {
    const counter = { count: 0 };
    const result = await this.queryMetrics.run(counter, work);
    return { result, queryCount: counter.count };
  }

  /**
   * Состояние пула для /metrics. Берётся у настоящего пула, а не у
   * его проверяющей обёртки: счётчики соединений границы арендатора не
   * касаются, а обёртка их не считает.
   */
  poolStats(): { total: number; idle: number; waiting: number } {
    const pool = this.pool;
    if (!pool) return { total: 0, idle: 0, waiting: 0 };
    return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
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
    const { rows } = await this.withUserScope(
      { telegramId: input.telegramId, label: "db.upsertUser", inherit: true },
      async () => await this.require().query<UserRow>(
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
      ),
    );
    return rows[0]!;
  }

  async setUserState(userId: number, state: "onboarding" | "active" | "paused"): Promise<void> {
    await this.withUserScope(
      { userId, label: "db.setUserState", inherit: true },
      async () => await this.require().query(
        "UPDATE users SET state = $2, consent_at = COALESCE(consent_at, now()) WHERE id = $1",
        [userId, state],
      ),
    );
  }

  /**
   * Апдейт связывается с пользователем один раз. Условие по `user_id`
   * не декоративное: без него повторная обработка чужого апдейта
   * переписала бы владельца записи ingress.
   */
  async attachTelegramUpdateToUser(updateId: number, userId: number): Promise<void> {
    await this.withUserScope(
      { userId, label: "db.attachTelegramUpdate", inherit: true },
      async () => await this.require().query(
        `UPDATE telegram_updates SET user_id = $2
          WHERE update_id = $1 AND (user_id IS NULL OR user_id = $2)`,
        [updateId, userId],
      ),
    );
  }

  /**
   * Отметить сообщение человека и вернуть отметку ПРЕДЫДУЩЕГО.
   *
   * Прежнее значение нужно контексту хода: по нему считается промежуток
   * между сообщениями. Читается оно тем же запросом, что и обновление, —
   * CTE видит строку до записи, поэтому второго обращения к базе не нужно
   * и гонки между чтением и обновлением тоже не остаётся.
   *
   * `null` означает «предыдущего сообщения нет»: человек пишет впервые.
   */
  /**
   * Отметить последнее сообщение человека и вернуть предыдущее.
   *
   * Время передаётся вызывающим: у Telegram есть собственная отметка
   * отправки, а `now()` здесь — момент обработки, то есть отправка плюс
   * очередь. Промежуток «сколько прошло с прошлого сообщения» считается
   * по первой, иначе он растёт вместе с задержкой сервиса.
   */
  async recordUserMessage(userId: number, at?: Date): Promise<Date | null> {
    const { rows } = await this.withUserScope(
      { userId, label: "db.recordUserMessage", inherit: true },
      async () => await this.require().query<{ last_user_message_at: Date | null }>(
      `WITH previous AS (
         SELECT last_user_message_at FROM heartbeat_state WHERE user_id = $1
       ), touched AS (
         INSERT INTO heartbeat_state (user_id, last_user_message_at)
         VALUES ($1, COALESCE($2::timestamptz, now()))
         ON CONFLICT (user_id) DO UPDATE
           SET last_user_message_at = COALESCE($2::timestamptz, now())
         RETURNING user_id
       )
       SELECT previous.last_user_message_at FROM previous`,
      [userId, at ?? null],
      ),
    );
    return rows[0]?.last_user_message_at ?? null;
  }

  async getUserOverview(telegramId: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.withUserScope(
      { telegramId, label: "db.getUserOverview", inherit: true },
      async () => await this.require().query(
        "SELECT * FROM v_user_overview WHERE telegram_id = $1",
        [telegramId],
      ),
    );
    return rows[0] ?? null;
  }

  async getAgentRuntimeContext(conversationId: string): Promise<AgentRuntimeContext | null> {
    // Каноническое сопоставление conversation → пользователь. Именно
    // отсюда берётся владелец для областей инструментов, поэтому сам
    // запрос идёт как системный, а не от чьего-то имени.
    const { rows } = await this.withSystemScope(
      "db.getAgentRuntimeContext",
      async () => await this.require().query<{
      user_id: string;
      telegram_id: string;
      chat_id: string | null;
      conversation_id: string;
      purpose: AgentRuntimeContext["purpose"];
      timezone: string;
      response_mode: "text" | "voice" | "both";
      use_emoji: boolean;
    }>(
      `
        -- tenant: system — каноническое сопоставление conversation → пользователь, отсюда берётся владелец для областей
        SELECT u.id AS user_id,
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
      ),
      { crossUser: true },
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
    const { rows } = await this.withUserScope(
      { telegramId, label: "db.getAgentLink", inherit: true },
      async () => await this.require().query<AgentLinkRow>(
      `SELECT a.* FROM agent_links a
        JOIN users u ON u.id = a.user_id
       WHERE u.telegram_id = $1 AND a.kind = $2 AND a.status = 'active'
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [telegramId, kind],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * Агент этого человека по внутреннему идентификатору.
   *
   * `getAgentLink` спрашивает по telegram_id, а самопроверка идёт из
   * хода, где известен внутренний `user_id`: заводить ради этого второй
   * путь к агенту незачем, но и подменять один идентификатор другим
   * нельзя — это разные ключи.
   */
  /**
   * Найти человека по Telegram-идентификатору, ничего не создавая.
   *
   * `upsertUser` завёл бы запись — нажатию кнопки это не нужно: кнопку
   * видит только тот, кому уже отвечали, и незнакомый идентификатор
   * здесь означает подделку, а не нового человека.
   */
  async findUserByTelegramId(telegramId: number): Promise<{ id: number } | null> {
    const { rows } = await this.withUserScope(
      { telegramId, label: "db.findUserByTelegramId", inherit: true },
      async () => await this.require().query<{ id: string }>(
        "SELECT id FROM users WHERE telegram_id = $1",
        [telegramId],
      ),
    );
    return rows[0] ? { id: Number(rows[0].id) } : null;
  }

  async agentIdOfUser(userId: number, kind = "eva"): Promise<string | null> {
    const { rows } = await this.withUserScope(
      { userId, label: "db.agentIdOfUser", inherit: true },
      async () => await this.require().query<{ agent_id: string }>(
        `SELECT agent_id FROM agent_links
          WHERE user_id = $1 AND kind = $2 AND status = 'active'
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId, kind],
      ),
    );
    return rows[0]?.agent_id ?? null;
  }

  /**
   * Выдать токены кнопок под уже отправленное сообщение.
   *
   * Токены создаются на доставке, а не в инструменте: до отправки
   * неизвестен `message_id`, а без него нельзя ни снять клавиатуру после
   * выбора, ни отличить кнопку этого ответа от кнопки прошлого.
   */
  async issueCallbackTokens(input: {
    userId: number;
    chatId: number;
    conversationId: string;
    messageId: number | null;
    oneShot: boolean;
    ttlSeconds: number;
    choices: Array<{ label: string; value: string; token: string }>;
  }): Promise<void> {
    if (input.choices.length === 0) return;
    await this.withUserScope(
      { userId: input.userId, label: "db.issueCallbackTokens", inherit: true },
      async () => {
        for (const choice of input.choices) {
          await this.require().query(
            `INSERT INTO telegram_callback_tokens
               (token, user_id, chat_id, conversation_id, message_id,
                choice_label, choice_value, one_shot, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
             ON CONFLICT (token) DO NOTHING`,
            [
              choice.token, input.userId, input.chatId, input.conversationId,
              input.messageId, choice.label, choice.value, input.oneShot,
              input.ttlSeconds,
            ],
          );
        }
      },
    );
  }

  /**
   * Забрать выбор по токену — ровно один раз.
   *
   * Проверка владельца, срока и повторного нажатия сделана одним
   * запросом: между «прочитали» и «отметили использованным» не должно
   * быть окна, в котором двойной клик заводит два хода.
   */
  async claimCallbackToken(input: { token: string; userId: number }): Promise<
    | { status: "claimed"; chatId: number; conversationId: string; messageId: number | null; label: string; value: string; oneShot: boolean }
    | { status: "already_used" | "expired" | "unknown" }
  > {
    const { rows } = await this.withUserScope(
      { userId: input.userId, label: "db.claimCallbackToken", inherit: true },
      async () => await this.require().query<{
        chat_id: string; conversation_id: string; message_id: string | null;
        choice_label: string; choice_value: string; one_shot: boolean;
        was_used: boolean; expired: boolean;
      }>(
        `WITH candidate AS (
           SELECT token, used_at IS NOT NULL AS was_used, expires_at <= now() AS expired
             FROM telegram_callback_tokens
            WHERE token = $1 AND user_id = $2
         ),
         taken AS (
           UPDATE telegram_callback_tokens t
              SET used_at = now()
             FROM candidate c
            -- Владелец назван и здесь, а не только в выборке кандидата:
            -- граница арендатора должна стоять на самой записи.
            WHERE t.token = c.token AND t.user_id = $2
              AND NOT c.was_used AND NOT c.expired
        RETURNING t.chat_id, t.conversation_id, t.message_id,
                  t.choice_label, t.choice_value, t.one_shot
         )
         SELECT taken.chat_id, taken.conversation_id, taken.message_id,
                taken.choice_label, taken.choice_value, taken.one_shot,
                candidate.was_used, candidate.expired
           FROM candidate LEFT JOIN taken ON true`,
        [input.token, input.userId],
      ),
    );
    const row = rows[0];
    if (!row) return { status: "unknown" };
    if (row.was_used) return { status: "already_used" };
    if (row.expired) return { status: "expired" };
    return {
      status: "claimed",
      chatId: Number(row.chat_id),
      conversationId: row.conversation_id,
      messageId: row.message_id === null ? null : Number(row.message_id),
      label: row.choice_label,
      value: row.choice_value,
      oneShot: row.one_shot,
    };
  }

  /**
   * Завести опрос до его отправки.
   *
   * Запись появляется раньше самого опроса, и ключом служит вызов
   * инструмента: повтор того же вызова после сбоя находит уже созданную
   * строку и второго опроса в чате не появляется. Идентификатор
   * Telegram проставляется отдельно — до отправки его не знает никто.
   */
  async createPoll(input: {
    userId: number;
    chatId: number;
    conversationId: string;
    toolCallId: string;
    runId: string | null;
    question: string;
    options: string[];
    isAnonymous: boolean;
    allowsMultiple: boolean;
  }): Promise<{ id: string; pollId: string | null; created: boolean }> {
    return await this.withUserScope(
      { userId: input.userId, label: "db.createPoll", inherit: true },
      async () => {
        const inserted = await this.require().query<{ id: string; poll_id: string | null }>(
          `INSERT INTO telegram_polls
             (user_id, chat_id, conversation_id, tool_call_id, run_id,
              question, options, is_anonymous, allows_multiple)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9)
           ON CONFLICT (user_id, tool_call_id) DO NOTHING
           RETURNING id, poll_id`,
          [
            input.userId, input.chatId, input.conversationId, input.toolCallId,
            input.runId, input.question, input.options, input.isAnonymous,
            input.allowsMultiple,
          ],
        );
        const fresh = inserted.rows[0];
        if (fresh) return { id: fresh.id, pollId: fresh.poll_id, created: true };
        // Строка уже есть. Чтение идёт отдельным оператором намеренно:
        // внутри одного оператора выборка работает со снимком, снятым до
        // ожидания на уникальном индексе, и строку победителя гонки могла
        // бы не увидеть вовсе — вызов упал бы там, где опрос уже создан.
        const { rows } = await this.require().query<{ id: string; poll_id: string | null }>(
          `SELECT id, poll_id FROM telegram_polls
            WHERE user_id = $1 AND tool_call_id = $2`,
          [input.userId, input.toolCallId],
        );
        const existing = rows[0];
        if (!existing) throw new Error("Опрос не сохранён");
        return { id: existing.id, pollId: existing.poll_id, created: false };
      },
    );
  }

  /** Связать запись с опросом Telegram после успешной отправки. */
  async bindPoll(input: {
    userId: number;
    id: string;
    pollId: string;
    messageId: number | null;
  }): Promise<void> {
    await this.withUserScope(
      { userId: input.userId, label: "db.bindPoll", inherit: true },
      async () => await this.require().query(
        `UPDATE telegram_polls
            SET poll_id = $3, message_id = $4, sent_at = now()
          WHERE id = $2 AND user_id = $1 AND poll_id IS NULL`,
        [input.userId, input.id, input.pollId, input.messageId],
      ),
    );
  }

  /**
   * Найти опрос по идентификатору Telegram.
   *
   * Апдейт с голосом не приносит ни чата, ни разговора, ни владельца
   * внутренней учётной записи — только идентификатор опроса. Поиск идёт
   * по нему как по внешнему ключу приёма, поэтому область системная: чей
   * это опрос, выясняется как раз здесь, а дальше работа идёт уже в
   * области владельца.
   */
  async findPollByTelegramId(pollId: string): Promise<
    | {
      id: string; userId: number; chatId: number; conversationId: string;
      question: string; options: string[]; isAnonymous: boolean; messageId: number | null;
    }
    | null
  > {
    const { rows } = await this.withSystemScope(
      "telegram.poll.lookup",
      async () => await this.query<{
        id: string; user_id: string; chat_id: string; conversation_id: string;
        question: string; options: string[]; is_anonymous: boolean; message_id: string | null;
      }>(
        `
          -- tenant: system — приём голоса Telegram: строка ищется по идентификатору опроса, владелец определяется из неё
          SELECT id, user_id, chat_id, conversation_id, question, options,
                 is_anonymous, message_id
            FROM telegram_polls
           WHERE poll_id = $1`,
        [pollId],
      ),
      { crossUser: true },
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: Number(row.user_id),
      chatId: Number(row.chat_id),
      conversationId: row.conversation_id,
      question: row.question,
      options: row.options,
      isAnonymous: row.is_anonymous,
      messageId: row.message_id === null ? null : Number(row.message_id),
    };
  }

  /**
   * Записать голос человека в опросе.
   *
   * Telegram присылает изменение голоса тем же апдейтом, что и первый
   * выбор, а один и тот же апдейт может прийти повторно. Поэтому строка
   * одна на человека и опрос, а результат говорит, стал ли этот голос
   * новостью: повтор того же выбора ходом не становится.
   */
  async recordPollAnswer(input: {
    userId: number;
    pollId: string;
    optionIds: number[];
  }): Promise<{ status: "recorded" | "duplicate" }> {
    const { rows } = await this.withUserScope(
      { userId: input.userId, label: "db.recordPollAnswer", inherit: true },
      async () => await this.require().query<{ recorded: boolean }>(
        `INSERT INTO telegram_poll_answers (poll_id, user_id, option_ids)
         VALUES ($1, $2, $3::int[])
         ON CONFLICT (poll_id, user_id) DO UPDATE
            SET option_ids = EXCLUDED.option_ids,
                answered_at = now()
          WHERE telegram_poll_answers.option_ids IS DISTINCT FROM EXCLUDED.option_ids
         RETURNING true AS recorded`,
        [input.pollId, input.userId, input.optionIds],
      ),
    );
    return { status: rows[0]?.recorded ? "recorded" : "duplicate" };
  }

  /** Погасить остальные кнопки того же сообщения после сделанного выбора. */
  async expireCallbackTokensOfMessage(input: {
    userId: number; chatId: number; messageId: number;
  }): Promise<void> {
    await this.withUserScope(
      { userId: input.userId, label: "db.expireCallbackTokensOfMessage", inherit: true },
      async () => await this.require().query(
        `UPDATE telegram_callback_tokens
            SET used_at = COALESCE(used_at, now())
          WHERE user_id = $1 AND chat_id = $2 AND message_id = $3`,
        [input.userId, input.chatId, input.messageId],
      ),
    );
  }

  async saveAgentLink(input: {
    userId: number;
    agentId: string;
    conversationId: string | null;
    agentName: string | null;
    model: string | null;
    kind?: string;
  }): Promise<AgentLinkRow> {
    return await this.withUserScope(
      { userId: input.userId, label: "db.saveAgentLink", inherit: true },
      async () => await this.saveAgentLinkInScope(input),
    );
  }

  private async saveAgentLinkInScope(input: {
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

  /**
   * Point a user's link at a different conversation (e.g. "start over").
   *
   * Владелец известен не всегда: внутренний /v1 адресует связку по
   * `agent_id`, который уникален и сам указывает на пользователя. Когда
   * владелец известен, он передаётся и запрос ограничивается им.
   */
  async setConversation(
    agentId: string,
    conversationId: string,
    userId?: number,
  ): Promise<void> {
    const run = async () =>
      await this.setConversationInScope(agentId, conversationId, userId ?? null);
    await (userId === undefined
      ? this.withSystemScope("db.setConversation", run, { crossUser: true })
      : this.withUserScope(
          { userId, label: "db.setConversation", inherit: true },
          run,
        ));
  }

  private async setConversationInScope(
    agentId: string,
    conversationId: string,
    userId: number | null,
  ): Promise<void> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ user_id: string }>(
        `
          -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
          UPDATE agent_links SET conversation_id = $2, message_count = 0
          WHERE agent_id = $1
            AND ($3::bigint IS NULL OR user_id = $3)
        RETURNING user_id`,
        [agentId, conversationId, userId],
      );
      if (rows[0]) {
        await client.query(
          `
            -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
            UPDATE agent_conversations
              SET status = 'archived', archived_at = now()
            WHERE agent_id = $1
              AND ($3::bigint IS NULL OR user_id = $3)
              AND purpose = 'chat'
              AND status = 'active'
              AND conversation_id <> $2`,
          [agentId, conversationId, userId],
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

  async markAgentUsed(agentId: string, userId?: number): Promise<void> {
    if (userId === undefined) {
      await this.withSystemScope(
        "db.markAgentUsed",
        async () => await this.require().query(
          `
            -- tenant: by agent_id — агент принадлежит ровно одному пользователю, agent_links_agent_id_uidx
            UPDATE agent_links
              SET last_message_at = now(), message_count = message_count + 1
            WHERE agent_id = $1`,
          [agentId],
        ),
        { crossUser: true },
      );
      return;
    }
    await this.withUserScope(
      { userId, label: "db.markAgentUsed", inherit: true },
      async () => await this.require().query(
        `UPDATE agent_links
            SET last_message_at = now(), message_count = message_count + 1
          WHERE agent_id = $1 AND user_id = $2`,
        [agentId, userId],
      ),
    );
  }

  /** Служебный обзор связок для внутреннего /v1 и панели. */
  async listAgentLinks(limit = 500): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.withSystemScope(
      "db.listAgentLinks",
      async () => await this.require().query(
      `
        -- tenant: system — инвентарь связок для сверки с App Server, строк пользователей не отдаёт
        SELECT u.telegram_id, a.agent_id, a.conversation_id, a.kind, a.runtime,
              a.status, a.message_count, a.last_message_at
         FROM agent_links a JOIN users u ON u.id = a.user_id
        WHERE a.status = 'active'
        ORDER BY a.created_at
        LIMIT $1`,
      [limit],
      ),
      { crossUser: true },
    );
    return rows;
  }

  /**
   * Агенты, которым может понадобиться канонический текст персоны.
   *
   * Версия персоны хранится в `meta` связки — это отметка развёртывания,
   * а не копия блока: значение блока живёт только в Letta (инвариант 12).
   * По отметке видно, кому канонический текст уже доставлен, и повторная
   * синхронизация не трогает их снова.
   */
  async listAgentsForPersonaSync(
    limit = 500,
  ): Promise<Array<{ agentId: string; userId: number; conversationId: string | null; personaVersion: string | null }>> {
    const { rows } = await this.withSystemScope(
      "db.listAgentsForPersonaSync",
      async () => await this.require().query<{
        agent_id: string;
        user_id: string;
        conversation_id: string | null;
        persona_version: string | null;
      }>(
      `
        -- tenant: system — инвентарь агентов для доставки канонической персоны, пользовательских строк не отдаёт
         SELECT a.agent_id, a.user_id, a.conversation_id,
                a.meta ->> 'persona_version' AS persona_version
          FROM agent_links a
         WHERE a.kind = 'eva' AND a.status = 'active'
         ORDER BY a.created_at
         LIMIT $1`,
      [limit],
      ),
      { crossUser: true },
    );
    return rows.map((row) => ({
      agentId: row.agent_id,
      userId: Number(row.user_id),
      personaVersion: row.persona_version,
      conversationId: row.conversation_id,
    }));
  }

  /**
   * Отметить, что system prompt и ядро памяти агента сведены с каноническими.
   *
   * В `meta` попадают только отметки: версия канонического набора и
   * метки блоков прежней схемы, которые остались у агента. Значений
   * блоков здесь нет и быть не может — они живут в Letta (инвариант 12).
   *
   * Имя ключа `persona_version` осталось прежним: по нему уже отмечены
   * работающие установки, и переименование потребовало бы миграции ради
   * названия.
   */
  async recordMemoryReconciled(
    agentId: string,
    userId: number,
    state: { version: string; legacy: string[] },
  ): Promise<void> {
    await this.withUserScope(
      { userId, label: "db.recordMemoryReconciled", inherit: true },
      async () => await this.require().query(
        `UPDATE agent_links
            SET meta = meta || jsonb_build_object(
                  'persona_version', $3::text,
                  'memory_legacy_blocks', $4::jsonb,
                  'canonical_context_sync_status', 'ok',
                  'canonical_context_sync_at', now()
                ),
                updated_at = now()
          WHERE agent_id = $1 AND user_id = $2`,
        [agentId, userId, state.version, JSON.stringify(state.legacy)],
      ),
    );
  }

  async recordCanonicalContextSyncState(
    agentId: string,
    userId: number,
    status: "degraded" | "unsupported",
  ): Promise<void> {
    await this.withUserScope(
      { userId, label: "db.recordCanonicalContextSyncState", inherit: true },
      async () => await this.require().query(
        `UPDATE agent_links
            SET meta = meta || jsonb_build_object(
                  'canonical_context_sync_status', $3::text,
                  'canonical_context_sync_at', now()
                ),
                updated_at = now()
          WHERE agent_id = $1 AND user_id = $2`,
        [agentId, userId, status],
      ),
    );
  }

  /**
   * Записать фактические вызовы нативных инструментов за ход.
   *
   * Только метаданные: имя инструмента, имя навыка (если SDK его
   * назвал), идентификаторы вызова и run, исход. Ни аргументов, ни
   * содержимого навыка, ни текста человека здесь нет и быть не может.
   *
   * Повторный разбор того же хода — например, при восстановлении —
   * ничего не дублирует: строка ключуется идентификатором вызова.
   */
  async recordAgentToolCalls(
    userId: number,
    conversationId: string | null,
    calls: ReadonlyArray<{
      toolName: string;
      skillName: string | null;
      toolCallId: string;
      runId: string | null;
      succeeded: boolean | null;
    }>,
  ): Promise<void> {
    if (calls.length === 0) return;
    await this.withUserScope(
      { userId, label: "db.recordAgentToolCalls", inherit: true },
      async () => await this.require().query(
        `INSERT INTO agent_tool_calls
           (user_id, conversation_id, tool_name, skill_name, tool_call_id, run_id, succeeded)
         SELECT $1, $2, entry.tool_name, entry.skill_name, entry.tool_call_id,
                entry.run_id, entry.succeeded
           FROM jsonb_to_recordset($3::jsonb) AS entry(
                  tool_name text, skill_name text, tool_call_id text,
                  run_id text, succeeded boolean)
         ON CONFLICT (user_id, tool_call_id) DO UPDATE
            SET succeeded = COALESCE(EXCLUDED.succeeded, agent_tool_calls.succeeded)`,
        [
          userId,
          conversationId,
          JSON.stringify(calls.map((call) => ({
            tool_name: call.toolName,
            skill_name: call.skillName,
            tool_call_id: call.toolCallId,
            run_id: call.runId,
            succeeded: call.succeeded,
          }))),
        ],
      ),
    );
  }

  /**
   * Сколько раз агент открывал навыки и когда это было в последний раз.
   *
   * Нужен самопроверке рантайма: «Ева говорит, что пользуется навыками»
   * и «Ева открывала навык» — разные утверждения, и второе проверяется
   * только здесь.
   */
  async skillCallStats(userId: number): Promise<{
    total: number;
    last: { skillName: string | null; at: string; succeeded: boolean | null } | null;
  }> {
    const { rows } = await this.withUserScope(
      { userId, label: "db.skillCallStats", inherit: true },
      async () => await this.require().query<{
        total: string;
        skill_name: string | null;
        called_at: Date | null;
        succeeded: boolean | null;
       }>(
        `SELECT count(*) OVER () AS total, skill_name, called_at, succeeded
           FROM agent_tool_calls
          WHERE user_id = $1 AND tool_name = $2
          ORDER BY called_at DESC
          LIMIT 1`,
        [userId, "Skill"],
      ),
    );
    const row = rows[0];
    if (!row) return { total: 0, last: null };
    return {
      total: Number(row.total),
      last: {
        skillName: row.skill_name,
        at: (row.called_at ?? new Date()).toISOString(),
        succeeded: row.succeeded,
      },
    };
  }

  async listModelMappings(): Promise<ModelMapping[]> {
    const { rows } = await this.withSystemScope(
      "db.listModelMappings",
      async () => await this.require().query<{
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
      ),
      { crossUser: true },
    );
    return rows.map((row) => ({
      agentId: row.agent_id,
      conversationIds: row.conversation_ids ?? [],
    }));
  }

  /** Перевод всех активных агентов на модель — обслуживание установки. */
  async setAgentModels(model: string): Promise<void> {
    await this.withSystemScope(
      "db.setAgentModels",
      async () => await this.require().query(
        `
          -- tenant: system — смена модели применяется ко всем активным агентам сразу
          UPDATE agent_links
            SET model = $1
          WHERE status = 'active' AND runtime = 'letta-app-server'`,
        [model],
      ),
      { crossUser: true },
    );
  }

  /** Archive a PostgreSQL mapping after its Letta agent was explicitly deleted. */
  async archiveAgentLink(agentId: string): Promise<void> {
    await this.withSystemScope(
      "db.archiveAgentLink",
      async () => await this.archiveAgentLinkInScope(agentId),
      { crossUser: true },
    );
  }

  private async archiveAgentLinkInScope(agentId: string): Promise<void> {
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
            Database.guard(args);
            this.incrementQueryCount();
            return this.timed(() => Reflect.apply(target.query, target, args));
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
            Database.guard(args);
            this.incrementQueryCount();
            return this.timed(() => Reflect.apply(target.query, target, args));
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /**
   * Единственная точка, где запрос проверяется на границу арендатора.
   * Все обращения сервиса к PostgreSQL проходят через этот пул, поэтому
   * обойти проверку можно только собственным подключением — на это есть
   * отдельный тест.
   */
  private static guard(args: unknown[]): void {
    const first = args[0];
    const sql = typeof first === "string"
      ? first
      : first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string"
        ? (first as { text: string }).text
        : "";
    const values = Array.isArray(args[1])
      ? args[1] as unknown[]
      : first && typeof first === "object" && Array.isArray((first as { values?: unknown }).values)
        ? (first as { values: unknown[] }).values
        : [];
    assertQueryAllowed(sql, values);
  }

  /**
   * Задержка запроса к базе.
   *
   * Скользящее окно фиксированного размера, а не гистограмма и не
   * счётчик за всё время: наблюдателю нужно «как сейчас», а сумма с
   * момента запуска отвечает на другой вопрос и тем медленнее реагирует,
   * чем дольше живёт процесс. Память ограничена размером окна.
   */
  private readonly latencies: number[] = [];

  private timed<T>(work: () => T): T {
    const startedAt = performance.now();
    const finish = (): void => {
      const elapsed = performance.now() - startedAt;
      this.latencies.push(elapsed);
      if (this.latencies.length > Database.LATENCY_WINDOW) this.latencies.shift();
    };
    const result = work() as unknown;
    if (result && typeof (result as { then?: unknown }).then === "function") {
      // Замер закрывается и на отказе: медленный запрос, кончившийся
      // ошибкой, — это тоже задержка базы, и терять её нельзя.
      return (result as Promise<unknown>).then(
        (value) => {
          finish();
          return value;
        },
        (error: unknown) => {
          finish();
          throw error;
        },
      ) as T;
    }
    finish();
    return result as T;
  }

  private static readonly LATENCY_WINDOW = 200;

  /** Задержка последних запросов в миллисекундах: среднее и максимум. */
  queryLatency(): { avg: number; max: number; samples: number } {
    if (this.latencies.length === 0) return { avg: 0, max: 0, samples: 0 };
    const sum = this.latencies.reduce((total, item) => total + item, 0);
    return {
      avg: sum / this.latencies.length,
      max: Math.max(...this.latencies),
      samples: this.latencies.length,
    };
  }

  private incrementQueryCount(): void {
    const metrics = this.queryMetrics.getStore();
    if (metrics) metrics.count += 1;
  }

  // -----------------------------------------------------------------
  // границы арендатора
  // -----------------------------------------------------------------

  /**
   * Работа от имени одного пользователя.
   *
   * `inherit` оставляет уже объявленную область: собственные методы
   * `Database` объявляют её сами, но внутри хода пользователя рамку
   * задаёт этот ход, и подменить её вложенным вызовом нельзя.
   */
  async withUserScope<T>(
    input: {
      userId?: number | null;
      telegramId?: number | null;
      label: string;
      inherit?: boolean;
    },
    work: (scope: UserScope | null) => Promise<T>,
  ): Promise<T> {
    if (input.inherit && currentScope()) return await work(null);
    const scope = userScope(input);
    return await runInScope(scope, async () => await work(scope));
  }

  /**
   * Фоновая работа сервиса. `crossUser` объявляется там, где выборка по
   * своей природе идёт сразу по многим пользователям: аренда inbox и
   * outbox, планировщик, вебхук оплаты до опознания владельца.
   */
  async withSystemScope<T>(
    reason: string,
    work: () => Promise<T>,
    options: { crossUser?: boolean; inherit?: boolean } = {},
  ): Promise<T> {
    // `inherit` — для работы, которую начинает то пользователь, то сам
    // сервис: доставка сообщения относится к ходу пользователя, если он
    // есть, и к сервису, если сообщение отправляет фоновая часть.
    if (options.inherit && currentScope()) return await work();
    const scope: SystemScope = systemScope(reason, options);
    return await runInScope(scope, work);
  }

  /** Административный доступ: роль и запись аудита обязательны. */
  async withAdminScope<T>(
    input: { actor: string; role: string; auditId?: string | null; route: string },
    work: (scope: AdminScope) => Promise<T>,
  ): Promise<T> {
    const scope = adminScope(input);
    return await runInScope(scope, async () => await work(scope));
  }

  /**
   * Связать область с внутренним `users.id` после канонической выборки.
   * До этого момента область знает только Telegram-идентификатор.
   */
  bindScopeUserId(userId: number): void {
    bindUserId(userId);
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
         base_tools = $9,
         dreaming = $10::jsonb,
         model_settings = $11::jsonb,
         default_context_window = $12,
         conversation_summary = $13,
         conversation_description = $14,
         conversation_hidden = $15,
         create_conversation = $16,
         session_pool_size = $17,
         session_idle_ms = $18,
         turn_timeout_ms = $19,
         app_server_request_timeout_ms = $20
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
        input.base_tools,
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
    protocol: LlmProviderRow["protocol"];
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
    protocol: LlmProviderRow["protocol"];
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
    const { rows } = await this.withUserScope(
      { telegramId, label: "db.incrementUsage", inherit: true },
      async () => await this.require().query<{ used: string }>(
      `INSERT INTO usage_counters (user_id, metric, period, period_start, used)
       SELECT id, $2, $3, $4, $5 FROM users WHERE telegram_id = $1
       ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
         SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
       RETURNING used`,
      [telegramId, metric, period, Database.periodStart(period), amount],
      ),
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
    const { rows } = await this.withUserScope(
      { telegramId, label: "db.getQuotaStatus", inherit: true },
      async () => await this.require().query(
        `SELECT metric, period, limit_value, used, remaining
           FROM v_quota_status WHERE telegram_id = $1`,
        [telegramId],
      ),
    );
    return rows;
  }

  /** Сводные счётчики установки: людей в них нет, только количества. */
  async stats(): Promise<Record<string, unknown>> {
    const { rows } = await this.withSystemScope(
      "db.stats",
      async () => await this.require().query(
      `
        -- tenant: system — агрегаты для /health и обзора: только количества, ни одной пользовательской строки
        SELECT
         (SELECT count(*) FROM users)                                    AS users,
         (SELECT count(*) FROM agent_links WHERE status = 'active')      AS agents,
         (SELECT count(*) FROM agent_links
           WHERE status = 'active' AND conversation_id IS NOT NULL)      AS conversations,
         (SELECT count(*) FROM crisis_events WHERE handled = false)      AS open_crisis_events`,
      ),
      { crossUser: true },
    );
    return rows[0] ?? {};
  }
}
