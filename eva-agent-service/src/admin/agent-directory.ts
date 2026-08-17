/**
 * Агенты и conversations: список, карточка, архив, безопасное удаление,
 * экспорт и предпросмотр импорта.
 *
 * Источник истины здесь — PostgreSQL, а не Letta (инвариант 1). Каталог
 * агентов и conversations живёт в `agent_links` и `agent_conversations`, и
 * администратор управляет именно им. Обращений к Letta App Server отсюда
 * нет вовсе: единственный, кому разрешено ходить в Letta, — это
 * eva-agent-service, а admin-api к нему обращается по внутреннему API там,
 * где это действительно нужно (переписка, провайдеры).
 *
 * Что это значит для удаления. Физического удаления агента здесь нет и не
 * будет: оно необратимо, уносит с собой историю и блоки, и правило
 * «необратимое — только по отдельному разрешению человека» относится к нему
 * в первую очередь. Вместо этого — архивация (обратима) и предпросмотр
 * удаления, который честно называет незакончившиеся ходы через существующий
 * `DeleteGuard`.
 *
 * Содержимого переписки в ответах нет ни в одном методе: заголовки,
 * счётчики, состояния и отпечатки — да, сообщения — нет. Переписка читается
 * отдельным маршрутом, под отдельным грантом и с собственной записью
 * аудита.
 *
 * Чего здесь нет и почему — по перечню области 1 задания шага 12:
 *
 *   создание       — создать агента вправе только eva-agent-service через
 *                    Letta SDK: второй путь создания агентов означал бы
 *                    второй conversational runtime (инвариант 3);
 *   изменение      — `agent_links.model`, `embedding_model` и `agent_name`
 *                    в PostgreSQL зеркалят конфигурацию агента в Letta.
 *                    Правка их отсюда не дошла бы до Letta и создала бы
 *                    скрытое расхождение: в базе одно, в Letta другое, и
 *                    никто не знает, где правда. Менять их будет шаг,
 *                    у которого есть путь записи в Letta;
 *   удаление       — только предпросмотр: удаление необратимо и требует
 *                    отдельного разрешения человека;
 *   mapping        — уже есть и не дублируется: связь Telegram ↔ учётная
 *                    запись живёт в `admin/user-service.ts`, а карточка
 *                    агента называет владельца идентификатором;
 *   назначение     — `agent_conversations.purpose`, фильтр в `conversations()`;
 *   версии         — модель и embedding-модель агента показывает карточка;
 *                    версии артефактов — отдельный реестр (шаг 13);
 *   сессии и
 *   активные ходы  — `turn_runs` через `DeleteGuard`: аренда, состояние и
 *                    число незакончившихся ходов.
 */

import { badRequest, notFound } from "../errors.js";
import type { DeleteGuard } from "../letta/delete-guard.js";

export interface DirectoryDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface AgentSummary {
  agentId: string;
  userId: number;
  kind: string;
  agentName: string | null;
  model: string | null;
  embeddingModel: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string | null;
  conversations: number;
  activeTurns: number;
}

export interface ConversationSummary {
  conversationId: string;
  agentId: string;
  userId: number;
  purpose: string | null;
  title: string | null;
  status: string;
  messageCount: number;
  startedAt: string | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
}

export interface DirectoryFilter {
  query?: string;
  status?: string;
  agentId?: string;
  purpose?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function bounded(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 0), max);
}

/**
 * Идентификатор объекта Letta.
 *
 * Проверяется даже там, где значение уходит параметром запроса: по битой
 * ссылке администратор подействовал бы не на тот объект, а сообщение
 * «строка не подошла» об этом хотя бы говорит.
 */
function objectId(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(text)) throw badRequest(`Некорректный ${name}`);
  return text;
}

/** Поисковая строка: приводится к безопасному шаблону LIKE. */
function searchPattern(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > 128) throw badRequest("Слишком длинный поисковый запрос");
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class AgentDirectoryService {
  constructor(
    private readonly db: DirectoryDatabase,
    private readonly guard: DeleteGuard,
  ) {}

  /**
   * Список агентов с числом conversations и незакончившихся ходов.
   *
   * Счётчик активных ходов стоит здесь не для красоты: именно он объясняет,
   * почему архивация или удаление сейчас откажет.
   */
  async agents(filter: DirectoryFilter): Promise<{ agents: AgentSummary[]; total: number }> {
    const limit = bounded(filter.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = bounded(filter.offset, 0, 100_000);
    const pattern = searchPattern(filter.query);
    const status = filter.status ? String(filter.status).slice(0, 32) : null;

    const { rows } = await this.db.query(
      `-- tenant: system — каталог агентов установки целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT l.agent_id, l.user_id, l.kind, l.agent_name, l.model, l.embedding_model,
              l.status, l.message_count, l.last_message_at,
              (SELECT count(*) FROM agent_conversations c WHERE c.agent_id = l.agent_id)
                AS conversations,
              (SELECT count(*) FROM turn_runs t
                WHERE t.agent_id = l.agent_id AND t.finished_at IS NULL) AS active_turns,
              count(*) OVER () AS total
         FROM agent_links l
        WHERE ($1::text IS NULL OR l.status = $1)
          AND ($2::text IS NULL OR l.agent_id ILIKE $2 OR coalesce(l.agent_name, '') ILIKE $2)
        ORDER BY l.last_message_at DESC NULLS LAST, l.agent_id
        LIMIT $3 OFFSET $4`,
      [status, pattern, limit, offset],
    );

    return {
      agents: rows.map(toAgent),
      total: rows.length > 0 ? Number(rows[0]!.total ?? rows.length) : 0,
    };
  }

  /** Карточка агента: связи, conversations и активные ходы. */
  async agent(agentId: string): Promise<{
    agent: AgentSummary;
    conversations: ConversationSummary[];
    activeTurns: Array<{ runId: string; state: string; conversationId: string | null }>;
  }> {
    const id = objectId(agentId, "идентификатор агента");
    const found = await this.agents({ query: id, limit: MAX_LIMIT });
    const agent = found.agents.find((row) => row.agentId === id);
    if (!agent) throw notFound(`агент ${id} не найден`);

    const [conversations, blocking] = await Promise.all([
      this.conversations({ agentId: id, limit: MAX_LIMIT }),
      this.guard.blockingTurnsForAgent(id),
    ]);

    return {
      agent,
      conversations: conversations.conversations,
      activeTurns: blocking.map((turn) => ({
        runId: turn.runId,
        state: turn.state,
        conversationId: turn.conversationId,
      })),
    };
  }

  async conversations(
    filter: DirectoryFilter,
  ): Promise<{ conversations: ConversationSummary[]; total: number }> {
    const limit = bounded(filter.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = bounded(filter.offset, 0, 100_000);
    const pattern = searchPattern(filter.query);
    const agentId = filter.agentId ? objectId(filter.agentId, "идентификатор агента") : null;
    const status = filter.status ? String(filter.status).slice(0, 32) : null;
    const purpose = filter.purpose ? String(filter.purpose).slice(0, 32) : null;

    const { rows } = await this.db.query(
      `-- tenant: system — каталог conversations установки целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT c.conversation_id, c.agent_id, c.user_id, c.title, c.status,
              c.message_count, c.started_at, c.last_message_at, c.archived_at,
              c.purpose,
              count(*) OVER () AS total
         FROM agent_conversations c
        WHERE ($1::text IS NULL OR c.agent_id = $1)
          AND ($2::text IS NULL OR c.status = $2)
          AND ($3::text IS NULL OR c.purpose = $3)
          AND ($4::text IS NULL OR c.conversation_id ILIKE $4 OR coalesce(c.title, '') ILIKE $4)
        ORDER BY c.last_message_at DESC NULLS LAST, c.conversation_id
        LIMIT $5 OFFSET $6`,
      [agentId, status, purpose, pattern, limit, offset],
    );

    return {
      conversations: rows.map(toConversation),
      total: rows.length > 0 ? Number(rows[0]!.total ?? rows.length) : 0,
    };
  }

  /**
   * Архивировать или вернуть conversation.
   *
   * Обратимое действие и единственное, которым администратор меняет
   * состояние conversation. Архивация во время незакончившегося хода
   * отклоняется тем же стражем, что и удаление: иначе ответ, который
   * человек ждёт прямо сейчас, ушёл бы в архивную ветку.
   */
  async setConversationStatus(
    conversationId: string,
    status: "active" | "archived",
  ): Promise<ConversationSummary> {
    const id = objectId(conversationId, "идентификатор conversation");
    if (status === "archived") await this.guard.assertConversationDeletable(id);

    const { rows } = await this.db.query(
      `-- tenant: system — административное изменение состояния чужой conversation; область администратора объявлена маршрутом и записана в аудит
       UPDATE agent_conversations
          SET status = $2,
              archived_at = CASE WHEN $2 = 'archived' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE conversation_id = $1
        RETURNING conversation_id, agent_id, user_id, title, status, message_count,
                  started_at, last_message_at, archived_at, purpose`,
      [id, status],
    );
    if (rows.length === 0) throw notFound(`conversation ${id} не найдена`);
    return toConversation(rows[0]!);
  }

  /**
   * Предпросмотр удаления: что мешает прямо сейчас.
   *
   * Само удаление отсюда не выполняется. Ответ отвечает на один вопрос —
   * «безопасно ли», — и называет ходы, из-за которых небезопасно.
   */
  async deletionPreview(kind: "agent" | "conversation", id: string): Promise<{
    kind: string;
    target: string;
    deletable: boolean;
    blockingTurns: Array<{ runId: string; state: string; conversationId: string | null }>;
    awaitingApproval: number;
    note: string;
  }> {
    const target = objectId(id, "идентификатор объекта");
    const turns = kind === "agent"
      ? await this.guard.blockingTurnsForAgent(target)
      : await this.guard.blockingTurnsForConversation(target);
    return {
      kind,
      target,
      deletable: turns.length === 0,
      blockingTurns: turns.map((turn) => ({
        runId: turn.runId,
        state: turn.state,
        conversationId: turn.conversationId,
      })),
      awaitingApproval: turns.filter((turn) => turn.state === "approval_pending").length,
      note: "Физическое удаление агента выполняется отдельно и необратимо: "
        + "административная панель ограничивается архивацией.",
    };
  }

  /**
   * Экспорт агента: связи, conversations и отпечатки блоков.
   *
   * Сообщений в снимке нет намеренно. Экспорт нужен для переноса и разбора
   * состава, а не для выгрузки переписки: та читается отдельным маршрутом
   * под отдельным грантом. Значений блоков тоже нет — только отпечатки,
   * которых достаточно, чтобы сверить два снимка.
   */
  async exportAgent(agentId: string): Promise<Record<string, unknown>> {
    const card = await this.agent(agentId);
    return {
      format: "evaself.agent-snapshot.v1",
      exported_at: new Date().toISOString(),
      agent: {
        agent_id: card.agent.agentId,
        user_id: card.agent.userId,
        kind: card.agent.kind,
        agent_name: card.agent.agentName,
        model: card.agent.model,
        embedding_model: card.agent.embeddingModel,
        status: card.agent.status,
      },
      conversations: card.conversations.map((row) => ({
        conversation_id: row.conversationId,
        purpose: row.purpose,
        title: row.title,
        status: row.status,
        message_count: row.messageCount,
      })),
    };
  }

  /**
   * Предпросмотр импорта: чем снимок отличается от того, что есть.
   *
   * Применения нет намеренно, и это не заглушка, а граница: создать агента
   * может только eva-agent-service через Letta SDK, а admin-api вторым
   * путём создания агентов не становится (инвариант 3). Поэтому импорт
   * здесь отвечает на вопрос «что разошлось», а восстановление недостающего
   * выполняет тот, кто имеет право создавать.
   */
  async importPreview(snapshot: unknown): Promise<{
    format: string;
    agentId: string;
    known: boolean;
    differences: Array<{ path: string; snapshot: string | null; current: string | null }>;
    missingConversations: string[];
    note: string;
  }> {
    const body = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot as Record<string, unknown>
      : {};
    if (body.format !== "evaself.agent-snapshot.v1") {
      throw badRequest("Неизвестный формат снимка: ожидается evaself.agent-snapshot.v1");
    }
    const agentBody = (body.agent ?? {}) as Record<string, unknown>;
    const agentId = objectId(agentBody.agent_id, "идентификатор агента");

    let current: Awaited<ReturnType<AgentDirectoryService["agent"]>> | null = null;
    try {
      current = await this.agent(agentId);
    } catch {
      current = null;
    }

    const differences: Array<{ path: string; snapshot: string | null; current: string | null }> = [];
    const compare = (path: string, from: unknown, to: unknown) => {
      const left = from === null || from === undefined ? null : String(from);
      const right = to === null || to === undefined ? null : String(to);
      if (left !== right) differences.push({ path, snapshot: left, current: right });
    };
    compare("agent.model", agentBody.model, current?.agent.model);
    compare("agent.embedding_model", agentBody.embedding_model, current?.agent.embeddingModel);
    compare("agent.status", agentBody.status, current?.agent.status);

    const snapshotConversations = Array.isArray(body.conversations) ? body.conversations : [];
    const known = new Set((current?.conversations ?? []).map((row) => row.conversationId));
    const missing = snapshotConversations
      .map((row) => String((row as { conversation_id?: unknown }).conversation_id ?? ""))
      .filter((id) => id && !known.has(id));

    return {
      format: "evaself.agent-snapshot.v1",
      agentId,
      known: current !== null,
      differences,
      missingConversations: missing,
      note: "Импорт показывает расхождения. Создание агентов и conversations "
        + "остаётся за eva-agent-service: второго пути создания агентов нет.",
    };
  }

  /** Состояние шести блоков агента: статусы и отпечатки, без значений. */
}

function toAgent(row: Record<string, unknown>): AgentSummary {
  return {
    agentId: String(row.agent_id ?? ""),
    userId: Number(row.user_id ?? 0),
    kind: String(row.kind ?? "eva"),
    agentName: row.agent_name === null || row.agent_name === undefined
      ? null
      : String(row.agent_name),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    embeddingModel: row.embedding_model === null || row.embedding_model === undefined
      ? null
      : String(row.embedding_model),
    status: String(row.status ?? "active"),
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: row.last_message_at === null || row.last_message_at === undefined
      ? null
      : String(row.last_message_at),
    conversations: Number(row.conversations ?? 0),
    activeTurns: Number(row.active_turns ?? 0),
  };
}

function toConversation(row: Record<string, unknown>): ConversationSummary {
  return {
    conversationId: String(row.conversation_id ?? ""),
    agentId: String(row.agent_id ?? ""),
    userId: Number(row.user_id ?? 0),
    purpose: row.purpose === null || row.purpose === undefined ? null : String(row.purpose),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    status: String(row.status ?? "active"),
    messageCount: Number(row.message_count ?? 0),
    startedAt: row.started_at === null || row.started_at === undefined
      ? null
      : String(row.started_at),
    lastMessageAt: row.last_message_at === null || row.last_message_at === undefined
      ? null
      : String(row.last_message_at),
    archivedAt: row.archived_at === null || row.archived_at === undefined
      ? null
      : String(row.archived_at),
  };
}
