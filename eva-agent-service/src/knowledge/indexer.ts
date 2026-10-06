/**
 * Индексация документа базы знаний в Qdrant (docs/knowledge-base.md, K3, K3b).
 *
 *   загрузка → PostgreSQL (документ, фрагменты) + задание в job_outbox,
 *   одной транзакцией → COMMIT → BullMQ (очередь memory) → это задание:
 *   векторы пачками через LLM Router → запись в Qdrant → index_status=ready
 *
 * Задание приводит Qdrant в соответствие с PostgreSQL для одного
 * документа. Документ есть — его точки записываются; документа нет (его
 * удалили) — снимаются его точки во всех версиях и исходный файл.
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
 * Новая версия документа: векторы неизменённых фрагментов берутся из
 * точек прежней версии, провайдер считает только изменённые. Прежняя
 * версия снимается после того, как новая проиндексирована: поиск не
 * остаётся без документа посреди замены.
 *
 * Текста фрагмента в Qdrant нет: только вектор и поля для фильтра.
 */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import type { Database } from "../db.js";
import { withKnowledgeIndexWrite } from "./version-validation.js";
import type { JobOutbox } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobTimingPolicy } from "../jobs/policy.js";
import type { JobContext } from "../jobs/runtime.js";
import type { LlmRouterClient } from "../router/client.js";
import { embeddingText } from "./chunking.js";
import {
  deleteKnowledgeDocuments,
  knowledgeOwner,
  knowledgeUploadPath,
  type KnowledgeDocumentJobs,
  type KnowledgeOwner,
} from "./documents.js";
import { QdrantError, type QdrantDistance } from "./qdrant-client.js";
import type { KnowledgePointPayload, KnowledgeScope, KnowledgeVectorPoint, KnowledgeVectorStore } from "./vector-store.js";

export const KNOWLEDGE_INDEX_JOB = "knowledge_index";

/**
 * Сроки задания. Очередь memory по умолчанию даёт 20 секунд — столько
 * длится короткая операция с памятью, а документ в сотни страниц считает
 * векторы минутами. С умолчанием такой документ обрывался бы на каждой
 * попытке и не индексировался никогда.
 */
export const KNOWLEDGE_INDEX_TIMING: Partial<JobTimingPolicy> = {
  softTimeoutMs: 25 * 60_000,
  hardDeadlineMs: 30 * 60_000,
  externalRequestTimeoutMs: 60_000,
};

/**
 * Срок задания базы знаний от постановки: ожидание в очереди плюс
 * выполнение. Очередь memory одна и идёт по одному заданию, поэтому
 * несколько файлов одной загрузки, их индексация и сверка (до 500
 * заданий за проход) стоят друг за другом часами. Срок, равный одному
 * выполнению, обрывал хвост такой очереди `job_deadline_exceeded`:
 * загрузки падали, документы навсегда оставались «ждёт индексации».
 * Одно выполнение по-прежнему ограничено hardDeadlineMs своего типа.
 */
export const KNOWLEDGE_JOB_DEADLINE_MS = 6 * 3_600_000;

/**
 * Задание базы знаний так и не попало в очередь (`job_outbox.status =
 * dead`). Точная причина — в строке outbox и DLQ; в панели — понятный
 * код и кнопка повтора, а не родовое имя исключения брокера.
 */
export const KNOWLEDGE_PUBLISH_FAILED = "job_publish_failed";

/** Точек в одном запросе записи: ответ Qdrant ждёт применения, большая пачка — долгий ответ. */
const UPSERT_BATCH = 128;

/** Версии, в коллекциях которых могут лежать точки документа. */
const VERSIONS_WITH_POINTS = "status IN ('building', 'ready', 'active', 'retired')";

export interface KnowledgeIndexScheduler extends KnowledgeDocumentJobs {
  /** Индексировать ли новые документы. Задания удаления ставятся всегда. */
  enabled(): boolean;
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
        deadlineMs: KNOWLEDGE_JOB_DEADLINE_MS,
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
  status: string;
  created_at: Date | string;
  replaces_document_id: string | null;
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
  | { status: "ready"; versions: number[]; chunks: number; reused: number }
  | { status: "removed"; versions: number[] }
  | { status: "skipped"; reason: "index_disabled" | "no_version" };

export interface KnowledgeIndexerOptions {
  enabled(): boolean;
  batchSize(): number;
  /** Задан ли ключ Qdrant: без него точек нет и снимать нечего. */
  configured(): boolean;
  /** Том исходных файлов (`/data/knowledge-uploads`). */
  uploadsRoot: string;
  /** Задания для снятой прежней версии документа. */
  jobs: KnowledgeDocumentJobs;
}

/** Только перечисленные версии — перестройка одной версии (`maintenance.ts`). */
export interface KnowledgeIndexRequest {
  versions?: number[];
  /**
   * Перестраивается активная версия: записанный в неё документ найден
   * поиском, и это видно в его состоянии; прежняя версия документа
   * снимается, как после его собственного задания. Отказ состояние не
   * трогает — его отметит собственное задание документа.
   */
  markReady?: boolean;
}

export class KnowledgeIndexer {
  private readonly ensured = new Set<number>();

  constructor(
    private readonly db: Database,
    private readonly router: Pick<LlmRouterClient, "embedMany">,
    private readonly store: Pick<KnowledgeVectorStore, "ensureSpace" | "upsert" | "pruneDocument" | "deleteDocuments" | "vectorsOf">,
    private readonly options: KnowledgeIndexerOptions,
  ) {}

  async run(context: JobContext): Promise<KnowledgeIndexOutcome> {
    const documentId = context.envelope.payloadRef;
    if (!documentId) throw new Error("knowledge_index_invalid");
    return await this.index(documentId, context.envelope.userId, context.signal);
  }

  /**
   * Привести Qdrant к PostgreSQL для документа. `userId` — владелец из
   * конверта задания; null — документ общей базы. Документ читается
   * только в этой области: задание с чужим владельцем его не найдёт и
   * снимет лишь то, что лежит под его собственным владельцем.
   */
  async index(documentId: string, userId: number | null, signal?: AbortSignal, request: KnowledgeIndexRequest = {}): Promise<KnowledgeIndexOutcome> {
    const owner = knowledgeOwner(userId);
    const loaded = await this.scoped(owner, async () => await this.load(documentId, owner));
    if (!loaded) return await this.remove(documentId, owner, signal);

    // Флаг выключили после постановки: документ остаётся pending, сверка
    // проиндексирует его, когда индексацию включат.
    if (!this.options.enabled()) return { status: "skipped", reason: "index_disabled" };
    const all = await this.versions("status IN ('building', 'ready', 'active')");
    const versions = request.versions ? all.filter((row) => request.versions!.includes(row.version)) : all;
    if (!versions.length) return { status: "skipped", reason: "no_version" };

    const { document, chunks, previous } = loaded;
    const scope: KnowledgeScope = owner.kind === "user" ? "private" : "global";
    if (scope === "global" && !document.collection_id) {
      await this.mark(documentId, owner, "failed", null, "knowledge_collection_missing");
      throw new Error("knowledge_collection_missing");
    }

    // Перестройка одной версии не трогает состояние документа: он уже
    // найден активным индексом, и отказ в строящемся этого не отменяет.
    const tracked = request.versions === undefined;
    if (tracked) await this.mark(documentId, owner, "indexing", null, null);
    let reused = 0;
    try {
      for (const version of versions) {
        signal?.throwIfAborted();
        try {
          reused += await this.indexVersion(version, scope, document, chunks, previous, signal);
        } catch (error) {
          // Коллекцию могли потерять (том Qdrant пересоздан без перезапуска
          // сервиса): при следующей попытке она создаётся заново, а не
          // считается существующей до рестарта.
          this.ensured.delete(version.version);
          throw error;
        }
      }
    } catch (error) {
      if (tracked) await this.mark(documentId, owner, "failed", null, errorCode(error)).catch(() => undefined);
      throw error;
    }
    // Готовая новая версия снимает прежнюю — и в перестройке активной
    // версии: иначе замена, загруженная, пока индексировать было некуда,
    // стала бы «готовой», а прежняя осталась бы в поиске рядом с ней.
    if (tracked || request.markReady) {
      await this.mark(documentId, owner, "ready", Math.max(...versions.map((row) => row.version)), null);
      if (document.replaces_document_id) await this.retire(document.replaces_document_id, owner);
    }
    return { status: "ready", versions: versions.map((row) => row.version), chunks: chunks.length, reused };
  }

  /** Вернуть число фрагментов, чьи векторы взяты из прежней версии документа. */
  private async indexVersion(
    version: VersionRow,
    scope: KnowledgeScope,
    document: DocumentRow,
    chunks: ChunkRow[],
    previous: ChunkRow[],
    signal?: AbortSignal,
  ): Promise<number> {
    const space = { version: version.version, model: version.model, dimension: version.dimension, distance: version.distance };
    if (!this.ensured.has(version.version)) {
      await this.store.ensureSpace(space, { m: version.hnsw_m, efConstruct: version.hnsw_ef_construct, onDisk: version.on_disk });
      this.ensured.add(version.version);
    }
    const texts = chunks.map((chunk) => embeddingText(chunk));
    const vectors: Array<number[] | undefined> = await this.reusable(scope, version, texts, previous, signal);
    const missing = texts.flatMap((text, index) => vectors[index] ? [] : [{ text, index }]);
    if (missing.length) {
      const computed = await this.router.embedMany(missing.map((item) => item.text), {
        version: version.version,
        dimension: version.dimension,
        batchSize: this.options.batchSize(),
        ...(signal ? { signal } : {}),
      });
      missing.forEach((item, position) => { vectors[item.index] = computed[position]; });
    }
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
    await withKnowledgeIndexWrite(this.db, async (client) => {
      signal?.throwIfAborted();
      const owner = knowledgeOwner(scope === "private" ? Number(document.user_id) : null);
      const fresh = await this.scoped(owner, async () => await this.load(document.id, owner, client), false);
      // Документ могли удалить или изменить, пока Router считал векторы.
      // Перечитываем на том же клиенте под SHARE lock; устаревшее задание
      // отдаётся на повтор и не создаёт точки-сироты после проверки K7.
      if (!fresh || fresh.document.status !== "ready" || JSON.stringify(fresh.document) !== JSON.stringify(document)
        || JSON.stringify(fresh.chunks) !== JSON.stringify(chunks)) throw new Error("knowledge_document_changed");
      for (let start = 0; start < points.length; start += UPSERT_BATCH) {
        signal?.throwIfAborted();
        await this.store.upsert(scope, space, points.slice(start, start + UPSERT_BATCH), signal);
      }
      await this.store.pruneDocument(scope, version.version, document.id, points.map((point) => point.chunkId));
    }, true);
    return texts.length - missing.length;
  }

  /**
   * Векторы из прежней версии документа для фрагментов с тем же текстом
   * (вместе с путём заголовков — он входит в то, что считает модель).
   * Отказ чтения — не отказ индексации: недостающее посчитает провайдер.
   */
  private async reusable(
    scope: KnowledgeScope,
    version: VersionRow,
    texts: string[],
    previous: ChunkRow[],
    signal?: AbortSignal,
  ): Promise<Array<number[] | undefined>> {
    const result: Array<number[] | undefined> = texts.map(() => undefined);
    if (!previous.length) return result;
    const byHash = new Map(previous.map((chunk) => [textHash(embeddingText(chunk)), Number(chunk.id)]));
    const wanted = texts.map((text) => byHash.get(textHash(text)));
    const ids = [...new Set(wanted.filter((id): id is number => id !== undefined))];
    if (!ids.length) return result;
    let found: Map<number, number[]>;
    try {
      found = await this.store.vectorsOf(scope, version.version, ids, signal);
    } catch {
      signal?.throwIfAborted();
      return result;
    }
    wanted.forEach((id, index) => {
      const vector = id === undefined ? undefined : found.get(id);
      if (vector && vector.length === version.dimension) result[index] = vector;
    });
    return result;
  }

  /**
   * Документа больше нет: снять его точки во всех версиях, где они могут
   * лежать (в том числе выведенной — откат на неё не должен вернуть
   * удалённое), и исходный файл, если на него не ссылается ни одна
   * загрузка.
   */
  private async remove(documentId: string, owner: KnowledgeOwner, signal?: AbortSignal): Promise<KnowledgeIndexOutcome> {
    // Файл — первым: это данные человека, и недоступный Qdrant не должен
    // оставлять их на томе до повтора задания.
    const referenced = await this.scoped(owner, async () => await this.uploadExists(documentId, owner));
    if (!referenced) await rm(knowledgeUploadPath(this.options.uploadsRoot, owner, documentId), { force: true });
    const versions = this.options.configured() ? await this.versions(VERSIONS_WITH_POINTS) : [];
    const scope: KnowledgeScope = owner.kind === "user" ? "private" : "global";
    for (const version of versions) {
      signal?.throwIfAborted();
      try {
        await withKnowledgeIndexWrite(this.db, async () => await this.store.deleteDocuments(scope, version.version, [documentId], owner.kind === "user" ? owner.userId : undefined));
      } catch (error) {
        // Коллекции версии ещё нет (версия строится, документов не было) —
        // и точек в ней нет: снимать нечего. Прочие отказы — повтор.
        if (!(error instanceof QdrantError && error.code === "qdrant_not_found")) throw error;
      }
    }
    return { status: "removed", versions: versions.map((row) => row.version) };
  }

  /** Снять прежнюю версию документа, когда новая проиндексирована. */
  private async retire(previousId: string, owner: KnowledgeOwner): Promise<void> {
    await this.scoped(owner, async () => await this.db.transaction(async (client) => {
      await deleteKnowledgeDocuments(client, owner, [previousId], this.options.jobs);
    }));
  }

  private async versions(condition: string): Promise<VersionRow[]> {
    const { rows } = await this.db.query<VersionRow>(
      `SELECT version, model, dimension, distance, hnsw_m, hnsw_ef_construct, on_disk
         FROM knowledge_embedding_versions
        WHERE ${condition}
        ORDER BY version`,
    );
    return rows;
  }

  private async load(documentId: string, owner: KnowledgeOwner, source: Pick<Database, "query"> = this.db): Promise<{ document: DocumentRow; chunks: ChunkRow[]; previous: ChunkRow[] } | null> {
    const documents = owner.kind === "global"
      ? await source.query<DocumentRow>(
        `SELECT id, user_id, collection_id, mime, status, created_at, replaces_document_id
           FROM knowledge_documents
           -- tenant: system — документ общей базы: владельца нет, доступ по коллекции
          WHERE id = $1 AND user_id IS NULL AND product_verified`,
        [documentId],
      )
      : await source.query<DocumentRow>(
        `SELECT id, user_id, collection_id, mime, status, created_at, replaces_document_id
           FROM knowledge_documents
          WHERE id = $1 AND user_id = $2`,
        [documentId, owner.userId],
      );
    const document = documents.rows[0];
    if (!document) return null;
    const chunks = await this.chunks(document.id, owner, source);
    // Прежняя версия — только своя: чужой id в replaces_document_id не
    // найдётся в области владельца, и векторы чужого документа не
    // попадут в этот.
    const previous = document.replaces_document_id ? await this.chunks(document.replaces_document_id, owner, source) : [];
    return { document, chunks, previous };
  }

  private async chunks(documentId: string, owner: KnowledgeOwner, source: Pick<Database, "query"> = this.db): Promise<ChunkRow[]> {
    const { rows } = owner.kind === "global"
      ? await source.query<ChunkRow>(
        `SELECT id, content, section, subsection, heading, page_start, page_end
           FROM knowledge_chunks
           -- tenant: system — фрагменты документа общей базы, владельца нет
          WHERE document_id = $1 AND user_id IS NULL AND product_verified
          ORDER BY ordinal`,
        [documentId],
      )
      : await source.query<ChunkRow>(
        `SELECT id, content, section, subsection, heading, page_start, page_end
           FROM knowledge_chunks
          WHERE document_id = $1 AND user_id = $2
          ORDER BY ordinal`,
        [documentId, owner.userId],
      );
    return rows;
  }

  private async uploadExists(uploadId: string, owner: KnowledgeOwner): Promise<boolean> {
    const { rows } = owner.kind === "global"
      ? await this.db.query(
        `SELECT 1 FROM knowledge_uploads
          -- tenant: system — запись приёма общей базы
          WHERE id = $1 AND user_id IS NULL`,
        [uploadId],
      )
      : await this.db.query("SELECT 1 FROM knowledge_uploads WHERE id = $1 AND user_id = $2", [uploadId, owner.userId]);
    return rows.length > 0;
  }

  private async mark(
    documentId: string,
    owner: KnowledgeOwner,
    status: "indexing" | "ready" | "failed",
    version: number | null,
    error: string | null,
  ): Promise<void> {
    await this.scoped(owner, async () => {
      if (owner.kind === "global") {
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
          [documentId, owner.userId, status, version, error],
        );
      }
    });
  }

  /**
   * Область запроса. Общая база — системная область с доступом к строкам
   * без владельца: условие `user_id IS NULL` граница не считает
   * ограничением, и без `crossUser` она отвергла бы каждый запрос.
   */
  private async scoped<T>(owner: KnowledgeOwner, work: () => Promise<T>, inherit = true): Promise<T> {
    return owner.kind === "global"
      ? await this.db.withSystemScope("knowledge.index.global", work, { crossUser: true })
      : await this.db.withUserScope({ userId: owner.userId, label: "knowledge.index", inherit }, work);
  }
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Код отказа для панели: имя ошибки, а не её текст (в тексте бывают данные). */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 64);
  }
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]{3,64}$/u.test(message) ? message : "knowledge_index_failed";
}
