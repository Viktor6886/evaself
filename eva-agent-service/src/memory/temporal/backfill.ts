/**
 * Перенос накопленных данных на temporal-путь.
 *
 * Что делает: у каждого существующего узла появляется начальная версия,
 * источник и время. Существующие строки при этом НЕ переписываются по
 * содержанию — заполняются только пустые temporal-поля.
 *
 * Два обязательных свойства (требование 9 шага):
 *
 *   идемпотентность — повторный запуск на уже перенесённом узле не
 *     создаёт вторую начальную версию и не добавляет второго
 *     доказательства. Держится не на курсоре, а на самих данных:
 *     версия ищется по (node_id, version = 1), доказательство — по
 *     хэшу содержания. Курсор можно потерять, свойство останется;
 *
 *   возобновляемость — прогресс лежит в `memory_backfill_state` и
 *     обновляется после каждой партии. Обрыв на середине означает
 *     повтор одной партии, а не всего переноса.
 *
 * Перенос читает разных пользователей, поэтому идёт под системной
 * областью с явным `crossUser`, а не под областью одного арендатора.
 */

import type { GraphQueryable } from "../graph-repository.js";
import { buildEvidence } from "./evidence.js";
import { TemporalMemoryRepository } from "./versions.js";

export interface BackfillProgress {
  key: string;
  lastNodeId: number;
  processedNodes: number;
  status: "pending" | "running" | "completed" | "failed";
}

export interface BackfillResult extends BackfillProgress {
  /** Сколько узлов получили начальную версию в этом запуске. */
  migrated: number;
  /** Сколько уже были перенесены раньше. */
  skipped: number;
  /** Есть ли ещё работа. */
  done: boolean;
}

interface LegacyNodeRow {
  id: string;
  user_id: string;
  node_type: string;
  canonical_key: string;
  title: string;
  text_content: string | null;
  content_json: Record<string, unknown> | null;
  status: string;
  confidence: string;
  sensitivity: string;
  source_type: string;
  source_id: string | null;
  source_quote: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  created_at: Date;
  fact_key: string | null;
}

const DEFAULT_KEY = "memory_nodes_v1";

export class TemporalBackfill {
  constructor(private readonly versions = new TemporalMemoryRepository()) {}

  /**
   * Перенести одну партию.
   *
   * Партия намеренно маленькая и берётся по возрастанию id: перенос
   * конкурирует с обычной работой сервиса и не должен держать длинную
   * транзакцию на всей таблице.
   */
  async runBatch(
    client: GraphQueryable,
    options: { key?: string; batchSize?: number } = {},
  ): Promise<BackfillResult> {
    const key = options.key ?? DEFAULT_KEY;
    const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1000);
    const progress = await this.claim(client, key);

    const { rows } = await client.query<LegacyNodeRow>(
      `-- tenant: system — единоразовый перенос идёт по всем арендаторам
       -- сразу, курсором по id; владелец каждой строки берётся из неё
       -- самой и переносится в версию без изменения.
       SELECT id, user_id, node_type, canonical_key, title, text_content,
              content_json, status, confidence, sensitivity, source_type,
              source_id, source_quote, valid_from, valid_to, created_at, fact_key
         FROM memory_nodes
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [progress.lastNodeId, batchSize],
    );

    let migrated = 0;
    let skipped = 0;
    let lastNodeId = progress.lastNodeId;
    for (const row of rows) {
      lastNodeId = Number(row.id);
      const created = await this.migrateNode(client, row);
      if (created) migrated += 1;
      else skipped += 1;
    }

    const done = rows.length < batchSize;
    await client.query(
      `UPDATE memory_backfill_state
          SET last_node_id = $2,
              processed_nodes = processed_nodes + $3,
              status = $4,
              updated_at = now(),
              completed_at = CASE WHEN $4 = 'completed' THEN now() ELSE completed_at END
        WHERE backfill_key = $1`,
      [key, lastNodeId, rows.length, done ? "completed" : "running"],
    );

    return {
      key,
      lastNodeId,
      processedNodes: progress.processedNodes + rows.length,
      status: done ? "completed" : "running",
      migrated,
      skipped,
      done,
    };
  }

  /** Прогнать перенос до конца. Возвращает суммарный итог. */
  async runToCompletion(
    client: GraphQueryable,
    options: { key?: string; batchSize?: number; maxBatches?: number } = {},
  ): Promise<BackfillResult> {
    const maxBatches = Math.min(Math.max(options.maxBatches ?? 1000, 1), 100_000);
    let migrated = 0;
    let skipped = 0;
    let last: BackfillResult | null = null;
    for (let index = 0; index < maxBatches; index += 1) {
      last = await this.runBatch(client, options);
      migrated += last.migrated;
      skipped += last.skipped;
      if (last.done) break;
    }
    if (!last) throw new Error("Перенос не выполнил ни одной партии");
    return { ...last, migrated, skipped };
  }

  /**
   * Перенести один узел.
   *
   * Возвращает `true`, только если начальная версия создана именно
   * сейчас. Уже перенесённый узел — не ошибка и не работа.
   */
  private async migrateNode(client: GraphQueryable, row: LegacyNodeRow): Promise<boolean> {
    const userId = Number(row.user_id);
    const nodeId = Number(row.id);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM memory_node_versions
        WHERE user_id = $1 AND node_id = $2 AND version = 1`,
      [userId, nodeId],
    );
    if (existing.rows[0]) return false;

    const factKey = row.fact_key ?? row.canonical_key;
    // Время действительности неизвестно точно: у старых строк его либо
    // нет, либо оно записано прежним кодом. Взять момент создания
    // честнее, чем now(): факт существовал уже тогда.
    const validFrom = row.valid_from ?? row.created_at;
    const status = legacyStatus(row.status);

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO memory_node_versions (
         user_id, node_id, fact_key, version, supersedes_version_id, title,
         text_content, content_json, status, confidence, sensitivity,
         valid_from, valid_to, event_at, observed_at, recorded_at,
         change_reason, actor_type
       ) VALUES ($1, $2, $3, 1, NULL, $4, $5, $6::jsonb, $7, $8, $9,
                 $10, $11, NULL, $12, $12, 'backfill', 'system')
       ON CONFLICT (user_id, node_id, version) DO NOTHING
       RETURNING id`,
      [
        userId,
        nodeId,
        factKey,
        row.title,
        row.text_content,
        JSON.stringify(row.content_json ?? {}),
        status,
        Number(row.confidence),
        row.sensitivity,
        validFrom,
        row.valid_to,
        row.created_at,
      ],
    );
    // Гонка двух переносов: вторая вставка отброшена индексом, и
    // работой этот вызов не считается.
    if (!inserted[0]) return false;
    const versionId = Number(inserted[0].id);

    // Источник существующей строки становится её первым доказательством.
    // Хэш считается из тех же полей, что и у обычного доказательства,
    // поэтому повторный перенос отбрасывается уникальным индексом.
    const evidence = buildEvidence({
      sourceType: row.source_type || "import",
      sourceId: row.source_id,
      messageId: null,
      sourceAt: row.created_at,
      excerpt: row.source_quote ?? row.title,
      confidence: Number(row.confidence),
    });
    await this.versions.storeEvidence(client, userId, nodeId, null, [evidence], versionId);

    await client.query(
      `UPDATE memory_nodes
          SET fact_key = COALESCE(fact_key, $3),
              version = GREATEST(version, 1),
              current_version_id = COALESCE(current_version_id, $4),
              observed_at = COALESCE(observed_at, $5),
              valid_from = COALESCE(valid_from, $6)
        WHERE user_id = $1 AND id = $2`,
      [userId, nodeId, factKey, versionId, row.created_at, validFrom],
    );
    return true;
  }

  private async claim(client: GraphQueryable, key: string): Promise<BackfillProgress> {
    const { rows } = await client.query<{
      backfill_key: string;
      last_node_id: string;
      processed_nodes: string;
      status: string;
    }>(
      `INSERT INTO memory_backfill_state (backfill_key, status)
       VALUES ($1, 'running')
       ON CONFLICT (backfill_key) DO UPDATE
         SET status = 'running', updated_at = now()
       RETURNING backfill_key, last_node_id, processed_nodes, status`,
      [key],
    );
    const row = rows[0]!;
    return {
      key: row.backfill_key,
      lastNodeId: Number(row.last_node_id),
      processedNodes: Number(row.processed_nodes),
      status: "running",
    };
  }
}

/** Прежний словарь статусов графа → словарь temporal-памяти. */
function legacyStatus(value: string): string {
  switch (value) {
    case "unconfirmed": return "candidate";
    case "disputed": return "refuted";
    case "archived": return "forgotten";
    case "superseded": return "superseded";
    case "active": return "active";
    default: return "candidate";
  }
}
