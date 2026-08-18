import type { Database } from "../db.js";

import type { JobContext } from "../jobs/runtime.js";
import type { LlmRouterClient } from "../router/client.js";
import { structuredStrict } from "../knowledge/structured-output.js";
import {
  FACTS_INSTRUCTION,
  QUERIES_INSTRUCTION,
  parseFacts,
  parseQueries,
} from "./schema.js";
import { SearxCrawlAdapters, ResearchRepository } from "./adapters.js";
import { ResearchOrchestrator } from "./orchestrator.js";

export class ResearchJobWorker {
  constructor(
    private readonly db: Database,
    _outbox: unknown,
    private readonly options: {
      searxUrl: string;
      crawlUrl: string;
      /** Токен Crawl4AI: без него сервис отвечает отказом на каждое чтение. */
      crawlToken?: string;
      router: LlmRouterClient;
    },
  ) {}
  async run(context: JobContext): Promise<void> {
    const requestId = context.envelope.payloadRef;
    const userId = context.envelope.userId;
    if (!requestId || userId === null) throw new Error("research_request_invalid");
    try { await this.db.withUserScope({userId,label:"research.run",inherit:true}, async () => {
      const {rows} = await this.db.query<{query:string;conversation_id:string;agent_id:string;chat_id:string|number}>(`SELECT r.query,r.conversation_id,r.agent_id,u.telegram_id AS chat_id FROM research_requests r JOIN users u ON u.id=r.user_id WHERE r.id=$1 AND r.user_id=$2 FOR UPDATE`,[requestId,userId]);
      const row=rows[0]; if(!row) throw new Error("research_request_missing");
      await this.db.query(`UPDATE research_requests SET status='processing',started_at=now() WHERE id=$1 AND user_id=$2`,[requestId,userId]);
      const web = new SearxCrawlAdapters(this.options.searxUrl, this.options.crawlUrl, {
        crawlToken: this.options.crawlToken,
      });
      let reportResult:import("./orchestrator.js").ResearchReport|undefined;
      // План и разбор идут через роутер и по одной схеме с парсером
      // (`./schema.ts`). Схема, не сошедшаяся за отведённые попытки, —
      // это отказ: молчаливый ноль фактов выглядел бы успешным разбором.
      const ask = async (
        content: string,
        systemPrompt: string,
        repair: boolean,
        signal: AbortSignal,
      ): Promise<string> => await this.options.router.complete({
        model: "eva/json",
        messages: [{ role: "user", content }],
        system_prompt: systemPrompt,
        response_format: { type: "json_object" },
        metadata: { route: "json", sensitive: true },
        repair,
      }, signal);

      const orchestrator = new ResearchOrchestrator({
        plan: async (query, maxQueries, signal) => await structuredStrict({
          complete: async ({ repair }) =>
            await ask(JSON.stringify({ query, maxQueries }), QUERIES_INSTRUCTION(maxQueries), repair, signal),
          parse: (raw) => parseQueries(raw, maxQueries),
        }, { signal, code: "research_query_plan_invalid" }),
        search: (query, signal) => web.search(query, signal),
        read: (url, signal, maxBytes) => web.read(url, signal, maxBytes),
        extract: async (content, signal) => await structuredStrict({
          complete: async ({ repair }) => await ask(content, FACTS_INSTRUCTION, repair, signal),
          parse: parseFacts,
        }, { signal, code: "research_schema_invalid" }),
        save: async (report) => { reportResult = report; },
      }, {
        maxQueries: Number(process.env.EVA_RESEARCH_MAX_QUERIES ?? 3),
        maxSources: Number(process.env.EVA_RESEARCH_MAX_SOURCES ?? 12),
        maxPagesPerDomain: Number(process.env.EVA_RESEARCH_MAX_PAGES_DOMAIN ?? 2),
        timeoutMs: Number(process.env.EVA_RESEARCH_TIMEOUT_MS ?? 120_000),
        tokenBudget: Number(process.env.EVA_RESEARCH_TOKEN_BUDGET ?? 20_000),
        maxPageBytes: Number(process.env.EVA_RESEARCH_MAX_PAGE_BYTES ?? 512_000),
        maxConcurrency: Number(process.env.EVA_RESEARCH_CONCURRENCY ?? 4),
      });
      const report=await orchestrator.run({userId,conversationId:row.conversation_id,query:row.query,signal:context.signal,reportId:requestId});
      const repository=new ResearchRepository(this.db);await this.db.transaction(async client=>await repository.saveWithCompletion(client,reportResult??report,{requestId,chatId:Number(row.chat_id)}));
    }); } catch(error) {
      const cancelled=context.signal.aborted;
      await this.db.withUserScope({userId,label:"research.terminal",inherit:true},async()=>await this.db.transaction(async client=>{
        await client.query(`UPDATE research_requests SET status=$3,completed_at=now(),error_code=$4 WHERE id=$1 AND user_id=$2 AND status <> 'completed'`,[requestId,userId,cancelled?'cancelled':'failed',cancelled?'cancelled':error instanceof Error?error.message.slice(0,120):'unknown']);
      })).catch(()=>undefined);
      throw error;
    }
  }
}
