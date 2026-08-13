import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "../db.js";
import type { JobOutbox } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobContext } from "../jobs/runtime.js";
import type { Readable } from "node:stream";
import { DocumentIngestor, type KnowledgeChunk } from "./ingestion.js";

export const KNOWLEDGE_INGEST_JOB = "knowledge_ingest";
const ALLOWED = new Set(["text/plain","text/markdown","application/json","text/html","application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

export class KnowledgeUploadService {
  constructor(private readonly db: Database, private readonly jobs: JobOutbox, private readonly root: string, private readonly maxBytes=10*1024*1024) {}
  private async internalUser(telegramId:number):Promise<number>{return await this.db.withSystemScope("verified-identity.resolve",async()=>{const {rows}=await this.db.query<{id:string}>("SELECT id FROM users WHERE telegram_id=$1",[telegramId]);if(!rows[0])throw new Error("upload_user_missing");return Number(rows[0].id);},{inherit:true});}
  async createFromStream(telegramId:number,input:{name:string;mime:string;stream:Readable;truncated?:()=>boolean}):Promise<{id:string;status:string}>{
    const userId=await this.internalUser(telegramId); if(!ALLOWED.has(input.mime))throw new Error("document_type_unsupported");
    const id=randomUUID(); const dir=resolve(this.root,String(userId)); await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,id);const hash=createHash("sha256");let size=0;const file=await open(path,"wx",0o600);
    try { for await(const value of input.stream){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);size+=chunk.length;if(size>this.maxBytes)throw new Error("document_too_large");hash.update(chunk);await file.write(chunk);}await file.sync();await file.close();if(size===0||input.truncated?.())throw new Error(size===0?"document_empty":"document_too_large");
      return await this.db.withUserScope({userId,label:"knowledge.upload",inherit:true},async()=>await this.db.transaction(async client=>{await client.query("INSERT INTO knowledge_uploads(id,user_id,name,mime,size_bytes,content_hash,storage_path,status) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')",[id,userId,input.name,input.mime,size,hash.digest("hex"),path]);await this.jobs.record(client,{type:KNOWLEDGE_INGEST_JOB,queue:"memory",userId,traceId:id,correlationId:id,idempotencyKey:jobIdempotencyKey({type:KNOWLEDGE_INGEST_JOB,userId,discriminator:id}),payloadRef:id,payload:{upload_id:id},deadlineMs:10*60_000,timezone:"UTC",source:"user",privacy:"restricted"});return{id,status:"queued"};}));
    } catch(error){await file.close().catch(()=>undefined);await rm(path,{force:true});throw error;}
  }
  async status(telegramId:number,id:string){const userId=await this.internalUser(telegramId);const {rows}=await this.db.withUserScope({userId,label:"knowledge.status",inherit:true},async()=>await this.db.query("SELECT id,name,mime,size_bytes,status,error_code,document_id,created_at,completed_at FROM knowledge_uploads WHERE id=$1 AND user_id=$2",[id,userId]));return rows[0]??null;}
}

export class KnowledgeIngestWorker {
  constructor(private readonly db:Database,private readonly options:{tempRoot:string;scan(path:string,signal?:AbortSignal):Promise<import("./ingestion.js").AntivirusResult>;embed(text:string,signal?:AbortSignal):Promise<number[]>}){}
  async run(context:JobContext):Promise<void>{const id=context.envelope.payloadRef,userId=context.envelope.userId;if(!id||userId===null)throw new Error("knowledge_upload_invalid");let path:string|undefined;
    try{await this.db.withUserScope({userId,label:"knowledge.ingest",inherit:true},async()=>{const {rows}=await this.db.query<{storage_path:string;name:string;mime:string;status:string}>("SELECT storage_path,name,mime,status FROM knowledge_uploads WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,userId]);const row=rows[0];if(!row)throw new Error("knowledge_upload_missing");path=row.storage_path;if(context.signal.aborted){await this.db.query("UPDATE knowledge_uploads SET status='cancelled',completed_at=now() WHERE id=$1 AND user_id=$2",[id,userId]);return;}await this.db.query("UPDATE knowledge_uploads SET status='processing',started_at=now() WHERE id=$1 AND user_id=$2",[id,userId]);const bytes=await readFile(path);const chunks:KnowledgeChunk[]=[];const ingestor=new DocumentIngestor({tempRoot:this.options.tempRoot,scan:this.options.scan,embed:this.options.embed,persist:async c=>{chunks.push(...c); return;}});await ingestor.ingest({documentId:id,userId,name:row.name,mime:row.mime,bytes},context.signal);await this.db.transaction(async client=>{await client.query("INSERT INTO knowledge_documents(id,user_id,name,mime,content_hash,status) SELECT id,user_id,name,mime,content_hash,'ready' FROM knowledge_uploads WHERE id=$1 AND user_id=$2",[id,userId]);for(const chunk of chunks)await client.query("INSERT INTO knowledge_chunks(document_id,user_id,product_verified,ordinal,content,content_hash,embedding,embedding_model) VALUES($1,$2,false,$3,$4,$5,$6::vector,$7)",[id,userId,chunk.ordinal,chunk.content,createHash("sha256").update(chunk.content).digest("hex"),`[${chunk.embedding.join(",")}]`,`router`]);await client.query("UPDATE knowledge_uploads SET status='ready',document_id=$1,completed_at=now() WHERE id=$1 AND user_id=$2",[id,userId]);});});
    }catch(error){const cancelled=context.signal.aborted;await this.db.withUserScope({userId,label:"knowledge.terminal",inherit:true},async()=>await this.db.query("UPDATE knowledge_uploads SET status=$3,error_code=$4,completed_at=now() WHERE id=$1 AND user_id=$2",[id,userId,cancelled?"cancelled":"failed",cancelled?"cancelled":error instanceof Error?error.message:"unknown"])).catch(()=>undefined);throw error;}
  }
}
