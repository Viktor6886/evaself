/**
 * Документы базы знаний в панели (docs/knowledge-base.md, K3b): коллекции
 * общей базы, загрузка администратора, удаление, переиндексация,
 * построение и перестройка индекса, сверка.
 *
 * Панель работает только с общей базой. Личные базы людей видны ей лишь
 * счётчиками: названий, содержимого и владельцев документов администратор
 * не видит (задание, п. 20; `docs/PERSONA.md` — границы приватности).
 *
 * Тяжёлой работы здесь нет. Загрузка кладёт файл на том и пишет запись
 * приёма вместе с заданием разбора одной транзакцией; удаление,
 * переиндексация, перестройка и сверка — тоже задания. Выполняет их
 * агент: публикатор `job_outbox` читает таблицу, кто бы строку ни записал.
 * Панель не ходит ни к модели, ни к провайдеру эмбеддингов.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type pg from "pg";

import { recordJobIntent, type JobOutboxClient } from "../jobs/job-outbox.js";
import { deleteKnowledgeDocuments, isKnowledgeId } from "../knowledge/documents.js";
import { knowledgeIndexScheduler } from "../knowledge/indexer.js";
import { KNOWLEDGE_UPLOAD_MIME, recordKnowledgeIngest } from "../knowledge/lifecycle.js";
import { scheduleKnowledgeReconcile, startKnowledgeRebuild } from "../knowledge/maintenance.js";
import type { KnowledgeVectorStore } from "../knowledge/vector-store.js";
import { adminBadRequest, adminConflict, adminNotFound } from "./errors.js";

const CODE = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const INDEX_STATUSES = new Set(["pending", "indexing", "ready", "failed"]);
/** Столько же принимает разбор (`DocumentIngestor`): больший файл он отверг бы уже в задании. */
export const KNOWLEDGE_ADMIN_MAX_BYTES = 10 * 1024 * 1024;
/** Документов за одну массовую операцию: список id приходит из панели. */
const BULK_LIMIT = 500;

const outbox = { record: recordJobIntent };
/** Задания для документов; индексировать ли, решает агент при выполнении. */
const documentJobs = knowledgeIndexScheduler(outbox, () => true);

export interface KnowledgeCollectionView {
  id: string;
  code: string;
  title: string;
  description: string | null;
  enabled: boolean;
  position: number;
  documents: number;
  indexed: number;
  failed: number;
  chunks: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentsOptions {
  /** Том исходных файлов (`/data/knowledge-uploads`). */
  uploadsRoot: string;
  /**
   * Разбирает ли агент загрузки (`EVA_KNOWLEDGE_UPLOADS`). Выключено —
   * у задания разбора нет исполнителя, и принятый файл навсегда остался
   * бы «в очереди»: загрузка отказывает сразу.
   */
  uploadsEnabled: boolean;
  /** Коллекции Qdrant; null — ключ Qdrant не задан. */
  store: Pick<KnowledgeVectorStore, "activate" | "countPoints"> | null;
  now?(): number;
}

type Pool = Pick<pg.Pool, "query" | "connect">;

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : value ? String(value) : null;
}

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function uuid(value: unknown, field: string): string {
  if (!isKnowledgeId(value)) throw adminBadRequest(`Поле ${field} задано неверно`, { field });
  return value.toLowerCase();
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw adminBadRequest("Список документов пуст", { field: "ids" });
  if (value.length > BULK_LIMIT) throw adminBadRequest(`Не больше ${BULK_LIMIT} документов за раз`, { field: "ids" });
  return [...new Set(value.map((item) => uuid(item, "ids")))];
}

function title(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw adminBadRequest("Название коллекции — от 1 до 200 знаков", { field: "title" });
  return text;
}

function description(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) throw adminBadRequest("Описание — не длиннее 2000 знаков", { field: "description" });
  return value.trim() || null;
}

function position(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < -100_000 || number > 100_000) throw adminBadRequest("Порядок — целое число", { field: "position" });
  return number;
}

function limit(value: unknown, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) ? Math.min(Math.max(number, 1), max) : fallback;
}

export class KnowledgeDocumentsService {
  constructor(private readonly pool: Pool, private readonly options: KnowledgeDocumentsOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async transaction<T>(work: (client: JobOutboxClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client as unknown as JobOutboxClient);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // Коллекции общей базы
  // ------------------------------------------------------------------

  async collections(): Promise<KnowledgeCollectionView[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT c.id, c.code, c.title, c.description, c.enabled, c.position, c.created_at, c.updated_at,
              count(d.id) AS documents,
              count(d.id) FILTER (WHERE d.index_status = 'ready') AS indexed,
              count(d.id) FILTER (WHERE d.index_status = 'failed') AS failed,
              COALESCE(sum(d.chunk_count), 0) AS chunks
         FROM knowledge_collections c
         LEFT JOIN knowledge_documents d
           -- tenant: system — документы общей базы по коллекциям, владельца у них нет
           ON d.collection_id = c.id AND d.user_id IS NULL
        GROUP BY c.id
        ORDER BY c.position, lower(c.title)`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      code: String(row.code),
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      enabled: row.enabled === true,
      position: Number(row.position),
      documents: Number(row.documents),
      indexed: Number(row.indexed),
      failed: Number(row.failed),
      chunks: Number(row.chunks),
      created_at: iso(row.created_at) ?? "",
      updated_at: iso(row.updated_at) ?? "",
    }));
  }

  async createCollection(body: unknown): Promise<KnowledgeCollectionView> {
    const input = record(body);
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!CODE.test(code)) throw adminBadRequest("Код коллекции — латиница, цифры, «-» и «_», до 63 знаков", { field: "code" });
    const id = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO knowledge_collections (id, code, title, description, enabled, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, code, title(input.title), description(input.description), input.enabled !== false, position(input.position, 0)],
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505") throw adminConflict("Коллекция с таким кодом уже есть", { field: "code" });
      throw error;
    }
    return await this.collection(id);
  }

  /** Переименовать, включить, выключить, переставить. Код не меняется: на него могут ссылаться. */
  async updateCollection(id: unknown, body: unknown): Promise<KnowledgeCollectionView> {
    const collectionId = uuid(id, "id");
    const input = record(body);
    const { rows } = await this.pool.query<{ title: string; description: string | null; enabled: boolean; position: number }>(
      "SELECT title, description, enabled, position FROM knowledge_collections WHERE id = $1",
      [collectionId],
    );
    const current = rows[0];
    if (!current) throw adminNotFound("Коллекция не найдена");
    await this.pool.query(
      `UPDATE knowledge_collections
          SET title = $2, description = $3, enabled = $4, position = $5, updated_at = now()
        WHERE id = $1`,
      [
        collectionId,
        input.title === undefined ? current.title : title(input.title),
        input.description === undefined ? current.description : description(input.description),
        input.enabled === undefined ? current.enabled : input.enabled === true,
        position(input.position, Number(current.position)),
      ],
    );
    return await this.collection(collectionId);
  }

  /**
   * Удалить пустую коллекцию. С документами — отказ: удалять документы
   * вместе с коллекцией одним нажатием слишком легко по ошибке, это
   * отдельное явное действие («Удалить» на документах).
   */
  async deleteCollection(id: unknown): Promise<{ deleted: string }> {
    const collectionId = uuid(id, "id");
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM knowledge_documents
        -- tenant: system — документы общей базы в коллекции
        WHERE collection_id = $1 AND user_id IS NULL`,
      [collectionId],
    );
    const documents = Number(rows[0]?.total ?? 0);
    if (documents > 0) throw adminConflict("В коллекции есть документы: сначала удалите их", { documents });
    let deleted;
    try {
      deleted = await this.pool.query("DELETE FROM knowledge_collections WHERE id = $1 RETURNING id", [collectionId]);
    } catch (error) {
      // Документ успели загрузить между подсчётом и удалением: внешний
      // ключ документа не даёт удалить коллекцию.
      if ((error as { code?: unknown }).code === "23503") throw adminConflict("В коллекции есть документы: сначала удалите их");
      throw error;
    }
    if (!deleted.rows[0]) throw adminNotFound("Коллекция не найдена");
    return { deleted: collectionId };
  }

  private async collection(id: string): Promise<KnowledgeCollectionView> {
    const found = (await this.collections()).find((row) => row.id === id);
    if (!found) throw adminNotFound("Коллекция не найдена");
    return found;
  }

  // ------------------------------------------------------------------
  // Документы общей базы
  // ------------------------------------------------------------------

  async documents(query: unknown): Promise<{ documents: Array<Record<string, unknown>>; total: number }> {
    const input = record(query);
    const collection = input.collection_id ? uuid(input.collection_id, "collection_id") : null;
    const indexStatus = typeof input.index_status === "string" && INDEX_STATUSES.has(input.index_status) ? input.index_status : null;
    const search = typeof input.q === "string" && input.q.trim() ? input.q.trim().slice(0, 200) : null;
    const pageSize = limit(input.limit, 50, 200);
    const offset = Math.max(Number.isInteger(Number(input.offset)) ? Number(input.offset) : 0, 0);
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT d.id, d.collection_id, d.name, d.mime, d.size_bytes, d.chunk_count, d.status,
              d.index_status, d.index_error, d.indexed_version, d.indexed_at, d.revision,
              d.replaces_document_id, d.source, d.created_at, d.updated_at,
              count(*) OVER () AS total
         FROM knowledge_documents d
         -- tenant: system — список документов общей базы, личных здесь нет
        WHERE d.user_id IS NULL AND d.product_verified
          AND ($1::uuid IS NULL OR d.collection_id = $1)
          AND ($2::text IS NULL OR d.index_status = $2)
          AND ($3::text IS NULL OR d.name ILIKE '%' || $3 || '%')
        ORDER BY d.created_at DESC, d.id
        LIMIT $4 OFFSET $5`,
      [collection, indexStatus, search, pageSize, offset],
    );
    return {
      total: Number(rows[0]?.total ?? 0),
      documents: rows.map((row) => ({
        id: String(row.id),
        collection_id: row.collection_id ? String(row.collection_id) : null,
        name: String(row.name),
        mime: String(row.mime),
        size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
        chunk_count: Number(row.chunk_count),
        status: String(row.status),
        index_status: String(row.index_status),
        index_error: row.index_error ? String(row.index_error) : null,
        indexed_version: row.indexed_version === null ? null : Number(row.indexed_version),
        indexed_at: iso(row.indexed_at),
        revision: Number(row.revision),
        replaces_document_id: row.replaces_document_id ? String(row.replaces_document_id) : null,
        source: String(row.source),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      })),
    };
  }

  /** Очередь загрузок общей базы: исход и ошибка по каждой. */
  async uploads(query: unknown): Promise<Array<Record<string, unknown>>> {
    const input = record(query);
    const collection = input.collection_id ? uuid(input.collection_id, "collection_id") : null;
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, collection_id, name, mime, size_bytes, status, outcome, error_code, document_id,
              created_at, started_at, completed_at
         FROM knowledge_uploads
         -- tenant: system — загрузки администратора в общую базу
        WHERE user_id IS NULL AND ($1::uuid IS NULL OR collection_id = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [collection, limit(input.limit, 50, 200)],
    );
    return rows.map((row) => ({
      id: String(row.id),
      collection_id: row.collection_id ? String(row.collection_id) : null,
      name: String(row.name),
      mime: String(row.mime),
      size_bytes: Number(row.size_bytes),
      status: String(row.status),
      outcome: row.outcome ? String(row.outcome) : null,
      error_code: row.error_code ? String(row.error_code) : null,
      document_id: row.document_id ? String(row.document_id) : null,
      created_at: iso(row.created_at),
      started_at: iso(row.started_at),
      completed_at: iso(row.completed_at),
    }));
  }

  /**
   * Загрузка в коллекцию: файл — на том, запись приёма и задание разбора —
   * одной транзакцией. Дубликат и новую версию определяет разбор.
   */
  async upload(input: {
    collectionId: unknown;
    replaces?: unknown;
    name: string;
    mime: string;
    stream: Readable;
    truncated?: () => boolean;
  }): Promise<{ id: string; status: string }> {
    let collectionId: string;
    let replaces: string | null;
    let name: string;
    try {
      if (!this.options.uploadsEnabled) throw adminConflict("Загрузка в базу знаний выключена (EVA_KNOWLEDGE_UPLOADS)");
      collectionId = uuid(input.collectionId, "collection_id");
      replaces = input.replaces ? uuid(input.replaces, "replaces_document_id") : null;
      name = input.name.trim().slice(0, 255);
      if (!name) throw adminBadRequest("У файла нет имени", { field: "file" });
      if (!KNOWLEDGE_UPLOAD_MIME.has(input.mime)) throw adminBadRequest("Этот формат пока не принимается", { field: "file", mime: input.mime });
      const exists = await this.pool.query("SELECT 1 FROM knowledge_collections WHERE id = $1", [collectionId]);
      if (!exists.rows[0]) throw adminNotFound("Коллекция не найдена");
    } catch (error) {
      // Отказ до чтения файла: поток дочитывается впустую, иначе
      // соединение ждало бы, пока его прочтут, и ответ не ушёл бы.
      input.stream.resume();
      throw error;
    }

    const id = randomUUID();
    const directory = join(this.options.uploadsRoot, "global");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, id);
    const hash = createHash("sha256");
    let size = 0;
    const file = await open(path, "wx", 0o600);
    try {
      for await (const value of input.stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > KNOWLEDGE_ADMIN_MAX_BYTES) throw adminBadRequest("Файл больше 10 МБ", { field: "file" });
        hash.update(chunk);
        await file.write(chunk);
      }
      await file.sync();
      await file.close();
      if (size === 0) throw adminBadRequest("Файл пустой", { field: "file" });
      if (input.truncated?.()) throw adminBadRequest("Файл больше 10 МБ", { field: "file" });
      await this.transaction(async (client) => {
        await client.query(
          `INSERT INTO knowledge_uploads
             (id, user_id, collection_id, replaces_document_id, name, mime, size_bytes, content_hash, storage_path, status)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'queued')`,
          [id, collectionId, replaces, name, input.mime, size, hash.digest("hex"), path],
        );
        await recordKnowledgeIngest(outbox, client, { uploadId: id, userId: null });
      });
      return { id, status: "queued" };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(path, { force: true });
      throw error;
    }
  }

  /** Повторить загрузку, которая не разобралась или была отменена. */
  async retryUpload(id: unknown): Promise<{ id: string; status: string }> {
    const uploadId = uuid(id, "id");
    return await this.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE knowledge_uploads
            -- tenant: system — загрузка администратора в общую базу
            SET status = 'queued', error_code = NULL, started_at = NULL, completed_at = NULL
          WHERE id = $1 AND user_id IS NULL AND status IN ('failed', 'cancelled')
          RETURNING id`,
        [uploadId],
      );
      if (!rows[0]) throw adminConflict("Повторить можно только неудавшуюся или отменённую загрузку");
      await recordKnowledgeIngest(outbox, client, { uploadId, userId: null, attempt: `retry-${this.now()}` });
      return { id: uploadId, status: "queued" };
    });
  }

  /** Удалить документы общей базы: строки — сразу, точки Qdrant и файлы — заданием. */
  async deleteDocuments(body: unknown): Promise<{ deleted: string[] }> {
    const list = ids(record(body).ids);
    const deleted = await this.transaction(async (client) =>
      await deleteKnowledgeDocuments(client, { kind: "global" }, list, documentJobs));
    return { deleted };
  }

  /** Переиндексировать документы: по списку или всю коллекцию. */
  async reindex(body: unknown): Promise<{ scheduled: number }> {
    const input = record(body);
    const collection = input.collection_id ? uuid(input.collection_id, "collection_id") : null;
    const list = collection ? null : ids(input.ids);
    const reason = `reindex-${this.now()}`;
    return await this.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE knowledge_documents
            -- tenant: system — переиндексация документов общей базы
            SET index_status = 'pending', index_error = NULL, updated_at = now()
          WHERE user_id IS NULL AND product_verified
            AND (($1::uuid IS NOT NULL AND collection_id = $1) OR id = ANY($2::uuid[]))
          RETURNING id`,
        [collection, list ?? []],
      );
      for (const row of rows) {
        await documentJobs.schedule(client, { documentId: String(row.id), userId: null, reason });
      }
      return { scheduled: rows.length };
    });
  }

  // ------------------------------------------------------------------
  // Индекс
  // ------------------------------------------------------------------

  /**
   * Состояние индекса: документы по состоянию, отставание, версии с
   * прогрессом построения. Личные базы — только счётчиками.
   */
  async indexOverview(): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT CASE WHEN user_id IS NULL THEN 'global' ELSE 'private' END AS scope,
              index_status,
              count(*) AS documents,
              COALESCE(sum(chunk_count), 0) AS chunks,
              COALESCE(EXTRACT(EPOCH FROM now() - min(updated_at)
                FILTER (WHERE index_status IN ('pending', 'indexing'))), 0) AS lag_seconds
         FROM knowledge_documents
         -- tenant: system — счётчики по всем базам; ни названий, ни владельцев наружу
        WHERE status = 'ready' AND (user_id IS NOT NULL OR product_verified)
        GROUP BY 1, 2`,
    );
    const empty = () => ({ documents: 0, chunks: 0, lag_seconds: 0, by_status: {} as Record<string, number> });
    const scopes = { private: empty(), global: empty() };
    for (const row of rows) {
      const scope = scopes[row.scope === "global" ? "global" : "private"];
      const documents = Number(row.documents);
      scope.documents += documents;
      scope.chunks += Number(row.chunks);
      scope.lag_seconds = Math.max(scope.lag_seconds, Math.round(Number(row.lag_seconds)));
      scope.by_status[String(row.index_status)] = documents;
    }
    // Сколько людей ведут личную базу — число, без их идентификаторов.
    const owners = await this.pool.query<{ total: string }>(
      `SELECT count(DISTINCT user_id) AS total FROM knowledge_documents
        -- tenant: system — число людей с личной базой, без идентификаторов
        WHERE user_id IS NOT NULL`,
    );

    const versions = await this.pool.query<Record<string, unknown>>(
      `SELECT version, model, dimension, status, error_code, build_started_at, built_at, activated_at
         FROM knowledge_embedding_versions
        WHERE status IN ('building', 'ready', 'active', 'retired', 'failed')
        ORDER BY version DESC`,
    );
    const totalChunks = scopes.private.chunks + scopes.global.chunks;
    const store = this.options.store;
    const viewed = [];
    for (const row of versions.rows) {
      const version = Number(row.version);
      let points: number | null = null;
      if (store && row.status !== "failed") {
        try {
          points = (await store.countPoints("private", version)) + (await store.countPoints("global", version));
        } catch {
          // Qdrant недоступен или коллекций нет — прогресс неизвестен, а не ноль.
          points = null;
        }
      }
      const started = row.build_started_at instanceof Date ? row.build_started_at.getTime() : null;
      const built = row.built_at instanceof Date ? row.built_at.getTime() : null;
      viewed.push({
        version,
        model: String(row.model),
        dimension: Number(row.dimension),
        status: String(row.status),
        error_code: row.error_code ? String(row.error_code) : null,
        building: started !== null && (built === null || started > built) && row.status !== "failed" && !row.error_code,
        build_started_at: iso(row.build_started_at),
        built_at: iso(row.built_at),
        activated_at: iso(row.activated_at),
        points,
        progress: points === null ? null : totalChunks > 0 ? Math.min(points / totalChunks, 1) : 1,
      });
    }
    return {
      qdrant: store !== null,
      uploads_enabled: this.options.uploadsEnabled,
      private_owners: Number(owners.rows[0]?.total ?? 0),
      scopes,
      versions: viewed,
    };
  }

  /** Построить версию (первый раз) или перестроить; `full` — переписать и полные документы. */
  async build(version: unknown, body: unknown): Promise<{ version: number; status: string; started_at: string }> {
    const number = Number(version);
    if (!Number.isInteger(number) || number <= 0) throw adminBadRequest("Номер версии задан неверно", { field: "version" });
    if (!this.options.store) throw adminConflict("QDRANT_API_KEY не задан: индексу негде жить");
    const full = record(body).full === true;
    const started = await this.transaction(async (client) => await startKnowledgeRebuild(outbox, client, number, full));
    if (!started) throw adminConflict("Построить можно черновик, неудавшуюся, готовую или активную версию");
    return { version: number, status: started.status, started_at: new Date(started.started).toISOString() };
  }

  /**
   * Первая активация: поиск начинает смотреть на построенную версию.
   * Переключение с одной активной на другую — смена модели (K7): там
   * проверка полноты и качества и откат.
   */
  async activate(version: unknown): Promise<{ version: number; status: string }> {
    const number = Number(version);
    if (!Number.isInteger(number) || number <= 0) throw adminBadRequest("Номер версии задан неверно", { field: "version" });
    const store = this.options.store;
    if (!store) throw adminConflict("QDRANT_API_KEY не задан: индексу негде жить");
    const { rows } = await this.pool.query<{ version: number; status: string }>(
      "SELECT version, status FROM knowledge_embedding_versions WHERE version = $1 OR status = 'active'",
      [number],
    );
    const target = rows.find((row) => Number(row.version) === number);
    if (!target) throw adminNotFound("Версия эмбеддингов не найдена");
    if (rows.some((row) => row.status === "active" && Number(row.version) !== number)) {
      throw adminConflict("Активная версия уже есть: переключение — через смену модели");
    }
    if (target.status === "active") return { version: number, status: "active" };
    if (target.status !== "ready") throw adminConflict("Включить можно только построенную версию", { status: target.status });
    // Сначала alias, потом строка: упади запись после перевода — повтор
    // активации найдёт версию `ready` и переведёт alias ещё раз (это
    // идемпотентно), а не оставит поиск смотреть в пустоту.
    await store.activate(number);
    const updated = await this.pool.query(
      `UPDATE knowledge_embedding_versions
          SET status = 'active', activated_at = now()
        WHERE version = $1 AND status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM knowledge_embedding_versions WHERE status = 'active')
        RETURNING version`,
      [number],
    );
    if (!updated.rows[0]) throw adminConflict("Версию успели изменить: обновите страницу");
    return { version: number, status: "active" };
  }

  /** Сверка PostgreSQL ↔ Qdrant сейчас, не дожидаясь расписания. */
  async reconcile(): Promise<{ scheduled: true }> {
    await this.transaction(async (client) => await scheduleKnowledgeReconcile(outbox, client, this.now()));
    return { scheduled: true };
  }
}
