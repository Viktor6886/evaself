import type { Database } from "../db.js";
import type { PoolClient } from "pg";
import { OutboundGateway } from "../admin/outbound-gateway.js";
import type { ResearchReport } from "./orchestrator.js";

export class ResearchRepository {
  constructor(private readonly db: Database) {}
  async save(report: ResearchReport): Promise<void> {
    await this.db.withUserScope({ userId: report.userId, label: "research.save", inherit: true }, async () => this.db.transaction(async client => {
      await this.saveWithCompletion(client,report);
    }));
  }
  async saveWithCompletion(client:Pick<PoolClient,"query">,report:ResearchReport,completion?:{requestId:string;chatId:number}):Promise<void>{
      await client.query(`INSERT INTO research_reports(id,user_id,conversation_id,summary,confidence,checked_at,report_json,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'completed')`, [report.id, report.userId, report.conversationId, report.summary, report.confidence, report.checkedAt, JSON.stringify(report)]);
      for (const source of report.sources) await client.query(`INSERT INTO research_sources(id,report_id,user_id,url,canonical_url,domain,title,author,published_at,retrieved_at,content_hash,content_type,language,relevance,quality,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [source.id, report.id, report.userId, source.url, source.canonicalUrl, source.domain, source.title, source.author, source.publishedAt, source.retrievedAt, source.contentHash, source.type, source.language, source.relevance, source.quality, source.status]);
      for (const claim of report.claims) await client.query(`INSERT INTO research_claim_sources(report_id,user_id,source_id,claim,evidence_quote,evidence_start,evidence_end,evidence_hash,contradiction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [report.id, report.userId, claim.sourceId, claim.claim,claim.evidenceQuote,claim.evidenceStart,claim.evidenceEnd, claim.evidenceHash, claim.contradiction]);
      if(completion){await client.query(`UPDATE research_requests SET status='completed',report_id=$3,completed_at=now() WHERE id=$1 AND user_id=$2`,[completion.requestId,report.userId,report.id]);const link=`/app/research/${report.id}`;await client.query(`INSERT INTO telegram_outbox(idempotency_key,user_id,chat_id,telegram_method,payload,priority) VALUES($1,$2,$3,'sendMessage',$4::jsonb,0) ON CONFLICT(idempotency_key) DO NOTHING`,[`research-summary:${report.id}`,report.userId,completion.chatId,JSON.stringify({chat_id:completion.chatId,text:`${report.summary||"Исследование завершено"}\n\nПолный отчёт: ${link}`})]);}
  }
}

export class SearxCrawlAdapters {
  private readonly gateway: Pick<OutboundGateway, "request">;
  constructor(private readonly searxUrl: string, private readonly crawlUrl: string, gateway?: Pick<OutboundGateway, "request">) {
    this.gateway = gateway ?? new OutboundGateway({ allowlist: [new URL(searxUrl).hostname, new URL(crawlUrl).hostname], maxBodyBytes: 4 * 1024 * 1024 });
  }
  async search(query: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const url = new URL("search", this.searxUrl); url.searchParams.set("q", query); url.searchParams.set("format", "json");
    const response = await this.gateway.request(url.toString(), { signal });
    if (!response.ok) throw new Error("searx_search_failed");
    const body = response.json<{ results?: Array<{url?:string;title?:string}> }>();
    return (body.results ?? []).flatMap(x => x.url ? [{url:x.url,title:x.title ?? x.url}] : []);
  }
  async read(url: string, signal: AbortSignal, maxBytes: number) {
    signal.throwIfAborted();
    await new OutboundGateway().validate(url);
    const response = await this.gateway.request(new URL("crawl", this.crawlUrl).toString(), { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({urls:[url]}), signal });
    if (!response.ok) throw new Error("crawl4ai_read_failed");
    const payload=response.json<{results?:Array<{url?:string;markdown?:string|{raw_markdown?:string};html?:string;metadata?:{title?:string;author?:string;language?:string}}>}>();const item=payload.results?.[0];if(!item)throw new Error("crawl4ai_schema_invalid");const content=typeof item.markdown==="string"?item.markdown:item.markdown?.raw_markdown??item.html;if(typeof content!=="string")throw new Error("crawl4ai_schema_invalid");if(Buffer.byteLength(content)>maxBytes)throw new Error("crawl4ai_page_too_large");
    return {url:item.url??url,content,title:item.metadata?.title??url,author:item.metadata?.author,language:item.metadata?.language};
  }
}
