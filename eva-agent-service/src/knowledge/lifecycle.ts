import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "../db.js";
import type { JobOutbox, JobOutboxClient } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobTimingPolicy } from "../jobs/policy.js";
import type { JobContext } from "../jobs/runtime.js";
import type { Readable } from "node:stream";
import type { ChunkingOptions } from "./chunking.js";
import { deleteKnowledgeDocuments, isKnowledgeId, knowledgeOwner, knowledgeUploadPath, type KnowledgeOwner } from "./documents.js";
import { DocumentIngestor, type KnowledgeChunk } from "./ingestion.js";
import { errorCode, knowledgeIndexScheduler, type KnowledgeIndexScheduler } from "./indexer.js";

export const KNOWLEDGE_INGEST_JOB = "knowledge_ingest";
/** Что принимается в базу знаний: и в личную (Mini App, Telegram), и в общую (панель). */
export const KNOWLEDGE_UPLOAD_MIME: ReadonlySet<string> = new Set(["text/plain","text/markdown","application/json","text/html","application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const ALLOWED = KNOWLEDGE_UPLOAD_MIME;

/**
 * Задание разбора загрузки — в той же транзакции, что и запись приёма.
 * `attempt` отличает повтор после отказа: у него свой ключ, иначе outbox
 * счёл бы его тем же намерением и второго задания не поставил.
 */
export async function recordKnowledgeIngest(
  outbox: Pick<JobOutbox, "record">,
  client: JobOutboxClient,
  input: { uploadId: string; userId: number | null; attempt?: string },
): Promise<void> {
  await outbox.record(client, {
    type: KNOWLEDGE_INGEST_JOB,
    queue: "memory",
    userId: input.userId,
    traceId: input.uploadId,
    correlationId: input.uploadId,
    idempotencyKey: jobIdempotencyKey({
      type: KNOWLEDGE_INGEST_JOB,
      userId: input.userId,
      discriminator: input.attempt ? `${input.uploadId}:${input.attempt}` : input.uploadId,
    }),
    payloadRef: input.uploadId,
    payload: { upload_id: input.uploadId },
    deadlineMs: 10 * 60_000,
    timezone: "UTC",
    source: input.userId === null ? "system" : "user",
    privacy: "restricted",
  });
}

/** UUID из ключа идемпотентности: один и тот же ключ человека — одна загрузка. */
function stableUploadId(userId:number,key:string):string{
  const hex=createHash("sha256").update(`knowledge-upload:${userId}:${key}`).digest("hex");
  // Версия 5 и вариант RFC 4122: строка остаётся корректным uuid для колонки.
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${((parseInt(hex.slice(16,18),16)&0x3f)|0x80).toString(16).padStart(2,"0")}${hex.slice(18,20)}-${hex.slice(20,32)}`;
}

/** Документов в списке Mini App и в одной порции очистки. */
const OVERVIEW_LIMIT = 200;
const CLEAR_BATCH = 500;

/**
 * Состояние документа для человека. Индекс Qdrant выключен — поиск идёт по
 * PostgreSQL, и разобранный документ уже готов; включён — документ готов,
 * когда проиндексирован.
 */
export type KnowledgeDocumentState = "ready" | "indexing" | "failed";

export function knowledgeDocumentState(indexStatus: string, indexing: boolean): KnowledgeDocumentState {
  if (!indexing || indexStatus === "ready") return "ready";
  return indexStatus === "failed" ? "failed" : "indexing";
}

export class KnowledgeUploadService {
  /** Задания синхронизации удалённых документов: удаление ставится всегда. */
  private readonly documentJobs: KnowledgeIndexScheduler;
  constructor(private readonly db: Database, private readonly jobs: JobOutbox, private readonly root: string, private readonly maxBytes=10*1024*1024, private readonly indexEnabled: () => boolean = () => false, private readonly uploadsEnabled: () => boolean = () => true) {
    this.documentJobs = knowledgeIndexScheduler(jobs, () => true);
  }
  enabled(): boolean { return this.uploadsEnabled(); }
  private async internalUser(telegramId:number):Promise<number>{return await this.db.withSystemScope("verified-identity.resolve",async()=>{const {rows}=await this.db.query<{id:string}>("SELECT id FROM users WHERE telegram_id=$1",[telegramId]);if(!rows[0])throw new Error("upload_user_missing");return Number(rows[0].id);},{inherit:true});}
  /**
   * Загрузка в базу знаний. `idempotencyKey` нужен загрузкам, которые
   * делает сервер, а не человек: повтор того же хода (например, архив
   * расшифровки аудиофайла) возвращает уже созданную загрузку, а не
   * заводит вторую копию того же материала.
   */
  async createFromStream(telegramId:number,input:{name:string;mime:string;stream:Readable;truncated?:()=>boolean;idempotencyKey?:string;replaces?:string}):Promise<{id:string;status:string}>{
    if (!this.enabled()) {
      input.stream.resume();
      throw new Error("knowledge_disabled");
    }
    const userId=await this.internalUser(telegramId); if(!ALLOWED.has(input.mime))throw new Error("document_type_unsupported");
    const replaces=input.replaces??null; if(replaces!==null&&!isKnowledgeId(replaces))throw new Error("document_replaces_invalid");
    const id=input.idempotencyKey?stableUploadId(userId,input.idempotencyKey):randomUUID();
    if(input.idempotencyKey){const existing=await this.db.withUserScope({userId,label:"knowledge.upload.replay",inherit:true},async()=>await this.db.query<{id:string;status:string}>("SELECT id,status FROM knowledge_uploads WHERE id=$1 AND user_id=$2",[id,userId]));if(existing.rows[0])return {id:existing.rows[0].id,status:existing.rows[0].status};}
    const dir=resolve(this.root,String(userId)); await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,id);const hash=createHash("sha256");let size=0;const file=await open(path,"wx",0o600);
    try { for await(const value of input.stream){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);size+=chunk.length;if(size>this.maxBytes)throw new Error("document_too_large");hash.update(chunk);await file.write(chunk);}await file.sync();await file.close();if(size===0||input.truncated?.())throw new Error(size===0?"document_empty":"document_too_large");
      return await this.db.withUserScope({userId,label:"knowledge.upload",inherit:true},async()=>await this.db.transaction(async client=>{
        // Новая версия — только своего документа: чужой id не отличается
        // здесь от несуществующего, и ни тот, ни другой не принимается.
        if(replaces!==null){const own=await client.query("SELECT id FROM knowledge_documents WHERE id=$1 AND user_id=$2 FOR SHARE",[replaces,userId]);if(!own.rows[0])throw new Error("document_replaces_missing");}
        // Колонка замены (миграция 092) называется, только когда замена
        // есть: обычная загрузка остаётся той же вставкой, что и раньше.
        const values=[id,userId,input.name,input.mime,size,hash.digest("hex"),path];
        if(replaces===null)await client.query("INSERT INTO knowledge_uploads(id,user_id,name,mime,size_bytes,content_hash,storage_path,status) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')",values);
        else await client.query("INSERT INTO knowledge_uploads(id,user_id,name,mime,size_bytes,content_hash,storage_path,status,replaces_document_id) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8)",[...values,replaces]);
        await recordKnowledgeIngest(this.jobs,client,{uploadId:id,userId});return{id,status:"queued"};}));
    } catch(error){await file.close().catch(()=>undefined);await rm(path,{force:true});throw error;}
  }
  /**
   * Состояние загрузки для человека: разбор файла (`status`), исход
   * (новый документ, дубликат, новая версия) и векторный индекс документа.
   */
  async status(telegramId:number,id:string){
    const userId=await this.internalUser(telegramId);
    const {rows}=await this.db.withUserScope({userId,label:"knowledge.status",inherit:true},async()=>await this.db.query(
      `SELECT u.id,u.name,u.mime,u.size_bytes,u.status,u.error_code,u.document_id,u.outcome,u.created_at,u.completed_at,
              d.index_status
         FROM knowledge_uploads u
         LEFT JOIN knowledge_documents d ON d.id = u.document_id AND d.user_id = u.user_id
        WHERE u.id=$1 AND u.user_id=$2`,
      [id,userId],
    ));
    return rows[0]??null;
  }
  /**
   * Своя база в Mini App: документы с понятным человеку состоянием и
   * последние загрузки. Внутренние коды индекса наружу не отдаются.
   */
  async overview(telegramId:number){
    const userId=await this.internalUser(telegramId);
    const indexing=this.indexEnabled();
    return await this.db.withUserScope({userId,label:"knowledge.overview",inherit:true},async()=>{
      const documents=await this.db.query<{id:string;name:string;mime:string;size_bytes:string|null;chunk_count:number;index_status:string;revision:number;source:string;created_at:Date;updated_at:Date}>(
        `SELECT id,name,mime,size_bytes,chunk_count,index_status,revision,source,created_at,updated_at
           FROM knowledge_documents
          WHERE user_id=$1
          ORDER BY created_at DESC
          LIMIT ${OVERVIEW_LIMIT}`,
        [userId],
      );
      const total=await this.db.query<{total:string}>("SELECT count(*) AS total FROM knowledge_documents WHERE user_id=$1",[userId]);
      const uploads=await this.db.query(
        `SELECT id,name,size_bytes,status,outcome,error_code,created_at
           FROM knowledge_uploads
          WHERE user_id=$1
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId],
      );
      return {
        documents:documents.rows.map(({index_status,size_bytes,...row})=>({...row,size_bytes:size_bytes===null?null:Number(size_bytes),state:knowledgeDocumentState(index_status,indexing)})),
        total:Number(total.rows[0]?.total??0),
        uploads:uploads.rows,
      };
    });
  }
  /** Удалить свой документ: PostgreSQL сразу, файл и точки Qdrant — заданием. */
  async remove(telegramId:number,documentId:string):Promise<{deleted:boolean}>{
    if(!isKnowledgeId(documentId))return{deleted:false};
    const userId=await this.internalUser(telegramId);
    const removed=await this.db.withUserScope({userId,label:"knowledge.delete",inherit:true},async()=>await this.db.transaction(async client=>
      await deleteKnowledgeDocuments(client,knowledgeOwner(userId),[documentId],this.documentJobs)));
    return{deleted:removed.length>0};
  }
  /**
   * Очистить свою базу: все документы и неудавшиеся загрузки вместе с их
   * файлами. Загрузка, которая ещё разбирается, остаётся: её документ
   * появится после очистки, и человек увидит его в списке.
   */
  async clear(telegramId:number):Promise<{deleted:number}>{
    const userId=await this.internalUser(telegramId);
    const owner=knowledgeOwner(userId);
    return await this.db.withUserScope({userId,label:"knowledge.clear",inherit:true},async()=>{
      let deleted=0;
      // Порциями: у человека могут быть тысячи документов, а одна
      // транзакция на всё держала бы блокировки и задания до конца.
      for(;;){
        const {rows}=await this.db.query<{id:string}>(`SELECT id FROM knowledge_documents WHERE user_id=$1 ORDER BY id LIMIT ${CLEAR_BATCH}`,[userId]);
        if(!rows.length)break;
        const removed=await this.db.transaction(async client=>await deleteKnowledgeDocuments(client,owner,rows.map(row=>row.id),this.documentJobs));
        deleted+=removed.length;
        if(!removed.length)break;
      }
      // Сначала файл, потом строка: не удалился файл — строка остаётся, и
      // следующая очистка его найдёт. Наоборот файл с личными данными
      // остался бы без записи, по которой его можно найти.
      const failed=await this.db.query<{id:string}>(
        "SELECT id FROM knowledge_uploads WHERE user_id=$1 AND status IN ('failed','cancelled')",
        [userId],
      );
      for(const row of failed.rows){
        await rm(knowledgeUploadPath(this.root,owner,row.id),{force:true});
        await this.db.query("DELETE FROM knowledge_uploads WHERE id=$1 AND user_id=$2 AND status IN ('failed','cancelled')",[row.id,userId]);
      }
      return{deleted};
    });
  }
}

/**
 * Сроки приёма. Очередь memory по умолчанию даёт 20 секунд, а разбор и
 * векторы документа в сотни страниц — минуты: с умолчанием такой файл
 * обрывался на каждой попытке и оставался `cancelled`.
 */
export const KNOWLEDGE_INGEST_TIMING: Partial<JobTimingPolicy> = {
  softTimeoutMs: 9 * 60_000,
  hardDeadlineMs: 10 * 60_000,
  externalRequestTimeoutMs: 60_000,
};

export interface KnowledgeIngestOptions {
  tempRoot: string;
  scan(path: string, signal?: AbortSignal): Promise<import("./ingestion.js").AntivirusResult>;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch?(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Размер пачки эмбеддингов — та же настройка, что у индексации. */
  embedBatchSize?(): number;
  /** Считать ли старые векторы pgvector; false при hybrid/vector + qdrant. */
  legacyEmbeddings?(): boolean;
  /** Нарезка читается при каждом задании: панель меняет её без перезапуска. */
  chunking?(): ChunkingOptions;
  /**
   * Индексация в Qdrant: задание пишется в той же транзакции, что и
   * фрагменты. Упади процесс между COMMIT и постановкой в очередь — задание
   * всё равно в `job_outbox`, и публикатор его отправит.
   */
  index?: KnowledgeIndexScheduler;
}

interface UploadRow {
  storage_path: string;
  name: string;
  mime: string;
  status: string;
  content_hash: string;
  collection_id: string | null;
  replaces_document_id: string | null;
}

interface PreviousRow {
  id: string;
  revision: number;
}

type IngestOutcome = { kind: "duplicate"; documentId: string } | { kind: "new" | "new_version"; documentId: string };

/**
 * Разбор загрузки в документ: личная база (владелец из конверта) или
 * общая (владельца нет, коллекция — из записи приёма).
 *
 *   * Тот же файл (хэш содержимого) уже есть у владельца или в коллекции —
 *     второй документ не заводится, загрузка помечается дубликатом.
 *   * Новая версия — явная замена (`replaces_document_id`) или, в общей
 *     базе, файл с тем же именем в той же коллекции. В личной базе по
 *     имени не угадывается: у разных записей бывает одно имя файла, и
 *     угадка удалила бы чужую по смыслу запись.
 *   * Прежняя версия снимается после индексации новой (`indexer.ts`), а
 *     при выключенной индексации — сразу, в той же транзакции.
 */
export class KnowledgeIngestWorker {
  constructor(private readonly db: Database, private readonly options: KnowledgeIngestOptions) {}

  async run(context: JobContext): Promise<void> {
    const id = context.envelope.payloadRef;
    if (!isKnowledgeId(id)) throw new Error("knowledge_upload_invalid");
    const owner = knowledgeOwner(context.envelope.userId);
    try {
      await this.scoped(owner, async () => await this.ingest(id, owner, context.signal));
    } catch (error) {
      const cancelled = context.signal.aborted;
      await this.scoped(owner, async () =>
        await this.finish(id, owner, cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : errorCode(error))).catch(() => undefined);
      throw error;
    }
  }

  private async ingest(id: string, owner: KnowledgeOwner, signal: AbortSignal): Promise<void> {
    const upload = await this.upload(id, owner);
    // Записи приёма нет — человек очистил базу, пока задание ждало
    // повтора: разбирать нечего, и повторять задание незачем.
    if (!upload) return;
    // Повтор задания после удачного приёма: документ уже заведён.
    if (upload.status === "ready") return;
    if (signal.aborted) {
      await this.finish(id, owner, "cancelled", "cancelled");
      return;
    }
    await this.setProcessing(id, owner);

    // Дубликат ищется до разбора: одинаковый файл не стоит ни антивируса,
    // ни векторов.
    const duplicate = await this.db.transaction(async (client) => {
      const found = await this.duplicateOf(client, upload, owner);
      if (found) await this.markDuplicate(client, id, owner, found);
      return found;
    });
    if (duplicate) {
      await rm(upload.storage_path, { force: true });
      return;
    }
    const bytes = await readFile(upload.storage_path);
    const chunks: KnowledgeChunk[] = [];
    const ingestor = new DocumentIngestor({
      tempRoot: this.options.tempRoot,
      scan: this.options.scan,
      embed: this.options.embed,
      legacyEmbeddings: this.options.legacyEmbeddings?.() ?? true,
      ...(this.options.embedBatch ? { embedBatch: this.options.embedBatch } : {}),
      ...(this.options.embedBatchSize ? { embedBatchSize: this.options.embedBatchSize() } : {}),
      ...(this.options.chunking ? { chunking: this.options.chunking() } : {}),
      persist: async (items) => { chunks.push(...items); },
    });
    await ingestor.ingest({
      documentId: id,
      userId: owner.kind === "user" ? owner.userId : null,
      verifiedProduct: owner.kind === "global",
      name: upload.name,
      mime: upload.mime,
      bytes,
    }, signal);

    const outcome = await this.db.transaction(async (client): Promise<IngestOutcome> => {
      // Два одинаковых файла, разобранных одновременно, иначе оба прошли
      // бы проверку дубликата: владелец (или коллекция) — одна очередь.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`knowledge:${owner.kind === "user" ? owner.userId : upload.collection_id}`]);
      const late = await this.duplicateOf(client, upload, owner);
      if (late) {
        await this.markDuplicate(client, id, owner, late);
        return { kind: "duplicate", documentId: late };
      }
      // Прежняя версия — под той же блокировкой: два файла с одним именем,
      // разобранные одновременно, иначе оба сочли бы себя второй ревизией
      // первого, и живыми остались бы обе.
      const previous = await this.previousVersion(client, upload, owner);
      await this.insertDocument(client, id, owner, upload, previous, chunks);
      if (this.options.index?.enabled()) {
        await this.options.index.schedule(client, { documentId: id, userId: owner.kind === "user" ? owner.userId : null, reason: "ingest" });
      } else if (previous && this.options.index) {
        // Индексации нет — ждать нечего: прежняя версия снимается сразу,
        // иначе поиск находил бы обе.
        await deleteKnowledgeDocuments(client, owner, [previous.id], this.options.index);
      }
      const kind = previous ? "new_version" : "new";
      await this.finishReady(client, id, owner, id, kind);
      return { kind, documentId: id };
    });
    if (outcome.kind === "duplicate") await rm(upload.storage_path, { force: true });
  }

  private async insertDocument(
    client: JobOutboxClient,
    id: string,
    owner: KnowledgeOwner,
    upload: UploadRow,
    previous: PreviousRow | null,
    chunks: KnowledgeChunk[],
  ): Promise<void> {
    const revision = previous ? previous.revision + 1 : 1;
    if (owner.kind === "user") {
      await client.query(
        `INSERT INTO knowledge_documents(id,user_id,name,mime,content_hash,status,size_bytes,chunk_count,revision,replaces_document_id,source)
         SELECT id,user_id,name,mime,content_hash,'ready',size_bytes,$3,$4,$5,'upload'
           FROM knowledge_uploads WHERE id=$1 AND user_id=$2`,
        [id, owner.userId, chunks.length, revision, previous?.id ?? null],
      );
    } else {
      await client.query(
        `INSERT INTO knowledge_documents(id,user_id,product_verified,collection_id,name,mime,content_hash,status,size_bytes,chunk_count,revision,replaces_document_id,source)
         SELECT id,NULL,true,collection_id,name,mime,content_hash,'ready',size_bytes,$2,$3,$4,'admin'
           FROM knowledge_uploads
           -- tenant: system — загрузка администратора в общую базу
          WHERE id=$1 AND user_id IS NULL AND collection_id IS NOT NULL`,
        [id, chunks.length, revision, previous?.id ?? null],
      );
    }
    const userId = owner.kind === "user" ? owner.userId : null;
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO knowledge_chunks(document_id,user_id,product_verified,ordinal,content,content_hash,embedding,embedding_model,
                                      page_start,page_end,section,subsection,heading,token_count)
         VALUES($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id, userId, userId === null, chunk.ordinal, chunk.content, chunk.contentHash,
          chunk.embedding ? `[${chunk.embedding.join(",")}]` : null, "router",
          chunk.pageStart, chunk.pageEnd, chunk.section, chunk.subsection, chunk.heading, chunk.tokenCount,
        ],
      );
    }
  }

  private async upload(id: string, owner: KnowledgeOwner): Promise<UploadRow | null> {
    const { rows } = owner.kind === "user"
      ? await this.db.query<UploadRow>(
        `SELECT storage_path,name,mime,status,content_hash,collection_id,replaces_document_id
           FROM knowledge_uploads WHERE id=$1 AND user_id=$2`,
        [id, owner.userId],
      )
      : await this.db.query<UploadRow>(
        `SELECT storage_path,name,mime,status,content_hash,collection_id,replaces_document_id
           FROM knowledge_uploads
           -- tenant: system — загрузка администратора в общую базу
          WHERE id=$1 AND user_id IS NULL AND collection_id IS NOT NULL`,
        [id],
      );
    return rows[0] ?? null;
  }

  /** Документ с тем же содержимым у того же владельца (в той же коллекции). */
  private async duplicateOf(client: JobOutboxClient, upload: UploadRow, owner: KnowledgeOwner): Promise<string | null> {
    const { rows } = owner.kind === "user"
      ? await client.query<{ id: string }>(
        `SELECT id FROM knowledge_documents
          WHERE user_id=$1 AND content_hash=$2 AND status='ready'
          ORDER BY created_at LIMIT 1`,
        [owner.userId, upload.content_hash],
      )
      : await client.query<{ id: string }>(
        `SELECT id FROM knowledge_documents
          -- tenant: system — дубликат ищется внутри коллекции общей базы
          WHERE user_id IS NULL AND product_verified AND collection_id=$1 AND content_hash=$2 AND status='ready'
          ORDER BY created_at LIMIT 1`,
        [upload.collection_id, upload.content_hash],
      );
    return rows[0] ? String(rows[0].id) : null;
  }

  private async previousVersion(client: JobOutboxClient, upload: UploadRow, owner: KnowledgeOwner): Promise<PreviousRow | null> {
    if (owner.kind === "user") {
      if (!upload.replaces_document_id) return null;
      const { rows } = await client.query<PreviousRow>(
        "SELECT id,revision FROM knowledge_documents WHERE id=$1 AND user_id=$2",
        [upload.replaces_document_id, owner.userId],
      );
      return rows[0] ? { id: String(rows[0].id), revision: Number(rows[0].revision) } : null;
    }
    // Общая база: явная замена или тот же файл по имени в той же коллекции.
    const { rows } = await client.query<PreviousRow>(
      `SELECT id,revision FROM knowledge_documents
        -- tenant: system — прежняя версия документа в коллекции общей базы
        WHERE user_id IS NULL AND product_verified AND collection_id=$1
          AND (id=$2 OR ($2::uuid IS NULL AND name=$3))
        ORDER BY revision DESC, created_at DESC LIMIT 1`,
      [upload.collection_id, upload.replaces_document_id, upload.name],
    );
    return rows[0] ? { id: String(rows[0].id), revision: Number(rows[0].revision) } : null;
  }

  private async setProcessing(id: string, owner: KnowledgeOwner): Promise<void> {
    if (owner.kind === "user") {
      await this.db.query("UPDATE knowledge_uploads SET status='processing',started_at=now(),error_code=NULL WHERE id=$1 AND user_id=$2", [id, owner.userId]);
    } else {
      await this.db.query(
        `UPDATE knowledge_uploads
            -- tenant: system — загрузка администратора в общую базу
            SET status='processing',started_at=now(),error_code=NULL
          WHERE id=$1 AND user_id IS NULL`,
        [id],
      );
    }
  }

  private async markDuplicate(client: JobOutboxClient, id: string, owner: KnowledgeOwner, documentId: string): Promise<void> {
    await this.finishReady(client, id, owner, documentId, "duplicate");
  }

  private async finishReady(
    client: JobOutboxClient,
    id: string,
    owner: KnowledgeOwner,
    documentId: string,
    outcome: "new" | "duplicate" | "new_version",
  ): Promise<void> {
    if (owner.kind === "user") {
      await client.query(
        "UPDATE knowledge_uploads SET status='ready',outcome=$3,document_id=$4,completed_at=now() WHERE id=$1 AND user_id=$2",
        [id, owner.userId, outcome, documentId],
      );
    } else {
      await client.query(
        `UPDATE knowledge_uploads
            -- tenant: system — загрузка администратора в общую базу
            SET status='ready',outcome=$2,document_id=$3,completed_at=now()
          WHERE id=$1 AND user_id IS NULL`,
        [id, outcome, documentId],
      );
    }
  }

  private async finish(id: string, owner: KnowledgeOwner, status: "failed" | "cancelled", code: string): Promise<void> {
    if (owner.kind === "user") {
      await this.db.query(
        "UPDATE knowledge_uploads SET status=$3,error_code=$4,completed_at=now() WHERE id=$1 AND user_id=$2",
        [id, owner.userId, status, code],
      );
    } else {
      await this.db.query(
        `UPDATE knowledge_uploads
            -- tenant: system — загрузка администратора в общую базу
            SET status=$2,error_code=$3,completed_at=now()
          WHERE id=$1 AND user_id IS NULL`,
        [id, status, code],
      );
    }
  }

  /** Общая база — системная область с доступом к строкам без владельца (см. `indexer.ts`). */
  private async scoped<T>(owner: KnowledgeOwner, work: () => Promise<T>): Promise<T> {
    return owner.kind === "global"
      ? await this.db.withSystemScope("knowledge.ingest.global", work, { crossUser: true })
      : await this.db.withUserScope({ userId: owner.userId, label: "knowledge.ingest", inherit: true }, work);
  }
}
