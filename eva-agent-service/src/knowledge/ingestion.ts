import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import yauzl from "yauzl";
import { sanitizeUntrustedContent } from "./security.js";

export interface IngestRequest { documentId?: string; userId: number | null; name: string; mime: string; bytes: Buffer; verifiedProduct?: boolean }
export interface KnowledgeChunk { documentId?: string; userId: number | null; productVerified: boolean; ordinal: number; content: string; embedding: number[] }
export type AntivirusResult="clean"|"infected"|"unavailable";
export interface IngestDependencies { tempRoot: string; maxBytes?: number; maxPages?: number; maxDocxEntries?:number; maxDocxParagraphs?:number; maxDocxSections?:number; scan(path: string, signal?: AbortSignal): Promise<AntivirusResult>; embed(text: string, signal?: AbortSignal): Promise<number[]>; persist(chunks: KnowledgeChunk[], signal?: AbortSignal): Promise<void> }
const DOCX="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME = new Set(["text/plain", "text/markdown", "application/json", "text/html", "application/pdf", DOCX]);
const utf8=(b:Buffer)=>{const s=b.toString("utf8");if(Buffer.from(s,"utf8").compare(b)!==0)throw new Error("document_utf8_invalid");return s;};

async function validateDocx(buffer:Buffer,entriesLimit:number):Promise<void>{
 await new Promise<void>((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{if(error||!zip)return reject(new Error("document_docx_malformed"));let entries=0,total=0,hasContent=false,hasDocument=false;const fail=(code:string)=>{zip.close();reject(new Error(code));};zip.on("entry",entry=>{entries++;total+=entry.uncompressedSize;if(entries>entriesLimit||entry.uncompressedSize>10*1024*1024||total>30*1024*1024||entry.uncompressedSize>Math.max(1024,entry.compressedSize)*100)return fail("document_docx_zip_bomb");if(entry.fileName==="[Content_Types].xml")hasContent=true;if(entry.fileName==="word/document.xml")hasDocument=true;if(entry.fileName.includes("..")||entry.fileName.startsWith("/"))return fail("document_docx_entry_invalid");zip.readEntry();});zip.on("end",()=>hasContent&&hasDocument?resolve():reject(new Error("document_docx_malformed")));zip.on("error",()=>reject(new Error("document_docx_malformed")));zip.readEntry();}));
}
async function extract(buffer: Buffer, mime: string, limits:{pages:number;entries:number;paragraphs:number;sections:number}): Promise<string[]> {
 const detected=await fileTypeFromBuffer(buffer);
 if(mime==="application/pdf"){
  if(detected?.mime!=="application/pdf"||!buffer.subarray(0,5).equals(Buffer.from("%PDF-")))throw new Error("document_mime_mismatch");
  const parser=new PDFParse({data:buffer});try{let info;try{info=await parser.getInfo();}catch{throw new Error("document_pdf_malformed_or_encrypted");}if(info.total<1||info.total>limits.pages)throw new Error("document_pages_exceeded");try{return (await parser.getText()).pages.map(p=>p.text);}catch{throw new Error("document_pdf_malformed_or_encrypted");}}finally{await parser.destroy();}
 }
 if(mime===DOCX){if(detected?.mime!==DOCX)throw new Error("document_mime_mismatch");await validateDocx(buffer,limits.entries);let value:string;try{const result=await mammoth.extractRawText({buffer});if(result.messages.some(m=>m.type==="error"))throw new Error();value=result.value;}catch{throw new Error("document_docx_xml_invalid");}const paragraphs=value.split(/\r?\n/u).filter(Boolean);const sections=(value.match(/\f/gu)?.length??0)+1;if(paragraphs.length>limits.paragraphs)throw new Error("document_paragraphs_exceeded");if(sections>limits.sections)throw new Error("document_sections_exceeded");return paragraphs;}
 if(detected||buffer.includes(0))throw new Error("document_mime_mismatch");let text=utf8(buffer);if(mime==="application/json"){try{text=JSON.stringify(JSON.parse(text));}catch{throw new Error("document_json_invalid");}}
 if(mime==="text/html"&&!/<(?:!doctype|html|head|body|p|div|article|main)\b/i.test(text))throw new Error("document_html_invalid");const pages=text.split(/\f/u);if(pages.length>limits.pages)throw new Error("document_pages_exceeded");return pages;
}
export class DocumentIngestor {constructor(private readonly dependencies:IngestDependencies){}async ingest(request:IngestRequest,signal?:AbortSignal):Promise<{chunks:number}>{
 if(!MIME.has(request.mime))throw new Error("document_type_unsupported");if(!request.bytes.length||request.bytes.byteLength>(this.dependencies.maxBytes??10*1024*1024))throw new Error("document_too_large");if(!request.verifiedProduct&&request.userId===null)throw new Error("document_owner_required");
 const directory=await mkdtemp(join(this.dependencies.tempRoot,"eva-knowledge-"));try{signal?.throwIfAborted();const path=join(directory,"input");await writeFile(path,request.bytes,{mode:0o600});const av=await this.dependencies.scan(path,signal);if(av!=="clean")throw new Error(av==="infected"?"document_antivirus_infected":"document_antivirus_unavailable");const pages=await extract(request.bytes,request.mime,{pages:this.dependencies.maxPages??200,entries:this.dependencies.maxDocxEntries??2000,paragraphs:this.dependencies.maxDocxParagraphs??20_000,sections:this.dependencies.maxDocxSections??500});const splitter=new RecursiveCharacterTextSplitter({chunkSize:1200,chunkOverlap:120});const docs=await splitter.createDocuments(pages.map(p=>sanitizeUntrustedContent(p.normalize("NFKC"))));const chunks:KnowledgeChunk[]=[];for(let ordinal=0;ordinal<docs.length;ordinal++){signal?.throwIfAborted();const content=docs[ordinal]!.pageContent;const embedding=await this.dependencies.embed(content,signal);if(embedding.length!==1536)throw new Error("embedding_dimension_invalid");chunks.push({documentId:request.documentId,userId:request.userId,productVerified:request.verifiedProduct===true,ordinal,content,embedding});}await this.dependencies.persist(chunks,signal);return{chunks:chunks.length};}finally{await rm(directory,{recursive:true,force:true});}
}}
