/**
 * Версии фактов.
 *
 * Правило шага: новая версия НЕ изменяет и НЕ удаляет предыдущую. У
 * текущей проставляется конец действительности, создаётся новая версия
 * со ссылкой на замещённую, сохраняется доказательство, а актуальный
 * снимок обновляется одной транзакцией.
 *
 * Разделение ролей между таблицами:
 *
 *   memory_nodes          — актуальный снимок, одна строка на факт.
 *                           Через него ходит весь существующий код.
 *   memory_node_versions  — все версии, включая текущую. Ничего никогда
 *                           не переписывает, кроме собственного valid_to.
 *
 * Противоречие здесь не разрешается автоматически (требование 6): смена
 * значения и прямое опровержение записываются в `memory_conflicts`, а
 * значимые — со статусом `awaiting_user`.
 */

import { createHash } from "node:crypto";

import type { GraphNodeType, GraphQueryable } from "../graph-repository.js";
import {
  aggregateConfidence,
  buildEvidence,
  type EvidenceInput,
  type EvidenceRecord,
} from "./evidence.js";
import {
  assertTransition,
  isInference,
  type TemporalStatus,
} from "./status.js";

export type MemoryActor = "user" | "curator" | "system" | "admin";

export interface FactInput {
  userId: number;
  nodeType: GraphNodeType;
  /** Ключ снимка: по нему работает существующий upsert графа. */
  canonicalKey: string;
  /** Устойчивая личность факта между версиями. По умолчанию — снимок. */
  factKey?: string;
  title: string;
  textContent?: string | null;
  contentJson?: Record<string, unknown>;
  status?: TemporalStatus;
  sensitivity?: "normal" | "sensitive" | "high";
  /** Начало действительности В ЖИЗНИ пользователя. */
  validFrom?: Date;
  validTo?: Date | null;
  /** Когда событие произошло. */
  eventAt?: Date | null;
  /** Когда Ева об этом узнала. */
  observedAt?: Date;
  evidence: readonly EvidenceInput[];
  changeReason: string;
  actorType: MemoryActor;
  /** Значимость возможного конфликта. Решает вызывающий, не модель. */
  significance?: "low" | "medium" | "high";
}

export type FactOutcome =
  | "created"
  | "versioned"
  | "evidence_added"
  | "unchanged";

export interface FactResult {
  nodeId: number;
  versionId: number;
  version: number;
  status: TemporalStatus;
  confidence: number;
  outcome: FactOutcome;
  /** Идентификатор записанного конфликта, если он возник. */
  conflictId: number | null;
  /** Сколько доказательств оказалось новыми, а сколько уже было. */
  evidenceAdded: number;
  evidenceDeduplicated: number;
}

interface SnapshotRow {
  id: string;
  fact_key: string | null;
  version: number | string;
  status: string;
  title: string;
  text_content: string | null;
  content_json: Record<string, unknown>;
  sensitivity: string;
  current_version_id: string | null;
  valid_from: Date | null;
}

export class TemporalMemoryRepository {
  /**
   * Записать факт.
   *
   * Вызывается ВНУТРИ транзакции вызывающего: снимок, версия и
   * доказательство обязаны попасть в базу вместе или не попасть вовсе.
   * Разорванная запись оставила бы снимок, указывающий на несуществующую
   * версию, — а это ровно та потеря истории, ради которой шаг делается.
   */
  async recordFact(client: GraphQueryable, input: FactInput): Promise<FactResult> {
    const now = input.observedAt ?? new Date();
    const validFrom = input.validFrom ?? now;
    const factKey = input.factKey ?? input.canonicalKey;
    const status = input.status ?? defaultStatus(input);
    const evidence = input.evidence.map(buildEvidence);

    const snapshot = await this.snapshot(client, input.userId, input.nodeType, input.canonicalKey);
    if (!snapshot) {
      return await this.createFirstVersion(client, input, {
        now, validFrom, factKey, status, evidence,
      });
    }

    const nodeId = Number(snapshot.id);
    const stored = await this.storeEvidence(client, input.userId, nodeId, null, evidence);
    const previousStatus = normalizeStatus(snapshot.status);
    const sameValue = valueFingerprint(snapshot) === valueFingerprint({
      title: input.title,
      text_content: input.textContent ?? null,
      content_json: input.contentJson ?? {},
    });

    if (sameValue && previousStatus === status) {
      // Значение не изменилось: новая версия не создаётся, но набор
      // доказательств мог пополниться — тогда пересчитывается уверенность.
      const confidence = await this.recomputeConfidence(client, input.userId, nodeId);
      await client.query(
        `UPDATE memory_nodes
            SET confidence = $3, observed_at = COALESCE(observed_at, $4)
          WHERE user_id = $1 AND id = $2`,
        [input.userId, nodeId, confidence, now],
      );
      return {
        nodeId,
        versionId: Number(snapshot.current_version_id ?? 0),
        version: Number(snapshot.version),
        status: previousStatus,
        confidence,
        outcome: stored.added > 0 ? "evidence_added" : "unchanged",
        conflictId: null,
        evidenceAdded: stored.added,
        evidenceDeduplicated: stored.deduplicated,
      };
    }

    assertTransition(previousStatus, status === previousStatus ? status : "superseded");
    return await this.appendVersion(client, input, snapshot, {
      now, validFrom, factKey, status, evidence, stored, previousStatus,
    });
  }

  /**
   * Пометить версию опровергнутой.
   *
   * Опровержение не удаляет факт и не подставляет вместо него другой:
   * оно фиксирует, что доказательство против существует, и открывает
   * конфликт. Что считать правдой — решает человек, а не эта функция.
   */
  async refute(
    client: GraphQueryable,
    input: {
      userId: number;
      nodeId: number;
      evidence: readonly EvidenceInput[];
      reason: string;
      actorType: MemoryActor;
      significance?: "low" | "medium" | "high";
    },
  ): Promise<{ conflictId: number; confidence: number }> {
    const evidence = input.evidence.map((item) => buildEvidence({ ...item, support: "refutes" }));
    await this.storeEvidence(client, input.userId, input.nodeId, null, evidence);
    const confidence = await this.recomputeConfidence(client, input.userId, input.nodeId);
    const { rows } = await client.query<{ id: string; fact_key: string | null; current_version_id: string | null }>(
      `UPDATE memory_nodes
          SET status = 'refuted', confidence = $3
        WHERE user_id = $1 AND id = $2
        RETURNING id, fact_key, current_version_id`,
      [input.userId, input.nodeId, confidence],
    );
    const row = rows[0];
    const conflictId = await this.openConflict(client, {
      userId: input.userId,
      nodeId: input.nodeId,
      factKey: row?.fact_key ?? String(input.nodeId),
      refutedVersionId: row?.current_version_id ? Number(row.current_version_id) : null,
      winningVersionId: null,
      kind: "contradiction",
      significance: input.significance ?? "high",
      detail: { reason: input.reason.slice(0, 400), actor: input.actorType },
    });
    return { conflictId, confidence };
  }

  /** Открытые конфликты пользователя — вход для отчёта и для вопроса человеку. */
  async openConflicts(
    client: GraphQueryable,
    userId: number,
    limit = 50,
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await client.query(
      `SELECT id, fact_key, node_id, kind, significance, status, detail, created_at
         FROM memory_conflicts
        WHERE user_id = $1 AND status IN ('open', 'awaiting_user')
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows as Array<Record<string, unknown>>;
  }

  /**
   * Записать доказательства.
   *
   * Возвращает раздельно вставленные и отброшенные: разница между
   * «пришло новое подтверждение» и «тот же текст прочитан второй раз»
   * видна вызывающему, а не теряется в счётчике строк.
   */
  async storeEvidence(
    client: GraphQueryable,
    userId: number,
    nodeId: number | null,
    edgeId: number | null,
    evidence: readonly EvidenceRecord[],
    versionId: number | null = null,
  ): Promise<{ added: number; deduplicated: number }> {
    let added = 0;
    for (const item of evidence) {
      const result = await client.query(
        `INSERT INTO memory_evidence (
           user_id, subject_kind, node_id, edge_id, version_id, source_type,
           source_id, message_id, episode_id, source_at, event_at, support,
           confidence, content_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT DO NOTHING`,
        [
          userId,
          nodeId === null ? "edge" : "node",
          nodeId,
          edgeId,
          versionId,
          item.sourceType.slice(0, 100),
          item.sourceId ?? null,
          item.messageId ?? null,
          item.episodeId ?? null,
          item.sourceAt ?? null,
          item.eventAt ?? null,
          item.support,
          item.confidence,
          item.contentHash,
        ],
      );
      added += result.rowCount ?? 0;
    }
    return { added, deduplicated: evidence.length - added };
  }

  /** Уверенность считает код по различным доказательствам, а не модель. */
  async recomputeConfidence(
    client: GraphQueryable,
    userId: number,
    nodeId: number,
  ): Promise<number> {
    const { rows } = await client.query<{
      source_type: string;
      support: string;
      confidence: string;
      content_hash: string;
    }>(
      `SELECT source_type, support, confidence, content_hash
         FROM memory_evidence
        WHERE user_id = $1 AND subject_kind = 'node' AND node_id = $2`,
      [userId, nodeId],
    );
    return aggregateConfidence(rows.map((row) => ({
      sourceType: row.source_type,
      support: row.support as EvidenceRecord["support"],
      confidence: Number(row.confidence),
      contentHash: row.content_hash,
    })));
  }

  private async snapshot(
    client: GraphQueryable,
    userId: number,
    nodeType: GraphNodeType,
    canonicalKey: string,
  ): Promise<SnapshotRow | null> {
    const { rows } = await client.query<SnapshotRow>(
      `SELECT id, fact_key, version, status, title, text_content, content_json,
              sensitivity, current_version_id, valid_from
         FROM memory_nodes
        WHERE user_id = $1 AND node_type = $2 AND canonical_key = $3`,
      [userId, nodeType, canonicalKey],
    );
    return rows[0] ?? null;
  }

  private async createFirstVersion(
    client: GraphQueryable,
    input: FactInput,
    ctx: {
      now: Date;
      validFrom: Date;
      factKey: string;
      status: TemporalStatus;
      evidence: EvidenceRecord[];
    },
  ): Promise<FactResult> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memory_nodes (
         user_id, node_type, canonical_key, title, text_content, content_json,
         status, confidence, sensitivity, source_type, source_id, source_quote,
         fact_key, version, valid_from, valid_to, observed_at, event_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12,
                 $13, 1, $14, $15, $16, $17)
       RETURNING id`,
      [
        input.userId,
        input.nodeType,
        input.canonicalKey,
        input.title,
        input.textContent ?? null,
        JSON.stringify(input.contentJson ?? {}),
        ctx.status,
        aggregateConfidence(ctx.evidence),
        input.sensitivity ?? "normal",
        ctx.evidence[0]?.sourceType ?? "system",
        ctx.evidence[0]?.sourceId ?? null,
        ctx.evidence[0]?.excerpt ?? null,
        ctx.factKey,
        ctx.validFrom,
        input.validTo ?? null,
        input.observedAt ?? ctx.now,
        input.eventAt ?? null,
      ],
    );
    const nodeId = Number(rows[0]!.id);
    const versionId = await this.insertVersion(client, input, nodeId, 1, null, ctx);
    const stored = await this.storeEvidence(
      client, input.userId, nodeId, null, ctx.evidence, versionId,
    );
    const confidence = await this.recomputeConfidence(client, input.userId, nodeId);
    await client.query(
      `UPDATE memory_nodes SET current_version_id = $3, confidence = $4
        WHERE user_id = $1 AND id = $2`,
      [input.userId, nodeId, versionId, confidence],
    );
    return {
      nodeId,
      versionId,
      version: 1,
      status: ctx.status,
      confidence,
      outcome: "created",
      conflictId: null,
      evidenceAdded: stored.added,
      evidenceDeduplicated: stored.deduplicated,
    };
  }

  private async appendVersion(
    client: GraphQueryable,
    input: FactInput,
    snapshot: SnapshotRow,
    ctx: {
      now: Date;
      validFrom: Date;
      factKey: string;
      status: TemporalStatus;
      evidence: EvidenceRecord[];
      stored: { added: number; deduplicated: number };
      previousStatus: TemporalStatus;
    },
  ): Promise<FactResult> {
    const nodeId = Number(snapshot.id);
    const nextVersion = Number(snapshot.version) + 1;
    const previousVersionId = snapshot.current_version_id
      ? Number(snapshot.current_version_id)
      : null;

    // Предыдущая версия не изменяется по существу: у неё проставляется
    // только конец действительности и признак замещения.
    if (previousVersionId) {
      await client.query(
        `UPDATE memory_node_versions
            SET valid_to = COALESCE(valid_to, $3), status = 'superseded'
          WHERE user_id = $1 AND id = $2 AND status <> 'superseded'`,
        [input.userId, previousVersionId, ctx.validFrom],
      );
    }

    const versionId = await this.insertVersion(
      client, input, nodeId, nextVersion, previousVersionId, ctx,
    );
    await this.storeEvidence(client, input.userId, nodeId, null, ctx.evidence, versionId);
    const confidence = await this.recomputeConfidence(client, input.userId, nodeId);

    await client.query(
      `UPDATE memory_nodes
          SET title = $3, text_content = $4, content_json = $5::jsonb,
              status = $6, confidence = $7, sensitivity = $8,
              fact_key = $9, version = $10, current_version_id = $11,
              valid_from = $12, valid_to = $13, observed_at = $14, event_at = $15
        WHERE user_id = $1 AND id = $2`,
      [
        input.userId,
        nodeId,
        input.title,
        input.textContent ?? null,
        JSON.stringify(input.contentJson ?? {}),
        ctx.status,
        confidence,
        input.sensitivity ?? snapshot.sensitivity,
        ctx.factKey,
        nextVersion,
        versionId,
        ctx.validFrom,
        input.validTo ?? null,
        input.observedAt ?? ctx.now,
        input.eventAt ?? null,
      ],
    );

    const conflictId = await this.openConflict(client, {
      userId: input.userId,
      nodeId,
      factKey: ctx.factKey,
      refutedVersionId: previousVersionId,
      winningVersionId: versionId,
      kind: "value_changed",
      significance: input.significance ?? "low",
      detail: { from_version: Number(snapshot.version), to_version: nextVersion },
    });

    return {
      nodeId,
      versionId,
      version: nextVersion,
      status: ctx.status,
      confidence,
      outcome: "versioned",
      conflictId,
      evidenceAdded: ctx.stored.added,
      evidenceDeduplicated: ctx.stored.deduplicated,
    };
  }

  private async insertVersion(
    client: GraphQueryable,
    input: FactInput,
    nodeId: number,
    version: number,
    supersedesVersionId: number | null,
    ctx: { now: Date; validFrom: Date; factKey: string; status: TemporalStatus },
  ): Promise<number> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memory_node_versions (
         user_id, node_id, fact_key, version, supersedes_version_id, title,
         text_content, content_json, status, confidence, sensitivity,
         valid_from, valid_to, event_at, observed_at, change_reason, actor_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        input.userId,
        nodeId,
        ctx.factKey,
        version,
        supersedesVersionId,
        input.title,
        input.textContent ?? null,
        JSON.stringify(input.contentJson ?? {}),
        ctx.status,
        0,
        input.sensitivity ?? "normal",
        ctx.validFrom,
        input.validTo ?? null,
        input.eventAt ?? null,
        input.observedAt ?? ctx.now,
        input.changeReason.slice(0, 200),
        input.actorType,
      ],
    );
    return Number(rows[0]!.id);
  }

  private async openConflict(
    client: GraphQueryable,
    input: {
      userId: number;
      nodeId: number;
      factKey: string;
      refutedVersionId: number | null;
      winningVersionId: number | null;
      kind: "value_changed" | "contradiction" | "overlap" | "duplicate";
      significance: "low" | "medium" | "high";
      detail: Record<string, unknown>;
    },
  ): Promise<number> {
    // Значимый конфликт уходит человеку, незначимый остаётся в отчёте.
    // Разрешать его автоматически запрещено требованием 6 шага.
    const status = input.significance === "low" ? "open" : "awaiting_user";
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memory_conflicts (
         user_id, fact_key, node_id, refuted_version_id, winning_version_id,
         kind, significance, status, detail
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        input.userId,
        input.factKey,
        input.nodeId,
        input.refutedVersionId,
        input.winningVersionId,
        input.kind,
        input.significance,
        status,
        JSON.stringify(input.detail),
      ],
    );
    return Number(rows[0]!.id);
  }
}

/**
 * Отпечаток значения факта.
 *
 * Сравнивать версии по «похожести» нельзя: тогда исправление опечатки
 * станет новой версией, а смена работы — нет. Здесь сравнивается ровно
 * то, что видит пользователь: заголовок, текст и структурированное
 * содержимое.
 */
export function valueFingerprint(value: {
  title: string;
  text_content: string | null;
  content_json: Record<string, unknown>;
}): string {
  const payload = [
    value.title.replace(/\s+/gu, " ").trim(),
    (value.text_content ?? "").replace(/\s+/gu, " ").trim(),
    stableJson(value.content_json ?? {}),
  ].join(" ");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * Статус по умолчанию.
 *
 * Вывод модели сам по себе фактом не становится: без прямого
 * утверждения человека новый факт рождается кандидатом. Это то же
 * правило, что требование 6 шага 16, но применённое на уровень ниже —
 * чтобы оно действовало и для писателей, которые Curator не проходят.
 */
function defaultStatus(input: FactInput): TemporalStatus {
  const inferred = input.evidence.every((item) => isInference(item.sourceType));
  if (inferred) return "candidate";
  return input.sensitivity && input.sensitivity !== "normal" ? "candidate" : "active";
}

function normalizeStatus(value: string): TemporalStatus {
  switch (value) {
    // Прежний словарь графа отображается в temporal-словарь: снимок мог
    // быть создан старым кодом до переноса.
    case "unconfirmed": return "candidate";
    case "disputed": return "refuted";
    case "archived": return "forgotten";
    case "active":
    case "candidate":
    case "superseded":
    case "refuted":
    case "rejected":
    case "forgotten":
    case "deleted":
    case "quarantined":
      return value;
    default: return "candidate";
  }
}
