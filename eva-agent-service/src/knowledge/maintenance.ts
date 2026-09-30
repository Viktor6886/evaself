/**
 * Обслуживание векторного индекса базы знаний (docs/knowledge-base.md, K3b):
 * сверка PostgreSQL ↔ Qdrant и перестройка версии из PostgreSQL.
 *
 * PostgreSQL — источник истины, Qdrant — производный индекс. Оба
 * задания только приводят Qdrant к PostgreSQL и ничего не меняют в
 * документах, кроме состояния их индекса.
 *
 * Сверка (`knowledge_reconcile`, расписание и кнопка в панели):
 *   * точки чужой версии в коллекции версии — снимаются;
 *   * документ, чьих точек меньше или больше, чем фрагментов, — в
 *     очередь индексации (недостающие допишутся, лишние снимутся);
 *   * точки документа, которого в PostgreSQL нет, — снимаются;
 *   * коллекции версии нет (том Qdrant потерян) — перестройка версии;
 *   * исходный файл, на который не ссылается ни одна загрузка, старше
 *     суток — удаляется.
 *
 * Перестройка (`knowledge_rebuild`, «Перестроить индекс» и первое
 * построение версии) идёт порциями: каждая порция — несколько минут
 * работы и продолжение отдельным заданием с курсором. Очередь memory
 * одна на загрузки и индекс, и перестройка большой базы не должна
 * держать загрузку человека часами. Повтор порции продолжает с её
 * курсора; документ, чьи точки уже полны, пропускается.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Database } from "../db.js";
import type { JobOutbox, JobOutboxClient } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobTimingPolicy } from "../jobs/policy.js";
import type { JobContext } from "../jobs/runtime.js";
import { isKnowledgeId } from "./documents.js";
import { errorCode, type KnowledgeIndexer, type KnowledgeIndexScheduler } from "./indexer.js";
import { recordKnowledgeReconcile, setKnowledgePoints, setKnowledgeRebuildProgress } from "./metrics.js";
import { QdrantError } from "./qdrant-client.js";
import type { KnowledgeScope, KnowledgeVectorStore } from "./vector-store.js";

export const KNOWLEDGE_RECONCILE_JOB = "knowledge_reconcile";
export const KNOWLEDGE_REBUILD_JOB = "knowledge_rebuild";

/** Порция перестройки укладывается в мягкий срок с запасом на самый большой документ. */
export const KNOWLEDGE_MAINTENANCE_TIMING: Partial<JobTimingPolicy> = {
  softTimeoutMs: 20 * 60_000,
  hardDeadlineMs: 25 * 60_000,
  externalRequestTimeoutMs: 60_000,
};

/** Сколько длится одна порция перестройки, прежде чем уступить очередь. */
const REBUILD_SLICE_MS = 3 * 60_000;
/** Документов за один проход выборки перестройки. */
const REBUILD_PAGE = 50;
/** Заданий индексации, которые сверка ставит за один проход. */
const RECONCILE_SCHEDULE_LIMIT = 500;
/** Исходный файл без записи приёма старше суток — мусор: загрузка пишет запись сразу после файла. */
const ORPHAN_FILE_AGE_MS = 24 * 3_600_000;

type OutboxRecord = Pick<JobOutbox, "record">;

interface VersionRow {
  version: number;
  status: string;
  /** Идёт построение или перестройка: точек у многих документов ещё нет. */
  building: boolean;
}

/** Задание перестройки версии: первое построение, «Перестроить индекс» или продолжение. */
export async function scheduleKnowledgeRebuild(
  outbox: OutboxRecord,
  client: JobOutboxClient,
  input: { version: number; started: number; full: boolean; after: string | null },
): Promise<void> {
  const cursor = input.after ?? "start";
  await outbox.record(client, {
    type: KNOWLEDGE_REBUILD_JOB,
    queue: "memory",
    userId: null,
    traceId: `v${input.version}-${input.started}`,
    idempotencyKey: jobIdempotencyKey({
      type: KNOWLEDGE_REBUILD_JOB,
      userId: null,
      discriminator: `v${input.version}:${input.started}:${cursor}`,
    }),
    payloadRef: String(input.version),
    payload: {
      version: input.version,
      started: input.started,
      full: input.full,
      after: input.after,
    },
    deadlineMs: 25 * 60_000,
    timezone: "UTC",
    source: "system",
    privacy: "standard",
  });
}

/**
 * Начать построение или перестройку версии: черновик и неудавшаяся
 * становятся `building`, готовая и активная сохраняют статус (поиск на
 * активной продолжается). Новая отметка начала делает устаревшими
 * задания прежней перестройки. null — версии нет или её уже вывели.
 */
export async function startKnowledgeRebuild(
  outbox: OutboxRecord,
  client: JobOutboxClient,
  version: number,
  full: boolean,
): Promise<{ status: string; started: number } | null> {
  const { rows } = await client.query<{ status: string; started: string }>(
    `UPDATE knowledge_embedding_versions
        SET build_started_at = clock_timestamp(), error_code = NULL,
            status = CASE WHEN status IN ('draft', 'failed') THEN 'building' ELSE status END
      WHERE version = $1 AND status IN ('draft', 'failed', 'building', 'ready', 'active')
      RETURNING status, (extract(epoch FROM build_started_at) * 1000)::bigint AS started`,
    [version],
  );
  const row = rows[0];
  if (!row) return null;
  const started = Number(row.started);
  await scheduleKnowledgeRebuild(outbox, client, { version, started, full, after: null });
  return { status: row.status, started };
}

/** Сверка по запросу администратора; по расписанию её ставит `job_schedules`. */
export async function scheduleKnowledgeReconcile(outbox: OutboxRecord, client: JobOutboxClient, requestedAt: number): Promise<void> {
  await outbox.record(client, {
    type: KNOWLEDGE_RECONCILE_JOB,
    queue: "memory",
    userId: null,
    traceId: `reconcile-${requestedAt}`,
    idempotencyKey: jobIdempotencyKey({ type: KNOWLEDGE_RECONCILE_JOB, userId: null, discriminator: `manual:${requestedAt}` }),
    payload: {},
    deadlineMs: 25 * 60_000,
    timezone: "UTC",
    source: "system",
    privacy: "standard",
  });
}

export interface KnowledgeMaintenanceOptions {
  enabled(): boolean;
  configured(): boolean;
  uploadsRoot: string;
  outbox: OutboxRecord;
  index: KnowledgeIndexScheduler;
  /** Часы для тестов. */
  now?(): number;
}

export interface KnowledgeReconcileReport {
  skipped?: "index_disabled";
  foreign: number;
  scheduled: number;
  orphans: number;
  rebuilds: number;
  files: number;
}

type Store = Pick<
  KnowledgeVectorStore,
  "describe" | "ensureSpace" | "removeForeignVersion" | "documentPointCounts" | "deleteDocuments" | "countPoints" | "documentPoints"
>;

export class KnowledgeMaintenance {
  constructor(
    private readonly db: Database,
    private readonly store: Store,
    private readonly indexer: Pick<KnowledgeIndexer, "index">,
    private readonly options: KnowledgeMaintenanceOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // ------------------------------------------------------------------
  // Сверка
  // ------------------------------------------------------------------

  async reconcile(signal?: AbortSignal): Promise<KnowledgeReconcileReport> {
    const report: KnowledgeReconcileReport = { foreign: 0, scheduled: 0, orphans: 0, rebuilds: 0, files: 0 };
    report.files = await this.sweepFiles(signal);
    if (!this.options.enabled() || !this.options.configured()) {
      recordKnowledgeReconcile(report);
      return { ...report, skipped: "index_disabled" };
    }
    const stamp = this.now();
    const needsIndex = new Map<string, number | null>();
    for (const version of await this.versions("status IN ('building', 'ready', 'active')")) {
      signal?.throwIfAborted();
      const described = await this.store.describe(version.version);
      if ((!described.private || !described.global) && !version.building) {
        // Коллекции нет — том Qdrant потерян или пересоздан. Документ за
        // документом это не поправить: перестройка версии целиком.
        await this.db.withSystemScope("knowledge.reconcile", async () => await this.db.transaction(async (client) => {
          await this.startRebuild(client, version.version, false);
        }));
        report.rebuilds += 1;
        continue;
      }
      // Версию строят прямо сейчас: коллекций ещё может не быть, а точек
      // нет у большинства документов. Это работа перестройки; сверка
      // поставила бы те же документы второй раз, да ещё во все версии.
      if (version.building) continue;
      for (const scope of ["private", "global"] as const) {
        signal?.throwIfAborted();
        report.foreign += await this.store.removeForeignVersion(scope, version.version);
        // Сначала Qdrant, потом PostgreSQL: точки пишутся только после
        // COMMIT документа, поэтому документ, точки которого уже видны,
        // обязательно найдётся и в PostgreSQL — если его не удалили.
        const expected = await this.expectedCount(scope);
        const points = await this.store.documentPointCounts(scope, version.version, Math.min(Math.max(expected.size * 2, 1_000), 200_000));
        const documents = await this.documents(scope);
        const orphans = [...points.keys()].filter((id) => !documents.has(id));
        for (let start = 0; start < orphans.length; start += 256) {
          await this.store.deleteDocuments(scope, version.version, orphans.slice(start, start + 256));
        }
        report.orphans += orphans.length;
        for (const [id, document] of documents) {
          if ((points.get(id) ?? 0) !== document.chunks && !document.busy) needsIndex.set(id, document.userId);
        }
        setKnowledgePoints(scope, version.version, [...points.values()].reduce((sum, value) => sum + value, 0));
      }
    }
    const scheduled = [...needsIndex].slice(0, RECONCILE_SCHEDULE_LIMIT);
    if (scheduled.length) {
      await this.db.withSystemScope("knowledge.reconcile", async () => await this.db.transaction(async (client) => {
        for (const [documentId, userId] of scheduled) {
          await this.markPending(client, documentId);
          await this.options.index.schedule(client, { documentId, userId, reason: `reconcile-${stamp}` });
        }
      }), { crossUser: true });
    }
    report.scheduled = scheduled.length;
    recordKnowledgeReconcile(report);
    return report;
  }

  /** Документы области: число фрагментов и владелец. `busy` — индексируется прямо сейчас. */
  private async documents(scope: KnowledgeScope): Promise<Map<string, { chunks: number; userId: number | null; busy: boolean }>> {
    const { rows } = await this.db.withSystemScope("knowledge.reconcile", async () => await this.db.query<{
      id: string; user_id: string | null; chunk_count: number; busy: boolean;
    }>(
      scope === "private"
        ? `SELECT id, user_id, chunk_count,
                  (index_status IN ('pending', 'indexing') AND updated_at > now() - interval '30 minutes') AS busy
             FROM knowledge_documents
             -- tenant: system — сверка индекса по всем личным базам, наружу только счётчики
            WHERE user_id IS NOT NULL AND status = 'ready'`
        : `SELECT id, user_id, chunk_count,
                  (index_status IN ('pending', 'indexing') AND updated_at > now() - interval '30 minutes') AS busy
             FROM knowledge_documents
             -- tenant: system — сверка индекса общей базы
            WHERE user_id IS NULL AND product_verified AND status = 'ready'`,
    ), { crossUser: true });
    return new Map(rows.map((row) => [String(row.id), {
      chunks: Number(row.chunk_count),
      userId: row.user_id === null ? null : Number(row.user_id),
      busy: row.busy === true,
    }]));
  }

  /** Сколько документов в области — запас для выборки точек по документам. */
  private async expectedCount(scope: KnowledgeScope): Promise<{ size: number }> {
    const { rows } = await this.db.withSystemScope("knowledge.reconcile", async () => await this.db.query<{ total: string }>(
      scope === "private"
        ? `SELECT count(*) AS total FROM knowledge_documents
            -- tenant: system — счётчик документов личных баз
            WHERE user_id IS NOT NULL`
        : `SELECT count(*) AS total FROM knowledge_documents
            -- tenant: system — счётчик документов общей базы
            WHERE user_id IS NULL`,
    ), { crossUser: true });
    return { size: Number(rows[0]?.total ?? 0) };
  }

  private async markPending(client: JobOutboxClient, documentId: string): Promise<void> {
    await client.query(
      `UPDATE knowledge_documents
          -- tenant: system — сверка возвращает документ в очередь индексации
          SET index_status = 'pending', updated_at = now()
        WHERE id = $1`,
      [documentId],
    );
  }

  /**
   * Исходные файлы без записи приёма: запись удалена вместе с документом,
   * а задание, которое удаляет файл, не дошло (например, том был
   * недоступен). Свежие не трогаются: загрузка пишет файл до записи.
   */
  private async sweepFiles(signal?: AbortSignal): Promise<number> {
    let removed = 0;
    let owners: string[];
    try {
      owners = await readdir(this.options.uploadsRoot);
    } catch {
      return 0;
    }
    for (const owner of owners) {
      if (owner !== "global" && !/^[1-9][0-9]{0,15}$/u.test(owner)) continue;
      signal?.throwIfAborted();
      const directory = join(this.options.uploadsRoot, owner);
      let names: string[];
      try {
        names = (await readdir(directory)).filter(isKnowledgeId);
      } catch {
        continue;
      }
      for (let start = 0; start < names.length; start += 500) {
        const page = names.slice(start, start + 500);
        const { rows } = await this.db.withSystemScope("knowledge.reconcile.files", async () => await this.db.query<{ id: string }>(
          `SELECT id FROM knowledge_uploads
            -- tenant: system — сверка исходных файлов тома с записями приёма
            WHERE id = ANY($1::uuid[])`,
          [page],
        ), { crossUser: true });
        const known = new Set(rows.map((row) => String(row.id)));
        for (const name of page) {
          if (known.has(name)) continue;
          const path = join(directory, name);
          try {
            if (this.now() - (await stat(path)).mtimeMs < ORPHAN_FILE_AGE_MS) continue;
            await rm(path, { force: true });
            removed += 1;
          } catch {
            // Файл уже удалён параллельно — это и было целью.
          }
        }
      }
    }
    return removed;
  }

  // ------------------------------------------------------------------
  // Перестройка
  // ------------------------------------------------------------------

  private async startRebuild(client: JobOutboxClient, version: number, full: boolean): Promise<void> {
    await startKnowledgeRebuild(this.options.outbox, client, version, full);
  }

  async rebuild(context: JobContext): Promise<{ status: "continued" | "done" | "stale"; processed: number }> {
    const payload = context.envelope.payload as { version?: unknown; started?: unknown; full?: unknown; after?: unknown };
    const version = Number(payload.version);
    const started = Number(payload.started);
    const full = payload.full === true;
    const after = typeof payload.after === "string" && isKnowledgeId(payload.after) ? payload.after : null;
    if (!Number.isSafeInteger(version) || version <= 0 || !Number.isFinite(started)) throw new Error("knowledge_rebuild_invalid");
    try {
      return await this.rebuildSlice(version, started, full, after, context.signal);
    } catch (error) {
      // Последняя попытка: версия, которую строили с нуля, помечается
      // неудавшейся с кодом отказа; перестраиваемая активная остаётся
      // активной — поиск на ней и так работает.
      const last = context.attempt >= context.timing.maxAttempts;
      await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query(
        `UPDATE knowledge_embedding_versions
            SET error_code = $3,
                status = CASE WHEN $4 AND status = 'building' THEN 'failed' ELSE status END
          WHERE version = $1 AND (extract(epoch FROM build_started_at) * 1000)::bigint = $2`,
        [version, started, errorCode(error), last],
      )).catch(() => undefined);
      throw error;
    }
  }

  private async rebuildSlice(
    version: number,
    started: number,
    full: boolean,
    after: string | null,
    signal: AbortSignal,
  ): Promise<{ status: "continued" | "done" | "stale"; processed: number }> {
    const current = await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query<{ status: string; started: string | null }>(
      `SELECT status, (extract(epoch FROM build_started_at) * 1000)::bigint AS started
         FROM knowledge_embedding_versions WHERE version = $1`,
      [version],
    ));
    const row = current.rows[0];
    // Версию удалили или начали перестраивать заново — это задание лишнее.
    if (!row || !["building", "ready", "active"].includes(row.status) || Number(row.started) !== started) {
      return { status: "stale", processed: 0 };
    }
    if (!this.options.enabled() || !this.options.configured()) {
      await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query(
        "UPDATE knowledge_embedding_versions SET error_code = 'knowledge_index_disabled' WHERE version = $1",
        [version],
      ));
      return { status: "stale", processed: 0 };
    }

    // Коллекции версии создаются в начале, а не при первом документе: у
    // пустой базы документов нет, и версия стала бы `ready` без коллекций —
    // включить её было бы нечем, а сверка перезапускала бы перестройку.
    if (after === null) await this.ensureSpace(version);

    const deadline = this.now() + REBUILD_SLICE_MS;
    let cursor = after;
    let processed = 0;
    for (;;) {
      const page = await this.page(cursor);
      if (!page.length) break;
      for (const document of page) {
        signal.throwIfAborted();
        cursor = document.id;
        const scope: KnowledgeScope = document.userId === null ? "global" : "private";
        if (!full && (await this.pointsOf(scope, version, document.id)) === document.chunks) continue;
        await this.indexer.index(document.id, document.userId, signal, { versions: [version] });
        processed += 1;
        if (this.now() >= deadline) {
          await this.progress(version);
          await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.transaction(async (client) => {
            await scheduleKnowledgeRebuild(this.options.outbox, client, { version, started, full, after: cursor });
          }));
          return { status: "continued", processed };
        }
      }
    }

    // Все документы пройдены. Точки документов, которых нет, снимет сверка.
    await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query(
      `UPDATE knowledge_embedding_versions
          SET built_at = now(), error_code = NULL,
              status = CASE WHEN status = 'building' THEN 'ready' ELSE status END
        WHERE version = $1 AND (extract(epoch FROM build_started_at) * 1000)::bigint = $2`,
      [version, started],
    ));
    setKnowledgeRebuildProgress(version, 1);
    return { status: "done", processed };
  }

  private async ensureSpace(version: number): Promise<void> {
    const { rows } = await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query<{
      model: string; dimension: number; distance: "Cosine" | "Dot" | "Euclid"; hnsw_m: number; hnsw_ef_construct: number; on_disk: boolean;
    }>(
      `SELECT model, dimension, distance, hnsw_m, hnsw_ef_construct, on_disk
         FROM knowledge_embedding_versions WHERE version = $1`,
      [version],
    ));
    const row = rows[0];
    if (!row) throw new Error("knowledge_version_missing");
    await this.store.ensureSpace(
      { version, model: row.model, dimension: Number(row.dimension), distance: row.distance },
      { m: Number(row.hnsw_m), efConstruct: Number(row.hnsw_ef_construct), onDisk: row.on_disk === true },
    );
  }

  /** Точек документа в версии; коллекции ещё нет — точек нет. */
  private async pointsOf(scope: KnowledgeScope, version: number, documentId: string): Promise<number> {
    try {
      return await this.store.documentPoints(scope, version, documentId);
    } catch (error) {
      if (error instanceof QdrantError && error.code === "qdrant_not_found") return -1;
      throw error;
    }
  }

  /** Документы по порядку id, обе области: перестройка возобновляется с курсора. */
  private async page(after: string | null): Promise<Array<{ id: string; userId: number | null; chunks: number }>> {
    const { rows } = await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query<{
      id: string; user_id: string | null; chunk_count: number;
    }>(
      `SELECT id, user_id, chunk_count
         FROM knowledge_documents
         -- tenant: system — перестройка индекса проходит все документы, наружу ничего не отдаёт
        WHERE status = 'ready' AND (user_id IS NOT NULL OR product_verified)
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT ${REBUILD_PAGE}`,
      [after],
    ), { crossUser: true });
    return rows.map((row) => ({ id: String(row.id), userId: row.user_id === null ? null : Number(row.user_id), chunks: Number(row.chunk_count) }));
  }

  /** Доля фрагментов, чьи точки уже в коллекциях версии, — для /metrics. */
  private async progress(version: number): Promise<void> {
    try {
      const { rows } = await this.db.withSystemScope("knowledge.rebuild", async () => await this.db.query<{ total: string }>(
        `SELECT COALESCE(sum(chunk_count), 0) AS total
           FROM knowledge_documents
           -- tenant: system — счётчик фрагментов всех баз для прогресса перестройки
          WHERE status = 'ready' AND (user_id IS NOT NULL OR product_verified)`,
      ), { crossUser: true });
      const total = Number(rows[0]?.total ?? 0);
      const points = (await this.store.countPoints("private", version)) + (await this.store.countPoints("global", version));
      setKnowledgeRebuildProgress(version, total > 0 ? Math.min(points / total, 1) : 1);
    } catch (error) {
      // Прогресс — подсказка для графика; его отказ перестройку не роняет.
      if (!(error instanceof QdrantError)) throw error;
    }
  }

  private async versions(condition: string): Promise<VersionRow[]> {
    const { rows } = await this.db.withSystemScope("knowledge.reconcile", async () => await this.db.query<VersionRow>(
      `SELECT version, status,
              (status = 'building'
                OR (build_started_at IS NOT NULL AND error_code IS NULL
                    AND (built_at IS NULL OR build_started_at > built_at))) AS building
         FROM knowledge_embedding_versions
        WHERE ${condition}
        ORDER BY version`,
    ));
    return rows.map((row) => ({ version: Number(row.version), status: row.status, building: row.building === true }));
  }
}
