import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { sanitizeUntrustedContent } from "./security.js";
import {
  SUPPORTED_DOCUMENT_MIME,
  extractDocumentText,
} from "./document-text.js";

export interface IngestRequest { documentId?: string; userId: number | null; name: string; mime: string; bytes: Buffer; verifiedProduct?: boolean }
export interface KnowledgeChunk { documentId?: string; userId: number | null; productVerified: boolean; ordinal: number; content: string; embedding: number[] }
export type AntivirusResult="clean"|"infected"|"unavailable";
export interface IngestDependencies { tempRoot: string; maxBytes?: number; maxPages?: number; maxDocxEntries?:number; maxDocxParagraphs?:number; maxDocxSections?:number; scan(path: string, signal?: AbortSignal): Promise<AntivirusResult>; embed(text: string, signal?: AbortSignal): Promise<number[]>; persist(chunks: KnowledgeChunk[], signal?: AbortSignal): Promise<void> }
// Разбор файла общий с Telegram-вложениями: второго парсера, а с ним и
// второго набора проверок на подделку типа и zip-бомбу, быть не должно.
const MIME = SUPPORTED_DOCUMENT_MIME;

export class DocumentIngestor {constructor(private readonly dependencies:IngestDependencies){}async ingest(request:IngestRequest,signal?:AbortSignal):Promise<{chunks:number}>{
 if(!MIME.has(request.mime))throw new Error("document_type_unsupported");if(!request.bytes.length||request.bytes.byteLength>(this.dependencies.maxBytes??10*1024*1024))throw new Error("document_too_large");if(!request.verifiedProduct&&request.userId===null)throw new Error("document_owner_required");
 const directory=await mkdtemp(join(this.dependencies.tempRoot,"eva-knowledge-"));try{signal?.throwIfAborted();const path=join(directory,"input");await writeFile(path,request.bytes,{mode:0o600});const av=await this.dependencies.scan(path,signal);if(av!=="clean")throw new Error(av==="infected"?"document_antivirus_infected":"document_antivirus_unavailable");const pages=await extractDocumentText(request.bytes,request.mime,{pages:this.dependencies.maxPages??200,entries:this.dependencies.maxDocxEntries??2000,paragraphs:this.dependencies.maxDocxParagraphs??20_000,sections:this.dependencies.maxDocxSections??500});const splitter=new RecursiveCharacterTextSplitter({chunkSize:1200,chunkOverlap:120});const docs=await splitter.createDocuments(pages.map(p=>sanitizeUntrustedContent(p.normalize("NFKC"))));const chunks:KnowledgeChunk[]=[];for(let ordinal=0;ordinal<docs.length;ordinal++){signal?.throwIfAborted();const content=docs[ordinal]!.pageContent;const embedding=await this.dependencies.embed(content,signal);if(embedding.length!==1536)throw new Error("embedding_dimension_invalid");chunks.push({documentId:request.documentId,userId:request.userId,productVerified:request.verifiedProduct===true,ordinal,content,embedding});}await this.dependencies.persist(chunks,signal);return{chunks:chunks.length};}finally{await rm(directory,{recursive:true,force:true});}
}}
