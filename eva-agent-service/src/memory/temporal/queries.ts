/**
 * Запросы к temporal-памяти.
 *
 * Пять видов, названных требованием 3 шага: текущий факт, факт на
 * указанную дату, полная история факта, изменения за период и состояние
 * сущности на выбранную дату.
 *
 * Все они читают `memory_node_versions`, а не снимок: снимок знает
 * только «сейчас», и вопрос «что было в марте» по нему не отвечается.
 * Единственное исключение — `currentFact`, который для скорости берёт
 * снимок: это тот же ответ, только без соединения.
 *
 * Граница арендатора объявлена в каждом запросе: `user_id = $1` стоит
 * первым условием везде, включая соединения.
 */

import type { GraphNodeType, GraphQueryable } from "../graph-repository.js";
import { LIVE_STATUSES, type TemporalStatus } from "./status.js";

export interface FactVersion {
  versionId: number;
  nodeId: number;
  factKey: string;
  version: number;
  supersedesVersionId: number | null;
  title: string;
  textContent: string | null;
  contentJson: Record<string, unknown>;
  status: TemporalStatus;
  confidence: number;
  sensitivity: string;
  validFrom: Date;
  validTo: Date | null;
  eventAt: Date | null;
  observedAt: Date;
  recordedAt: Date;
  changeReason: string;
  actorType: string;
}

interface VersionRow {
  id: string;
  node_id: string;
  fact_key: string;
  version: number | string;
  supersedes_version_id: string | null;
  title: string;
  text_content: string | null;
  content_json: Record<string, unknown>;
  status: string;
  confidence: string;
  sensitivity: string;
  valid_from: Date;
  valid_to: Date | null;
  event_at: Date | null;
  observed_at: Date;
  recorded_at: Date;
  change_reason: string;
  actor_type: string;
}

const VERSION_COLUMNS = `id, node_id, fact_key, version, supersedes_version_id,
       title, text_content, content_json, status, confidence, sensitivity,
       valid_from, valid_to, event_at, observed_at, recorded_at,
       change_reason, actor_type`;

export class TemporalMemoryQueries {
  /** Текущий факт: то, что действует сейчас. */
  async currentFact(
    client: GraphQueryable,
    userId: number,
    factKey: string,
  ): Promise<FactVersion | null> {
    const { rows } = await client.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM memory_node_versions
        WHERE user_id = $1 AND fact_key = $2
          AND valid_to IS NULL
          AND status = ANY($3::text[])
        ORDER BY version DESC
        LIMIT 1`,
      [userId, factKey, [...LIVE_STATUSES]],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  /**
   * Факт на указанную дату.
   *
   * Дата сравнивается со ВРЕМЕНЕМ ДЕЙСТВИТЕЛЬНОСТИ, а не со временем
   * записи: вопрос «где он работал в марте» — про жизнь пользователя, а
   * не про то, когда Ева об этом узнала. Версии, признанные ошибкой
   * (`rejected`, `deleted`), в ответ не попадают.
   */
  async factAsOf(
    client: GraphQueryable,
    userId: number,
    factKey: string,
    asOf: Date,
  ): Promise<FactVersion | null> {
    const { rows } = await client.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM memory_node_versions
        WHERE user_id = $1 AND fact_key = $2
          AND valid_from <= $3
          AND (valid_to IS NULL OR valid_to > $3)
          AND status <> ALL($4::text[])
        ORDER BY version DESC
        LIMIT 1`,
      [userId, factKey, asOf, EXCLUDED_FROM_AS_OF],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  /**
   * Полная история факта — все версии, включая замещённые и
   * опровергнутые. Ничего не скрывается: история существует именно
   * затем, чтобы показать, что факт менялся.
   */
  async factHistory(
    client: GraphQueryable,
    userId: number,
    factKey: string,
    limit = 100,
  ): Promise<FactVersion[]> {
    const { rows } = await client.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM memory_node_versions
        WHERE user_id = $1 AND fact_key = $2
        ORDER BY version ASC
        LIMIT $3`,
      [userId, factKey, boundedLimit(limit)],
    );
    return rows.map(toVersion);
  }

  /**
   * Изменения за период.
   *
   * Здесь границей служит время ЗАПИСИ: вопрос «что нового мы узнали за
   * неделю» — про работу Евы, а не про жизнь пользователя.
   */
  async changesBetween(
    client: GraphQueryable,
    userId: number,
    from: Date,
    to: Date,
    limit = 200,
  ): Promise<FactVersion[]> {
    const { rows } = await client.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM memory_node_versions
        WHERE user_id = $1
          AND recorded_at >= $2 AND recorded_at < $3
        ORDER BY recorded_at ASC, id ASC
        LIMIT $4`,
      [userId, from, to, boundedLimit(limit)],
    );
    return rows.map(toVersion);
  }

  /**
   * Состояние сущности на выбранную дату: все факты, действовавшие
   * тогда, по всем узлам сущности. Тёзки сюда не попадают — сущность
   * задана идентификатором, а не именем.
   */
  async entityStateAt(
    client: GraphQueryable,
    userId: number,
    entityId: number,
    asOf: Date,
    limit = 100,
  ): Promise<FactVersion[]> {
    const { rows } = await client.query<VersionRow>(
      `SELECT DISTINCT ON (v.node_id) ${prefixed(VERSION_COLUMNS, "v")}
         FROM memory_node_versions v
         JOIN memory_nodes n
           ON n.user_id = v.user_id AND n.id = v.node_id
        WHERE v.user_id = $1
          AND n.user_id = $1
          AND (n.entity_id = $2 OR n.id = $2)
          AND v.valid_from <= $3
          AND (v.valid_to IS NULL OR v.valid_to > $3)
          AND v.status <> ALL($4::text[])
        ORDER BY v.node_id, v.version DESC
        LIMIT $5`,
      [userId, entityId, asOf, EXCLUDED_FROM_AS_OF, boundedLimit(limit)],
    );
    return rows.map(toVersion);
  }

  /** Текущий снимок памяти пользователя — вход для Mini App и отчётов. */
  async liveFacts(
    client: GraphQueryable,
    userId: number,
    options: { nodeType?: GraphNodeType; limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await client.query(
      `SELECT id, node_type, fact_key, canonical_key, title, text_content,
              content_json, status, confidence, sensitivity, version,
              valid_from, valid_to, event_at, observed_at, current_version_id
         FROM memory_nodes
        WHERE user_id = $1
          AND status = ANY($2::text[])
          AND ($3::text IS NULL OR node_type = $3)
          AND fact_key IS NOT NULL
        ORDER BY observed_at DESC NULLS LAST, id DESC
        LIMIT $4`,
      [userId, [...LIVE_STATUSES], options.nodeType ?? null, boundedLimit(options.limit ?? 100)],
    );
    return rows as Array<Record<string, unknown>>;
  }

  /** Доказательства факта — чтобы пользователь видел, откуда это взялось. */
  async evidenceFor(
    client: GraphQueryable,
    userId: number,
    nodeId: number,
    limit = 50,
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await client.query(
      `SELECT id, source_type, source_id, message_id, episode_id,
              source_at, event_at, support, confidence, content_hash, created_at
         FROM memory_evidence
        WHERE user_id = $1 AND subject_kind = 'node' AND node_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, nodeId, boundedLimit(limit)],
    );
    return rows as Array<Record<string, unknown>>;
  }
}

/**
 * Версии, которых на дату «не было»: отклонённая и удалённая версии не
 * описывают прошлое, они описывают ошибку записи. Опровергнутая при этом
 * остаётся видимой — она часть истории спора.
 */
const EXCLUDED_FROM_AS_OF = ["rejected", "deleted"];

function prefixed(columns: string, alias: string): string {
  return columns
    .split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.floor(limit), 1), 500);
}

function toVersion(row: VersionRow): FactVersion {
  return {
    versionId: Number(row.id),
    nodeId: Number(row.node_id),
    factKey: row.fact_key,
    version: Number(row.version),
    supersedesVersionId: row.supersedes_version_id ? Number(row.supersedes_version_id) : null,
    title: row.title,
    textContent: row.text_content,
    contentJson: row.content_json ?? {},
    status: row.status as TemporalStatus,
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    eventAt: row.event_at,
    observedAt: row.observed_at,
    recordedAt: row.recorded_at,
    changeReason: row.change_reason,
    actorType: row.actor_type,
  };
}
