/**
 * Контроль памяти пользователем.
 *
 * Четыре операции Mini App: посмотреть, подтвердить, исправить, удалить.
 * Все они пользовательские — область арендатора объявляется в каждой, и
 * ни одна не принимает идентификатор чужого узла: владелец берётся из
 * проверенной подписи Telegram, а не из тела запроса.
 *
 * Две вещи, которые делают эти операции честными:
 *
 *   Исправление создаёт НОВУЮ ВЕРСИЮ. Переписать значение на месте
 *   означало бы стереть, что человек считал правдой раньше, — то самое,
 *   ради предотвращения чего сделан шаг 15.
 *
 *   Удаление вычищает производные. Узел без доказательств, конфликтов,
 *   синонимов и записей объединения — это не удаление, а обломки, по
 *   которым факт восстанавливается. Embeddings и индексы поиска здесь
 *   тоже названы: своих строк у них пока нет (шаг 18), и когда появятся,
 *   чистка обязана идти отсюда же.
 */

import type { Database } from "../../db.js";
import { buildEvidence, type EvidenceRecord } from "../temporal/evidence.js";
import type { TemporalMemoryLayer } from "../temporal/index.js";

export interface MemoryItemView {
  id: number;
  nodeType: string;
  factKey: string | null;
  title: string;
  value: string | null;
  status: string;
  confidence: number;
  sensitivity: string;
  version: number;
  validFrom: string | null;
  validTo: string | null;
  eventAt: string | null;
  observedAt: string | null;
}

export class MemoryUserControl {
  constructor(
    private readonly db: Database,
    private readonly memory: TemporalMemoryLayer,
  ) {}

  get active(): boolean {
    return this.memory.enabled;
  }

  /** Что Ева про меня помнит: текущий снимок плюс кандидаты. */
  async list(userId: number, limit = 100): Promise<MemoryItemView[]> {
    return await this.db.withUserScope(
      { userId, label: "memory.control.list", inherit: true },
      async () => {
        const rows = await this.memory.queries.liveFacts(this.db, userId, { limit });
        return rows.map(toView);
      },
    );
  }

  /** История одного факта — все версии, ничего не скрыто. */
  async history(userId: number, factKey: string): Promise<Array<Record<string, unknown>>> {
    return await this.db.withUserScope(
      { userId, label: "memory.control.history", inherit: true },
      async () => {
        const versions = await this.memory.queries.factHistory(this.db, userId, factKey);
        return versions.map((version) => ({
          version: version.version,
          title: version.title,
          value: version.textContent,
          status: version.status,
          valid_from: iso(version.validFrom),
          valid_to: iso(version.validTo),
          event_at: iso(version.eventAt),
          observed_at: iso(version.observedAt),
          change_reason: version.changeReason,
          actor_type: version.actorType,
        }));
      },
    );
  }

  /** Откуда это взялось: доказательства факта. */
  async evidence(userId: number, nodeId: number): Promise<Array<Record<string, unknown>>> {
    return await this.db.withUserScope(
      { userId, label: "memory.control.evidence", inherit: true },
      async () => await this.memory.queries.evidenceFor(this.db, userId, nodeId),
    );
  }

  /**
   * Подтвердить кандидата.
   *
   * Подтверждение — это прямое утверждение человека, поэтому оно
   * записывается доказательством с высоким доверием и переводит узел в
   * активный статус. Подтвердить чужой узел нельзя: запрос ограничен
   * владельцем, и «не найдено» здесь честнее, чем «нет прав».
   */
  async confirm(userId: number, nodeId: number): Promise<boolean> {
    return await this.db.withUserScope(
      { userId, label: "memory.control.confirm", inherit: true },
      async () => await this.db.transaction(async (client) => {
        const { rows } = await client.query<{ id: string; current_version_id: string | null }>(
          `UPDATE memory_nodes
              SET status = 'active'
            WHERE user_id = $1 AND id = $2
              AND status IN ('candidate', 'quarantined', 'refuted')
            RETURNING id, current_version_id`,
          [userId, nodeId],
        );
        if (!rows[0]) return false;
        await client.query(
          `UPDATE memory_node_versions SET status = 'active'
            WHERE user_id = $1 AND node_id = $2 AND valid_to IS NULL`,
          [userId, nodeId],
        );
        await this.memory.versions.storeEvidence(
          client, userId, nodeId, null,
          [buildUserEvidence(nodeId, "confirm")],
          rows[0].current_version_id ? Number(rows[0].current_version_id) : null,
        );
        const confidence = await this.memory.versions.recomputeConfidence(client, userId, nodeId);
        await client.query(
          `UPDATE memory_nodes SET confidence = $3 WHERE user_id = $1 AND id = $2`,
          [userId, nodeId, confidence],
        );
        return true;
      }),
    );
  }

  /** Отклонить кандидата: он остаётся в истории со статусом `rejected`. */
  async reject(userId: number, nodeId: number): Promise<boolean> {
    return await this.db.withUserScope(
      { userId, label: "memory.control.reject", inherit: true },
      async () => await this.db.transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `UPDATE memory_nodes SET status = 'rejected'
            WHERE user_id = $1 AND id = $2 AND status IN ('candidate', 'quarantined')
            RETURNING id`,
          [userId, nodeId],
        );
        if (!rows[0]) return false;
        await client.query(
          `UPDATE memory_node_versions SET status = 'rejected'
            WHERE user_id = $1 AND node_id = $2 AND valid_to IS NULL`,
          [userId, nodeId],
        );
        return true;
      }),
    );
  }

  /**
   * Исправить факт.
   *
   * Создаётся новая версия через ту же temporal-запись, что и у любого
   * другого писателя: у прежней проставляется конец действительности,
   * новая ссылается на неё. Исправление человека — прямое утверждение,
   * поэтому новая версия сразу активна.
   */
  async correct(input: {
    userId: number;
    nodeId: number;
    title?: string;
    value?: string | null;
    validFrom?: Date;
  }): Promise<{ version: number; nodeId: number } | null> {
    return await this.db.withUserScope(
      { userId: input.userId, label: "memory.control.correct", inherit: true },
      async () => await this.db.transaction(async (client) => {
        const { rows } = await client.query<{
          node_type: string; canonical_key: string; title: string;
          text_content: string | null; sensitivity: string;
        }>(
          `SELECT node_type, canonical_key, title, text_content, sensitivity
             FROM memory_nodes
            WHERE user_id = $1 AND id = $2 AND status <> 'deleted'`,
          [input.userId, input.nodeId],
        );
        const node = rows[0];
        if (!node) return null;

        const result = await this.memory.versions.recordFact(client, {
          userId: input.userId,
          nodeType: node.node_type as never,
          canonicalKey: node.canonical_key,
          title: input.title?.trim() || node.title,
          textContent: input.value === undefined ? node.text_content : input.value,
          status: "active",
          sensitivity: node.sensitivity as "normal" | "sensitive" | "high",
          validFrom: input.validFrom ?? new Date(),
          evidence: [buildUserEvidence(input.nodeId, "correct", input.value ?? input.title ?? "")],
          changeReason: "исправление пользователем",
          actorType: "user",
          significance: "low",
        });
        return { version: result.version, nodeId: result.nodeId };
      }),
    );
  }

  /**
   * Удалить факт полностью.
   *
   * Удаление здесь настоящее: снимаются версии, доказательства,
   * конфликты, синонимы и записи объединения, а снимок остаётся
   * надгробием со статусом `deleted` — чтобы повторное извлечение того
   * же сообщения не воскресило факт молча.
   *
   * Порядок важен: производные снимаются ДО снимка, иначе внешний ключ
   * унесёт их каскадом раньше, чем мы сможем их сосчитать.
   */
  async remove(userId: number, nodeId: number): Promise<{
    versions: number;
    evidence: number;
    conflicts: number;
    aliases: number;
    merges: number;
  } | null> {
    return await this.db.withUserScope(
      { userId, label: "memory.control.delete", inherit: true },
      async () => await this.db.transaction(async (client) => {
        const owned = await client.query<{ id: string }>(
          `SELECT id FROM memory_nodes WHERE user_id = $1 AND id = $2`,
          [userId, nodeId],
        );
        if (!owned.rows[0]) return null;

        const evidence = await client.query(
          `DELETE FROM memory_evidence
            WHERE user_id = $1 AND subject_kind = 'node' AND node_id = $2`,
          [userId, nodeId],
        );
        const conflicts = await client.query(
          `DELETE FROM memory_conflicts WHERE user_id = $1 AND node_id = $2`,
          [userId, nodeId],
        );
        const aliases = await client.query(
          `DELETE FROM memory_entity_aliases WHERE user_id = $1 AND node_id = $2`,
          [userId, nodeId],
        );
        const merges = await client.query(
          `DELETE FROM memory_entity_merges
            WHERE user_id = $1 AND (source_node_id = $2 OR target_node_id = $2)`,
          [userId, nodeId],
        );
        // Связи с обеих сторон: висящая связь на удалённый узел — это
        // тот же факт, только выраженный ребром.
        await client.query(
          `DELETE FROM memory_edges
            WHERE user_id = $1 AND (from_node_id = $2 OR to_node_id = $2)`,
          [userId, nodeId],
        );
        // Снимок сначала отвязывается от версии, иначе внешний ключ не
        // даст снять версии.
        await client.query(
          `UPDATE memory_nodes SET current_version_id = NULL
            WHERE user_id = $1 AND id = $2`,
          [userId, nodeId],
        );
        const versions = await client.query(
          `DELETE FROM memory_node_versions WHERE user_id = $1 AND node_id = $2`,
          [userId, nodeId],
        );
        await client.query(
          `UPDATE memory_nodes
              SET status = 'deleted', text_content = NULL, content_json = '{}'::jsonb,
                  confidence = 0, valid_to = now()
            WHERE user_id = $1 AND id = $2`,
          [userId, nodeId],
        );
        return {
          versions: versions.rowCount ?? 0,
          evidence: evidence.rowCount ?? 0,
          conflicts: conflicts.rowCount ?? 0,
          aliases: aliases.rowCount ?? 0,
          merges: merges.rowCount ?? 0,
        };
      }),
    );
  }
}

/**
 * Мост между Mini App и контролем памяти.
 *
 * Единственная его работа — превратить проверенную Telegram-личность во
 * внутреннего пользователя. Делается это ЗДЕСЬ, а не в маршруте: тогда
 * ни один путь Mini App не имеет возможности передать чужой `user_id`,
 * потому что такого параметра у него просто нет.
 */
export class MiniAppMemoryGateway {
  constructor(
    private readonly db: Database,
    private readonly control: MemoryUserControl,
  ) {}

  async list(telegramId: number): Promise<unknown[]> {
    const userId = await this.owner(telegramId);
    return await this.control.list(userId);
  }

  async history(telegramId: number, nodeId: number): Promise<unknown[]> {
    const userId = await this.owner(telegramId);
    const { rows } = await this.db.withUserScope(
      { userId, label: "memory.control.factkey", inherit: true },
      async () => await this.db.query<{ fact_key: string | null }>(
        `SELECT fact_key FROM memory_nodes WHERE user_id = $1 AND id = $2`,
        [userId, nodeId],
      ),
    );
    const factKey = rows[0]?.fact_key;
    if (!factKey) return [];
    return await this.control.history(userId, factKey);
  }

  async decide(
    telegramId: number,
    nodeId: number,
    decision: "confirm" | "reject",
  ): Promise<boolean> {
    const userId = await this.owner(telegramId);
    return decision === "confirm"
      ? await this.control.confirm(userId, nodeId)
      : await this.control.reject(userId, nodeId);
  }

  async correct(
    telegramId: number,
    nodeId: number,
    patch: { title?: string; value?: string | null },
  ): Promise<{ version: number } | null> {
    const userId = await this.owner(telegramId);
    const result = await this.control.correct({ userId, nodeId, ...patch });
    return result ? { version: result.version } : null;
  }

  async remove(telegramId: number, nodeId: number): Promise<Record<string, number> | null> {
    const userId = await this.owner(telegramId);
    return await this.control.remove(userId, nodeId);
  }

  private async owner(telegramId: number): Promise<number> {
    const { rows } = await this.db.withUserScope(
      { telegramId, label: "memory.control.owner", inherit: true },
      async () => await this.db.query<{ id: string }>(
        `SELECT id FROM users WHERE telegram_id = $1`,
        [telegramId],
      ),
    );
    if (!rows[0]) throw new Error("Пользователь не найден");
    const userId = Number(rows[0].id);
    this.db.bindScopeUserId(userId);
    return userId;
  }
}

/**
 * Доказательство от человека.
 *
 * Отпечаток включает узел и действие, поэтому повторное подтверждение
 * одного и того же факта не добавляет второго независимого «да» —
 * то же правило, что и для повторного разбора сообщения.
 */
function buildUserEvidence(nodeId: number, action: string, excerpt = ""): EvidenceRecord {
  return buildEvidence({
    sourceType: "user_confirmation",
    sourceId: `${action}:${nodeId}`,
    messageId: null,
    sourceAt: new Date(),
    support: "supports",
    confidence: 1,
    excerpt: excerpt || action,
  });
}

function toView(row: Record<string, unknown>): MemoryItemView {
  return {
    id: Number(row.id),
    nodeType: String(row.node_type),
    factKey: row.fact_key === null || row.fact_key === undefined ? null : String(row.fact_key),
    title: String(row.title),
    value: row.text_content === null || row.text_content === undefined ? null : String(row.text_content),
    status: String(row.status),
    confidence: Number(row.confidence),
    sensitivity: String(row.sensitivity),
    version: Number(row.version),
    validFrom: iso(row.valid_from),
    validTo: iso(row.valid_to),
    eventAt: iso(row.event_at),
    observedAt: iso(row.observed_at),
  };
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
