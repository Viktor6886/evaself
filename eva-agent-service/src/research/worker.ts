import type { Database } from "../db.js";

import type { JobContext } from "../jobs/runtime.js";
import { QUEUE_TIMING, type JobTimingPolicy } from "../jobs/policy.js";
import type { LlmRouterClient } from "../router/client.js";
import { structuredStrict } from "../knowledge/structured-output.js";
import {
  FACTS_INSTRUCTION,
  QUERIES_INSTRUCTION,
  parseFacts,
  parseQueries,
} from "./schema.js";
import { SearxCrawlAdapters, ResearchRepository } from "./adapters.js";
import { ResearchOrchestrator, type ResearchReport } from "./orchestrator.js";
import type { DelegatedResearch } from "./delegation.js";

/**
 * Срок, который конвейер исследования получал один, — мягкий срок класса
 * research. После неудачного делегирования он должен остаться целиком.
 */
export const RESEARCH_PIPELINE_RESERVE_MS = QUEUE_TIMING.research.softTimeoutMs;
/** Меньше этого субагенты не успеют ни одной фазы — делегирование пропускается. */
const MIN_DELEGATION_BUDGET_MS = 30_000;
/** Последовательные фазы делегирования: поиск ∥ документы → страницы → сводка. */
const DELEGATION_PHASES = 3;
/** Зазор между мягким сроком и жёстким дедлайном класса. */
const HARD_DEADLINE_MARGIN_MS = 60_000;
/**
 * Запас сверх срока конвейера. Таймер задания заведён до чтения запроса
 * и создания субагентов, а свой таймер конвейер заводит только после
 * делегирования; без запаса таймер задания срабатывал первым и обрывал
 * конвейер у самого конца его срока. Сюда же входит сохранение отчёта.
 */
export const PIPELINE_HEADROOM_MS = 20_000;

/**
 * Сроки задания исследования при включённом делегировании.
 *
 * Мягкий срок класса research рассчитан на конвейер. На том же сроке
 * субагенты с тремя последовательными фазами обрывались сигналом
 * задания раньше, чем запускался запасной конвейер, и исследование
 * кончалось отменой вместо отчёта. Поэтому срок задания — конвейер плюс
 * бюджет делегирования, а бюджет ограничен так, чтобы мягкий срок
 * остался раньше жёсткого дедлайна.
 */
export function researchJobTiming(delegationTimeoutMs: number): Partial<JobTimingPolicy> {
  const base = QUEUE_TIMING.research;
  const budget = Math.min(
    DELEGATION_PHASES * delegationTimeoutMs,
    base.hardDeadlineMs - base.softTimeoutMs - PIPELINE_HEADROOM_MS - HARD_DEADLINE_MARGIN_MS,
  );
  return { softTimeoutMs: base.softTimeoutMs + PIPELINE_HEADROOM_MS + budget };
}

/**
 * Бюджет делегирования — от времени, которое заданию действительно
 * осталось, а не от номинального срока: после него конвейеру должны
 * остаться его срок и запас.
 */
export function delegationBudgetMs(softDeadlineAt: number, now = Date.now()): number {
  return softDeadlineAt - now - RESEARCH_PIPELINE_RESERVE_MS - PIPELINE_HEADROOM_MS;
}

/**
 * Выполнить работу в своём бюджете внутри срока задания.
 *
 * Свой срок истёк или работа отказала — `null`, и вызывающий переходит к
 * запасному пути. Прерван сам сигнал задания (отмена, потеря аренды,
 * дедлайн) — отказ пробрасывается: начинать сначала другим способом
 * работу, которую отменили, нельзя.
 */
export async function withinBudget<T>(
  signal: AbortSignal,
  budgetMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const own = new AbortController();
  const follow = () => own.abort(signal.reason);
  if (signal.aborted) follow();
  else signal.addEventListener("abort", follow, { once: true });
  const timer = setTimeout(() => own.abort(new Error("delegation_budget_exceeded")), budgetMs);
  try {
    return await work(own.signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", follow);
  }
}

export class ResearchJobWorker {
  /**
   * Исследование субагентами, если оно включено. Ничего не нашедшее
   * делегирование (`DelegationError`) и недоступный Letta уступают
   * конвейеру: человек получает отчёт, а не отказ. Отмена задания —
   * не повод начинать сначала другим способом.
   */
  private async delegated(input: { userId: number; conversationId: string; query: string; requestId: string; signal: AbortSignal; softDeadlineAt: number }): Promise<ResearchReport | null> {
    const delegation = this.options.delegation;
    if (!delegation?.enabled()) return null;
    // Делегированию — всё, что задание получило сверх срока конвейера:
    // конвейер обязан успеть и после неудачного делегирования.
    const budgetMs = delegationBudgetMs(input.softDeadlineAt);
    if (budgetMs < MIN_DELEGATION_BUDGET_MS) return null;
    return await withinBudget(input.signal, budgetMs, async (signal) => {
      const research = await delegation.create({ userId: input.userId, conversationId: input.conversationId, requestId: input.requestId });
      return await research.run({ userId: input.userId, conversationId: input.conversationId, query: input.query, reportId: input.requestId, signal });
    });
  }

  constructor(
    private readonly db: Database,
    _outbox: unknown,
    private readonly options: {
      searxUrl: string;
      crawlUrl: string;
      /** Токен Crawl4AI: без него сервис отвечает отказом на каждое чтение. */
      crawlToken?: string;
      router: LlmRouterClient;
      /**
       * Исследование субагентами Letta (`./delegation.ts`). Флаг
       * спрашивается на каждом задании; выключен — работает конвейер.
       */
      delegation?: {
        enabled(): boolean;
        create(input: { userId: number; conversationId: string; requestId: string }): Promise<DelegatedResearch>;
      };
    },
  ) {}
  async run(context: JobContext): Promise<void> {
    // Таймер задания заведён перед вызовом обработчика: отсчёт отсюда
    // отстаёт от него на миллисекунды, их покрывает запас конвейера.
    const softDeadlineAt = Date.now() + context.timing.softTimeoutMs;
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
      const report=await this.delegated({userId,conversationId:row.conversation_id,query:row.query,requestId,signal:context.signal,softDeadlineAt})
        ?? await orchestrator.run({userId,conversationId:row.conversation_id,query:row.query,signal:context.signal,reportId:requestId});
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
