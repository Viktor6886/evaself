import { createHash, randomUUID } from "node:crypto";
import { sanitizeUntrustedContent } from "../knowledge/security.js";
export interface ResearchLimits { maxQueries: number; maxSources: number; maxPagesPerDomain: number; timeoutMs: number; tokenBudget: number; maxPageBytes: number; maxConcurrency: number }
interface SearchResult { url: string; title: string }
interface Page { url: string; content: string; title: string; author?: string; publishedAt?: string; language?: string; type?: string }
interface Fact { claim: string; evidence: string; contradiction?: string }
export interface ResearchSource { id: string; url: string; canonicalUrl: string; domain: string; title: string; author: string | null; publishedAt: string | null; retrievedAt: string; contentHash: string; type: string; language: string; relevance: number; quality: number; status: "read" }
export interface ResearchClaim { claim: string; sourceId: string; evidenceQuote:string; evidenceStart:number; evidenceEnd:number; evidenceHash: string; contradiction: string | null }
export interface ResearchReport { id: string; userId: number; conversationId: string; summary: string; claims: ResearchClaim[]; sources: ResearchSource[]; confidence: number; checkedAt: string; memoryWritten: false }
interface Dependencies { plan(query: string, maxQueries: number, signal: AbortSignal): Promise<string[]>; search(query: string, signal: AbortSignal): Promise<SearchResult[]>; read(url: string, signal: AbortSignal, maxBytes: number): Promise<Page>; extract(content: string, signal: AbortSignal): Promise<Fact[]>; save(report: ResearchReport): Promise<void> }
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export class ResearchOrchestrator {
 constructor(private readonly dependencies: Dependencies, private readonly limits: ResearchLimits) {}
 async run(input:{userId:number;conversationId:string;query:string;signal:AbortSignal;reportId?:string;queries?:string[]}):Promise<ResearchReport>{
  input.signal.throwIfAborted(); const timeout=AbortSignal.timeout(this.limits.timeoutMs); const signal=AbortSignal.any([input.signal,timeout]);
  if(this.limits.maxQueries<3||this.limits.maxQueries>7) throw new Error("research_query_limit");
  const queries=input.queries??await this.dependencies.plan(input.query,this.limits.maxQueries,signal);if(queries.length<3||queries.length>this.limits.maxQueries)throw new Error("research_query_limit");
  const found=(await Promise.all(queries.map(q=>this.dependencies.search(q,signal)))).flat().slice(0,this.limits.maxSources); const seen=new Set<string>(); const domains=new Map<string,number>(); const selected:SearchResult[]=[];
  for(const item of found){let u:URL;try{u=new URL(item.url)}catch{continue}if(!["http:","https:"].includes(u.protocol))continue;u.hash="";u.searchParams.sort();const canonical=u.toString();if(seen.has(canonical))continue;const count=domains.get(u.hostname)??0;if(count>=this.limits.maxPagesPerDomain)continue;seen.add(canonical);domains.set(u.hostname,count+1);selected.push({...item,url:canonical});}
  const pages:Page[]=[]; for(let i=0;i<selected.length;i+=Math.max(1,this.limits.maxConcurrency)){signal.throwIfAborted(); pages.push(...await Promise.all(selected.slice(i,i+this.limits.maxConcurrency).map(x=>this.dependencies.read(x.url,signal,this.limits.maxPageBytes))));}
  const sources:ResearchSource[]=[];const claims:ResearchClaim[]=[];let tokens=0;
  for(const page of pages){signal.throwIfAborted();const raw=Buffer.from(page.content).subarray(0,this.limits.maxPageBytes).toString();tokens+=Math.ceil(raw.length/4);if(tokens>this.limits.tokenBudget)throw new Error("research_token_limit");const clean=sanitizeUntrustedContent(raw);const canonical=new URL(page.url);const source:ResearchSource={id:randomUUID(),url:page.url,canonicalUrl:canonical.toString(),domain:canonical.hostname,title:page.title,author:page.author??null,publishedAt:page.publishedAt??null,retrievedAt:new Date().toISOString(),contentHash:hash(raw),type:page.type??"text/html",language:page.language??"und",relevance:1,quality:0.5,status:"read"};sources.push(source);for(const fact of await this.dependencies.extract(clean,signal)){if(!clean.includes(fact.evidence))continue;claims.push({claim:fact.claim,sourceId:source.id,evidenceQuote:fact.evidence,evidenceStart:clean.indexOf(fact.evidence),evidenceEnd:clean.indexOf(fact.evidence)+fact.evidence.length,evidenceHash:hash(fact.evidence),contradiction:fact.contradiction??null});}}
  signal.throwIfAborted();const report:ResearchReport={id:input.reportId??randomUUID(),userId:input.userId,conversationId:input.conversationId,summary:claims.slice(0,3).map(x=>x.claim).join("; "),claims,sources,confidence:claims.length?Math.min(1,claims.length/sources.length):0,checkedAt:new Date().toISOString(),memoryWritten:false};await this.dependencies.save(report);return report;
 }
}
