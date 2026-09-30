/**
 * Индексация документа базы знаний в Qdrant (docs/knowledge-base.md, K3).
 *
 *   загрузка → PostgreSQL (документ, фрагменты) + задание в job_outbox,
 *   одной транзакцией → COMMIT → BullMQ (очередь memory) → это задание:
 *   векторы пачками через LLM Router → запись в Qdrant → index_status=ready
 *
 * Задание идемпотентно и возобновляемо: id точки — id фрагмента, повтор
 * перезаписывает те же точки, а лишние (фрагменты, которых больше нет)
 * снимаются после записи. Отказ Qdrant или провайдера оставляет документ
 * `failed` с кодом и отдаёт задание на повтор; фрагменты в PostgreSQL
 * целы, и лексический поиск их находит.
 *
 * Индексируется в каждую версию эмбеддингов, которая строится, готова или
 * активна: при смене модели новые документы должны попасть и в старый
 * индекс (им ещё ищут), и в новый (его ещё строят).
 *
 * Текста фрагмента в Qdrant нет: только вектор и поля для фильтра.
 */

import type { Database } from "../db.js";
import type { JobOutbox, JobOutboxClient } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobContext } from "../jobs/runtime.js";
import type { LlmRouterClient } from "../router/client.js";
import { embeddingText } from "./chunking.js";
import type { QdrantDistance } from "./qdrant-client.js";
import type { KnowledgePointPayload, KnowledgeScope, KnowledgeVectorPoint, KnowledgeVectorStore } from "./vector-store.js";

export const KNOWLEDGE_INDEX_JOB = "knowledge_index";

/** Точек в одном запросе записи: ответ Qdrant ждёт применения, большая пачка — долгий ответ. */
const UPSERT_BATCH = 128;

export interface KnowledgeIndexScheduler {
  enabled(): boolean;
  schedule(client: JobOutboxClient, input: { documentId: string; userId: number | null; reason: string }): Promise<void>;
}

/** Задание индексации — в той же транзакции, что и изменение документа. */
export function knowledgeIndexScheduler(outbox: Pick<JobOutbox, "record">, enabled: () => boolean): KnowledgeIndexScheduler {
  return {
    enabled,
    async schedule(client, input) {
      await outbox.record(client, {
        type: KNOWLEDGE_INDEX_JOB,
        queue: "memory",
        userId: input.userId,
        traceId: input.documentId,
        correlationId: input.documentId,
        idempotencyKey: jobIdempotencyKey({
          type: KNOWLEDGE_INDEX_JOB,
          userId: input.userId,
          discriminator: `${input.documentId}:${input.reason}`,
        }),
        payloadRef: input.documentId,
        payload: { document_id: input.documentId, reason: input.reason },
        deadlineMs: 30 * 60_000,
        timezone: "UTC",
        source: input.userId === null ? "system" : "user",
        privacy: "restricted",
      });
    },
  };
}

interface VersionRow {
  version: number;
  model: string;
  dimension: number;
  distance: QdrantDistance;
  hnsw_m: number;
  hnsw_ef_construct: number;
  on_disk: boolean;
}

interface DocumentRow {
  id: string;
  user_id: string | null;
  collection_id: string | null;
  mime: string;
  created_at: Date | string;
}

interface ChunkRow {
  id: string;
  content: string;
  section: string | null;
  subsection: string | null;
  heading: string | null;
  page_start: number | null;
  page_end: number | null;
}

export type KnowledgeIndexOutcome =
  | { status: "ready"; versions: number[]; chunks: number }
  | { status: "skipped"; reason: "index_disabled" | "no_version" | "document_missing" };

export interface KnowledgeIndexerOptions {
  enabled(): boolean;
  batchSize(): number;
}

export class KnowledgeIndexer {
  private readonly ensured = new Set<number>();

  constructor(
    private readonly db: Database,
    private readonly router: Pick<LlmRouterClient, "embedMany">,
    private readonly store: Pick<KnowledgeVectorStore, "ensureSpace" | "upsert" | "pruneDocument">,
    private readonly options: KnowledgeIndexerOptions,
  ) {}

  async run(context: JobContext): Promise<KnowledgeIndexOutcome> {
    const documentId = context.envelope.payloadRef;
    if (!documentId) throw new Error("knowledge_index_invalid");
    return await this.index(documentId, context.envelope.userId, context.signal);
  }

  /**
   * Проиндексировать документ. `userId` — владелец из конверта задания;
   * null — документ общей базы. Документ читается только в этой области:
   * задание с чужим владельцем документа не найдёт.
   */
  async index(documentId: string, userId: number | null, signal?: AbortSignal): Promise<KnowledgeIndexOutcome> {
    // Флаг выключили после постановки: документ остаётся pending, сверка
    // (K3b) проиндексирует его, когда индексацию включат.
    if (!this.options.enabled()) return { status: "skipped", reason: "index_disabled" };
    const versions = await this.targets();
    if (!versions.length) return { status: "skipped", reason: "no_version" };

    const loaded = await this.scoped(userId, async () => await this.load(documentId, userId));
    if (!loaded) return { status: "skipped", reason: "document_missing" };
    const { document, chunks } = loaded;
    const scope: KnowledgeScope = userId === null ? "global" : "private";
    if (scope === "global" && !document.collection_id) {
      await this.mark(documentId, userId, "failed", null, "knowledge_collection_missing");
      throw new Error("knowledge_collection_missing");
    }

    await this.mark(documentId, userId, "indexing", null, null);
    try {
      for (const version of versions) {
        signal?.throwIfAborted();
        try {
          await this.indexVersion(version, scope, document, chunks, signal);
        } catch (error) {
          // Коллекцию могли потерять (том Qdrant пересоздан без перезапуска
          // сервиса): при следующей попытке она создаётся заново, а не
          // считается существующей до рестарта.
          this.ensured.delete(version.version);
          throw error;
        }
      }
    } catch (error) {
      await this.mark(documentId, userId, "failed", null, errorCode(error)).catch(() => undefined);
      throw error;
    }
    await this.mark(documentId, userId, "ready", Math.max(...versions.map((row) => row.version)), null);
    return { status: "ready", versions: versions.map((row) => row.version), chunks: chunks.length };
  }

  private async indexVersion(
    version: VersionRow,
    scope: KnowledgeScope,
    document: DocumentRow,
    chunks: ChunkRow[],
    signal?: AbortSignal,
  ): Promise<void> {
    const space = { version: version.version, model: version.model, dimension: version.dimension, distance: version.distance };
    if (!this.ensured.has(version.version)) {
      await this.store.ensureSpace(space, { m: version.hnsw_m, efConstruct: version.hnsw_ef_construct, onDisk: version.on_disk });
      this.ensured.add(version.version);
    }
    const vectors = await this.router.embedMany(chunks.map((chunk) => embeddingText(chunk)), {
      version: version.version,
      dimension: version.dimension,
      batchSize: this.options.batchSize(),
      ...(signal ? { signal } : {}),
    });
    const createdAt = document.created_at instanceof Date ? document.created_at.toISOString() : String(document.created_at);
    const points: KnowledgeVectorPoint[] = chunks.map((chunk, index) => {
      const payload: KnowledgePointPayload = {
        chunk_id: Number(chunk.id),
        document_id: document.id,
        user_id: scope === "private" ? String(document.user_id) : null,
        collection_id: scope === "global" ? document.collection_id : null,
        page_start: chunk.page_start,
        page_end: chunk.page_end,
        section: chunk.section,
        mime: document.mime,
        embedding_model: version.model,
        embedding_version: version.version,
        created_at: createdAt,
      };
      return { chunkId: Number(chunk.id), vector: vectors[index]!, payload };
    });
    for (let start = 0; start < points.length; start += UPSERT_BATCH) {
      signal?.throwIfAborted();
      await this.store.upsert(scope, space, points.slice(start, start + UPSERT_BATCH), signal);
    }
    await this.store.pruneDocument(scope, version.version, document.id, points.map((point) => point.chunkId));
  }

  private async targets(): Promise<VersionRow[]> {
    const { rows } = await this.db.query<VersionRow>(
      `SELECT version, model, dimension, distance, hnsw_m, hnsw_ef_construct, on_disk
         FROM knowledge_embedding_versions
        WHERE status IN ('building', 'ready', 'active')
        ORDER BY version`,
    );
    return rows;
  }

  private async load(documentId: string, userId: number | null): Promise<{ document: DocumentRow; chunks: ChunkRow[] } | null> {
    const documents = userId === null
      ? await this.db.query<DocumentRow>(
        `SELECT id, user_id, collection_id, mime, created_at
           FROM knowledge_documents
           -- tenant: system — документ общей базы: владельца нет, доступ по коллекции
          WHERE id = $1 AND user_id IS NULL AND product_verified`,
        [documentId],
      )
      : await this.db.query<DocumentRow>(
        `SELECT id, user_id, collection_id, mime, created_at
           FROM knowledge_documents
          WHERE id = $1 AND user_id = $2`,
        [documentId, userId],
      );
    const document = documents.rows[0];
    if (!document) return null;
    const chunks = userId === null
      ? await this.db.query<ChunkRow>(
        `SELECT id, content, section, subsection, heading, page_start, page_end
           FROM knowledge_chunks
           -- tenant: system — фрагменты документа общей базы, владельца нет
          WHERE document_id = $1 AND user_id IS NULL AND product_verified
          ORDER BY ordinal`,
        [documentId],
      )
      : await this.db.query<ChunkRow>(
        `SELECT id, content, section, subsection, heading, page_start, page_end
           FROM knowledge_chunks
          WHERE document_id = $1 AND user_id = $2
          ORDER BY ordinal`,
        [documentId, userId],
      );
    return { document, chunks: chunks.rows };
  }

  private async mark(
    documentId: string,
    userId: number | null,
    status: "indexing" | "ready" | "failed",
    version: number | null,
    error: string | null,
  ): Promise<void> {
    await this.scoped(userId, async () => {
      if (userId === null) {
        await this.db.query(
          `UPDATE knowledge_documents
              -- tenant: system — состояние индекса документа общей базы
              SET index_status = $2,
                  indexed_version = COALESCE($3, indexed_version),
                  indexed_at = CASE WHEN $2 = 'ready' THEN now() ELSE indexed_at END,
                  index_error = $4,
                  updated_at = now()
            WHERE id = $1 AND user_id IS NULL AND product_verified`,
          [documentId, status, version, error],
        );
      } else {
        await this.db.query(
          `UPDATE knowledge_documents
              SET index_status = $3,
                  indexed_version = COALESCE($4, indexed_version),
                  indexed_at = CASE WHEN $3 = 'ready' THEN now() ELSE indexed_at END,
                  index_error = $5,
                  updated_at = now()
            WHERE id = $1 AND user_id = $2`,
          [documentId, userId, status, version, error],
        );
      }
    });
  }

  private async scoped<T>(userId: number | null, work: () => Promise<T>): Promise<T> {
    return userId === null
      ? await this.db.withSystemScope("knowledge.index.global", work, { inherit: true })
      : await this.db.withUserScope({ userId, label: "knowledge.index", inherit: true }, work);
  }
}

/** Код отказа для панели: имя ошибки, а не её текст (в тексте бывают данные). */
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 64);
  }
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]{3,64}$/u.test(message) ? message : "knowledge_index_failed";
}
