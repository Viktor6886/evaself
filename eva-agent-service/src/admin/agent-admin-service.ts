/**
 * Раздел «Агенты» административной панели: список, карточка, создание,
 * изменение и удаление.
 *
 * Единственное, чего здесь нет и не будет, — собственного механизма
 * создания агентов. Создать агента вправе только eva-agent-service через
 * официальный Letta Agent SDK (инвариант 3), поэтому каждое изменяющее
 * действие уходит по внутреннему API туда же, куда идёт обычная
 * регистрация человека в Telegram:
 *
 *   создание   → POST /v1/users/ensure      — тот же путь, каким агент
 *                заводится при первом сообщении: `letta.createAgent()`,
 *                `createConversation()`, `saveAgentLink()`. Второго
 *                пути создания не появляется;
 *   изменение  → PATCH /v1/sdk/agents/:id   — запись идёт в Letta, и
 *                только после неё зеркало в `agent_links` приводится к
 *                тому же значению;
 *   удаление   → DELETE /v1/sdk/agents/:id  — там же живут `DeleteGuard`
 *                и архивация связки.
 *
 * Читающая часть остаётся на PostgreSQL: каталог агентов установки — это
 * `agent_links` и `agent_conversations` (инвариант 1), и `AgentDirectoryService`
 * уже умеет их читать вместе со счётчиком незакончившихся ходов. Здесь он
 * дополняется владельцем: раздел обязан отвечать на вопрос «чей это агент»,
 * а сам каталог знает только `user_id`.
 *
 * Содержимого переписки и значений memory block ни один метод не
 * возвращает: состояния, счётчики и отпечатки — да, тексты — нет.
 */

import type pg from "pg";

import { AgentDirectoryService, type AgentSummary } from "./agent-directory.js";
import { AdminApiError, adminBadRequest, adminNotFound } from "./errors.js";
import type { InternalAgentClient } from "./provider-service.js";

export interface AgentOwner {
  userId: number;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  isBlocked: boolean;
  plan: string;
  subscriptionStatus: string;
}

export interface AgentListItem extends AgentSummary {
  owner: AgentOwner | null;
  personaVersion: string | null;
  canonicalSyncStatus: string | null;
  canonicalSyncAt: string | null;
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Поля, которые панель разрешает менять. Больше SDK и не принимает. */
const PATCH_FIELDS = [
  "name",
  "description",
  "model",
  "tags",
  "hidden",
  "context_window",
] as const;

function agentId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!ID_RE.test(text)) throw adminBadRequest("Некорректный идентификатор агента");
  return text;
}

export class AdminAgentService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly directory: AgentDirectoryService,
    private readonly agent: InternalAgentClient,
  ) {}

  /**
   * Список агентов с владельцем и состоянием синхронизации персоны.
   *
   * Владелец подтягивается одним запросом по уже найденным строкам, а не
   * запросом на агента: тридцать агентов на экране — это тридцать
   * обращений к базе там, где хватает одного.
   */
  async list(filter: {
    query?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ agents: AgentListItem[]; total: number }> {
    const found = await this.directory.agents(filter);
    const ids = found.agents.map((item) => item.agentId);
    const [owners, meta] = await Promise.all([
      this.owners(found.agents.map((item) => item.userId)),
      this.syncMeta(ids),
    ]);
    return {
      total: found.total,
      agents: found.agents.map((item) => ({
        ...item,
        owner: owners.get(item.userId) ?? null,
        personaVersion: meta.get(item.agentId)?.personaVersion ?? null,
        canonicalSyncStatus: meta.get(item.agentId)?.status ?? null,
        canonicalSyncAt: meta.get(item.agentId)?.at ?? null,
      })),
    };
  }

  /**
   * Карточка: каталог, владелец, conversations, активные ходы и живое
   * состояние агента в Letta.
   *
   * Живая часть необязательна намеренно: App Server может быть недоступен,
   * и тогда карточка обязана показать то, что знает PostgreSQL, вместе с
   * причиной, по которой живого состояния нет. Пустая страница вместо
   * карточки — худший из исходов.
   */
  async get(rawId: string): Promise<Record<string, unknown>> {
    const id = agentId(rawId);
    const card = await this.directory.agent(id);
    const [owners, meta] = await Promise.all([
      this.owners([card.agent.userId]),
      this.syncMeta([id]),
    ]);

    let live: unknown = null;
    let liveError: string | null = null;
    try {
      const payload = await this.agent.request(`/v1/sdk/agents/${encodeURIComponent(id)}`);
      live = (payload as { agent?: unknown } | null)?.agent ?? null;
    } catch (error) {
      liveError = error instanceof AdminApiError ? error.code : "agent_runtime_error";
    }

    return {
      agent: {
        ...card.agent,
        owner: owners.get(card.agent.userId) ?? null,
        personaVersion: meta.get(id)?.personaVersion ?? null,
        canonicalSyncStatus: meta.get(id)?.status ?? null,
        canonicalSyncAt: meta.get(id)?.at ?? null,
      },
      conversations: card.conversations,
      active_turns: card.activeTurns,
      live,
      live_error: liveError,
    };
  }

  /**
   * Создать личного агента человеку.
   *
   * Ровно тот же путь, что и при первом сообщении в Telegram: внутренний
   * маршрут `/v1/users/ensure` заводит агента через Letta Agent SDK,
   * открывает conversation и сохраняет связку. Идемпотентно: у человека,
   * у которого агент уже есть, ничего не создаётся — возвращается
   * существующий.
   */
  async create(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const telegramId = this.telegramIdOf(input);
    const payload = await this.agent.request("/v1/users/ensure", {
      method: "POST",
      body: JSON.stringify({
        telegram_id: telegramId,
        ...(typeof input.username === "string" ? { username: input.username } : {}),
        ...(typeof input.first_name === "string" ? { first_name: input.first_name } : {}),
        ...(typeof input.last_name === "string" ? { last_name: input.last_name } : {}),
        create_agent: true,
      }),
    });
    const agent = (payload as { agent?: { agent_id?: unknown } } | null)?.agent ?? null;
    const created = Boolean((payload as { agent_created?: unknown } | null)?.agent_created);
    if (!agent?.agent_id) {
      throw new AdminApiError(
        "agent_not_created",
        "Agent Runtime не вернул агента: проверьте доступность Letta App Server",
        502,
      );
    }
    return {
      agent_id: String(agent.agent_id),
      created,
      telegram_id: telegramId,
      user: (payload as { user?: unknown } | null)?.user ?? null,
    };
  }

  /**
   * Изменить агента.
   *
   * Сначала Letta, потом зеркало. Обратный порядок оставлял бы в базе
   * значение, которого в Letta нет, — и никто бы не знал, где правда.
   */
  async update(rawId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = agentId(rawId);
    // `system` не принимается намеренно: системный промпт — канонический
    // текст всей установки, он правится в разделе «Персона и промпт» и
    // раскатывается на всех агентов сразу. Правка одного агента здесь
    // означала бы установку, где у каждого агента свой промпт.
    //
    // Проверяется до сборки patch: иначе запрос с одним только `system`
    // отказывал бы «нечего менять», и объяснение, куда идти за правкой
    // промпта, до администратора не доходило.
    if (input.system !== undefined) {
      throw adminBadRequest(
        "Системный промпт правится в разделе «Персона и промпт»: он общий для всех агентов",
      );
    }
    const patch: Record<string, unknown> = {};
    for (const field of PATCH_FIELDS) {
      if (input[field] !== undefined) patch[field] = input[field];
    }
    if (Object.keys(patch).length === 0) throw adminBadRequest("Нечего менять");

    const payload = await this.agent.request(`/v1/sdk/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });

    // Зеркало в PostgreSQL: те же поля, что показывает список. Пишется
    // после успешной записи в Letta и только они — `agent_links` остаётся
    // отражением, а не вторым источником истины.
    if (typeof patch.name === "string" || typeof patch.model === "string") {
      await this.pool.query(
        `-- tenant: system — административное изменение чужого агента; область объявлена маршрутом и записана в аудит
         UPDATE agent_links
            SET agent_name = COALESCE($2::text, agent_name),
                model = COALESCE($3::text, model),
                updated_at = now()
          WHERE agent_id = $1`,
        [
          id,
          typeof patch.name === "string" ? patch.name : null,
          typeof patch.model === "string" ? patch.model : null,
        ],
      );
    }
    return { agent: (payload as { agent?: unknown } | null)?.agent ?? null, patched: Object.keys(patch) };
  }

  /**
   * Удалить агента.
   *
   * Необратимо: вместе с агентом уходят его conversations, история и
   * блоки. Поэтому подтверждение — идентификатор агента, а не булев флаг,
   * и решение принимает `DeleteGuard` на стороне runtime: незакончившийся
   * ход или ожидающее подтверждение означают, что человек прямо сейчас
   * ждёт ответа. Связка в `agent_links` архивируется там же, одной
   * операцией с удалением.
   */
  async remove(rawId: string, confirm: unknown): Promise<{ deleted: true; agent_id: string }> {
    const id = agentId(rawId);
    if (String(confirm ?? "") !== id) {
      throw adminBadRequest(`Удаление требует поле confirm со значением ${id}`);
    }
    const preview = await this.directory.deletionPreview("agent", id);
    if (!preview.deletable) {
      throw new AdminApiError(
        "agent_busy",
        `У агента ${preview.blockingTurns.length} незакончившихся ход(ов): удаление отклонено`,
        409,
        { blocking_turns: preview.blockingTurns },
      );
    }
    await this.agent.request(
      `/v1/sdk/agents/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return { deleted: true, agent_id: id };
  }

  /** Что мешает удалить прямо сейчас. Ничего не меняет. */
  async deletionPreview(rawId: string) {
    return await this.directory.deletionPreview("agent", agentId(rawId));
  }

  private telegramIdOf(input: Record<string, unknown>): number {
    const raw = input.telegram_id ?? input.telegramId;
    const parsed = Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw adminBadRequest("telegram_id — целое положительное число");
    }
    return parsed;
  }

  private async owners(userIds: number[]): Promise<Map<number, AgentOwner>> {
    const unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return new Map();
    const { rows } = await this.pool.query<{
      id: string; telegram_id: string; username: string | null; first_name: string | null;
      is_blocked: boolean; plan: string; subscription_status: string;
    }>(
      `-- tenant: system — раздел «Агенты» админки показывает владельцев всех агентов; доступ под ролью и записью аудита
       SELECT id, telegram_id, username, first_name, is_blocked, plan, subscription_status
         FROM v_user_overview
        WHERE id = ANY($1::bigint[])`,
      [unique],
    );
    return new Map(rows.map((row) => [Number(row.id), {
      userId: Number(row.id),
      telegramId: String(row.telegram_id),
      username: row.username,
      firstName: row.first_name,
      isBlocked: row.is_blocked,
      plan: row.plan,
      subscriptionStatus: row.subscription_status,
    }]));
  }

  /**
   * Отметки доставки канонического текста.
   *
   * Это отметки развёртывания в `agent_links.meta`, а не копия memory
   * block: значения блоков живут только в Letta (инвариант 12). По ним
   * видно, до кого новая персона уже доехала.
   */
  private async syncMeta(ids: string[]): Promise<Map<string, {
    personaVersion: string | null; status: string | null; at: string | null;
  }>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<{
      agent_id: string; persona_version: string | null;
      sync_status: string | null; sync_at: string | null;
    }>(
      `-- tenant: system — состояние доставки канонической персоны по всем агентам; область объявлена маршрутом и записана в аудит
       SELECT agent_id,
              meta ->> 'persona_version' AS persona_version,
              meta ->> 'canonical_context_sync_status' AS sync_status,
              meta ->> 'canonical_context_sync_at' AS sync_at
         FROM agent_links
        WHERE agent_id = ANY($1::text[])`,
      [ids],
    );
    return new Map(rows.map((row) => [row.agent_id, {
      personaVersion: row.persona_version,
      status: row.sync_status,
      at: row.sync_at,
    }]));
  }
}

export function requireAgentDirectory(
  directory: AgentDirectoryService | undefined,
): AgentDirectoryService {
  if (!directory) throw adminNotFound("Каталог агентов недоступен");
  return directory;
}
