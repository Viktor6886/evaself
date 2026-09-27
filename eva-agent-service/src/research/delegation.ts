/**
 * Исследование силами субагентов Letta.
 *
 *   research-субагент  — ищет источники (web_search)
 *   document-субагент  — ищет в базе знаний человека (knowledge_search)
 *          ↓ параллельно
 *   web-субагенты      — читают найденные страницы (web_read, браузер
 *                        только для чтения), по пачке адресов на каждого
 *          ↓
 *   проверка           — детерминированная, в коде
 *          ↓
 *   synthesis-субагент — сводка только по проверенным фактам
 *
 * Субагент получает ровно задание: вопрос и адреса. Ни профиля, ни
 * истории, ни памяти Евы. Инструменты — только чтение, владелец и квоты —
 * того, кто заказал исследование (`AgentToolFactory.forDelegation`).
 *
 * Проверка не доверяет субагенту на слово. Цитата принимается, только
 * если она дословно есть в тексте, который Evaself сам получил для
 * субагента, — ответы инструментов записываются здесь, в «книге
 * доказательств», до того как модель их увидела. Адрес факта должен быть
 * среди выданных этому субагенту. Выдуманная цитата или чужой адрес
 * выбрасываются и считаются в отчёте.
 *
 * Отчёт — той же формы, что у конвейера `ResearchOrchestrator`, и
 * сохраняется тем же `ResearchRepository`.
 */

import { createHash, randomUUID } from "node:crypto";

import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { LettaSubagentRunner, SubagentOutcome, SubagentRole, SubagentTask } from "../letta/subagents.js";
import { canonicalizeUrl, type ResearchClaim, type ResearchReport, type ResearchSource } from "./orchestrator.js";

/**
 * Инструменты ролей. Все — только чтение; `forDelegation` дополнительно
 * отсекает всё, чей риск не `read`, так что расширить набор здесь
 * инструментом записи нельзя. Браузер попадает в набор, только когда
 * он включён: иначе его инструментов в реестре нет.
 */
export const DELEGATION_TOOLS: Readonly<Record<SubagentRole, readonly string[]>> = Object.freeze({
  research: ["web_search"],
  web: ["web_read", "browser_open", "browser_snapshot", "browser_scroll", "browser_back", "browser_close"],
  document: ["knowledge_search"],
  synthesis: [],
});

export interface DelegationLimits {
  maxSources: number;
  maxPagesPerDomain: number;
  /** Сколько web-субагентов делят между собой источники. */
  maxWebAgents: number;
  maxFactsPerAgent: number;
}

export interface DelegationDependencies {
  runner: Pick<LettaSubagentRunner, "run">;
  /** Инструменты роли — только чтение, привязанные к заказчику. */
  tools(role: SubagentRole): AnyAgentTool[];
  limits: DelegationLimits;
}

export class DelegationError extends Error {
  constructor(readonly code: "delegation_no_sources" | "delegation_no_facts" | "delegation_cancelled") {
    super(code);
    this.name = "DelegationError";
  }
}

interface Page { url: string; title: string; content: string; language: string }
interface DocumentChunk { document: string; content: string }

/** Что инструменты действительно вернули субагентам. */
class EvidenceLedger {
  readonly pages = new Map<string, Page>();
  readonly documents: DocumentChunk[] = [];

  capture(toolName: string, details: unknown): void {
    if (!details || typeof details !== "object") return;
    const value = details as Record<string, unknown>;
    if (value.ok === false) return;
    if (toolName === "web_read" && typeof value.url === "string" && typeof value.content === "string") {
      this.page(value.url, String(value.title ?? value.url), value.content, String(value.language ?? "und"));
    }
    if (toolName.startsWith("browser_")) {
      const data = value.data as Record<string, unknown> | undefined;
      if (data && typeof data.url === "string" && typeof data.snapshot === "string") {
        this.page(data.url, String(data.title ?? data.url), data.snapshot, "und");
      }
    }
    if (toolName === "knowledge_search" && Array.isArray(value.results)) {
      for (const hit of value.results as Array<Record<string, unknown>>) {
        if (typeof hit.document === "string" && typeof hit.content === "string") {
          this.documents.push({ document: hit.document, content: hit.content });
        }
      }
    }
  }

  private page(url: string, title: string, content: string, language: string): void {
    const key = canonicalizeUrl(url) ?? url;
    const existing = this.pages.get(key);
    this.pages.set(key, { url, title, language, content: existing ? `${existing.content}\n${content}` : content });
  }
}

/** Первый JSON-объект ответа: модель иногда оборачивает его текстом или блоком кода. */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function normalizeQuote(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function contains(haystack: string, quote: string): number {
  return haystack.replace(/\s+/g, " ").indexOf(quote);
}

export class DelegatedResearch {
  constructor(private readonly deps: DelegationDependencies) {}

  async run(input: {
    userId: number;
    conversationId: string;
    query: string;
    reportId?: string;
    signal: AbortSignal;
  }): Promise<ResearchReport> {
    const ledger = new EvidenceLedger();
    const record = (role: SubagentRole): AnyAgentTool[] => this.deps.tools(role).map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<AnyAgentTool["execute"]>) => {
        const result = await tool.execute(...args);
        ledger.capture(tool.name, (result as { details?: unknown }).details);
        return result;
      },
    }) as AnyAgentTool);
    const task = (role: SubagentRole, brief: string): SubagentTask => ({ role, brief, tools: record(role) });
    const run = async (item: SubagentTask): Promise<SubagentOutcome> => await this.deps.runner.run(item, input.signal);

    const documentTools = this.deps.tools("document");
    const [research, documents] = await Promise.all([
      run(task("research", researchBrief(input.query, this.deps.limits.maxSources))),
      documentTools.length ? run(task("document", documentBrief(input.query))) : Promise.resolve(null),
    ]);
    if (input.signal.aborted) throw new DelegationError("delegation_cancelled");

    const sources = research.ok ? this.selectSources(extractJson(research.text)?.sources) : [];
    const groups = chunk(sources, this.deps.limits.maxWebAgents);
    const web = await Promise.all(groups.map(async (urls) => ({
      urls, outcome: await run(task("web", webBrief(input.query, urls, this.deps.limits.maxFactsPerAgent))),
    })));
    if (input.signal.aborted) throw new DelegationError("delegation_cancelled");

    const reportSources = new Map<string, ResearchSource>();
    const claims: ResearchClaim[] = [];
    let unverified = 0;
    let extractFailed = 0;
    const sourceFor = (key: string, make: () => ResearchSource): ResearchSource => {
      const existing = reportSources.get(key);
      if (existing) return existing;
      const created = make();
      reportSources.set(key, created);
      return created;
    };

    for (const { urls, outcome } of web) {
      const parsed = outcome.ok ? extractJson(outcome.text) : null;
      const facts = Array.isArray(parsed?.facts) ? parsed.facts.slice(0, this.deps.limits.maxFactsPerAgent) : null;
      if (!facts) { extractFailed += 1; continue; }
      const assigned = new Set(urls.map((url) => canonicalizeUrl(url) ?? url));
      for (const raw of facts as Array<Record<string, unknown>>) {
        const url = typeof raw.url === "string" ? canonicalizeUrl(raw.url) ?? raw.url : "";
        const claim = typeof raw.claim === "string" ? raw.claim.trim().slice(0, 1_000) : "";
        const quote = normalizeQuote(raw.evidence).slice(0, 1_000);
        const page = ledger.pages.get(url);
        const offset = page && quote.length >= 12 ? contains(page.content, quote) : -1;
        if (!assigned.has(url) || !claim || offset < 0 || !page) { unverified += 1; continue; }
        const source = sourceFor(url, () => {
          const parsedUrl = new URL(page.url);
          return {
            id: randomUUID(), url: page.url, canonicalUrl: url, domain: parsedUrl.hostname, title: page.title.slice(0, 500),
            author: null, publishedAt: null, retrievedAt: new Date().toISOString(), contentHash: hash(page.content),
            type: "text/html", language: page.language, relevance: 1, quality: 0.5, status: "read",
          };
        });
        claims.push({
          claim, sourceId: source.id, evidenceQuote: quote, evidenceStart: offset, evidenceEnd: offset + quote.length,
          evidenceHash: hash(quote), contradiction: typeof raw.contradiction === "string" ? raw.contradiction.slice(0, 500) : null,
        });
      }
    }

    if (documents?.ok) {
      const facts = extractJson(documents.text)?.facts;
      for (const raw of (Array.isArray(facts) ? facts.slice(0, this.deps.limits.maxFactsPerAgent) : []) as Array<Record<string, unknown>>) {
        const name = typeof raw.document === "string" ? raw.document.trim() : "";
        const claim = typeof raw.claim === "string" ? raw.claim.trim().slice(0, 1_000) : "";
        const quote = normalizeQuote(raw.evidence).slice(0, 1_000);
        const chunkHit = quote.length >= 12 ? ledger.documents.find((item) => item.document === name && contains(item.content, quote) >= 0) : undefined;
        if (!chunkHit || !claim) { unverified += 1; continue; }
        const key = `knowledge:${encodeURIComponent(name)}`;
        const source = sourceFor(key, () => ({
          id: randomUUID(), url: key, canonicalUrl: key, domain: "knowledge", title: name.slice(0, 500),
          author: null, publishedAt: null, retrievedAt: new Date().toISOString(), contentHash: hash(chunkHit.content),
          type: "text/x-knowledge", language: "und", relevance: 1, quality: 0.7, status: "read",
        }));
        const offset = contains(chunkHit.content, quote);
        claims.push({
          claim, sourceId: source.id, evidenceQuote: quote, evidenceStart: offset, evidenceEnd: offset + quote.length,
          evidenceHash: hash(quote), contradiction: null,
        });
      }
    }

    if (claims.length === 0) {
      throw new DelegationError(sources.length === 0 && !documents?.ok ? "delegation_no_sources" : "delegation_no_facts");
    }

    const summary = await this.synthesize(input.query, claims, reportSources, run);
    const sourcesList = [...reportSources.values()];
    return {
      id: input.reportId ?? randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      summary,
      claims,
      sources: sourcesList,
      confidence: Math.min(1, claims.length / Math.max(1, sourcesList.length)),
      checkedAt: new Date().toISOString(),
      memoryWritten: false,
      issues: {
        searchFailed: research.ok ? 0 : 1,
        readFailed: web.filter(({ outcome }) => !outcome.ok).length,
        extractFailed,
        unverified,
      },
      method: "delegated",
    };
  }

  /**
   * Отбор источников — тот же, что у конвейера: канонизация,
   * дедупликация, предел на домен, только http(s).
   */
  private selectSources(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const domains = new Map<string, number>();
    const selected: string[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      if (selected.length >= this.deps.limits.maxSources) break;
      const canonical = typeof item?.url === "string" ? canonicalizeUrl(item.url) : null;
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      const host = new URL(canonical).hostname;
      if ((domains.get(host) ?? 0) >= this.deps.limits.maxPagesPerDomain) continue;
      domains.set(host, (domains.get(host) ?? 0) + 1);
      selected.push(canonical);
    }
    return selected;
  }

  /**
   * Сводка — по проверенным фактам и только по ним. Отказ сводки не
   * отменяет исследование: тогда сводка — первые факты, как у конвейера.
   */
  private async synthesize(
    query: string,
    claims: ResearchClaim[],
    sources: Map<string, ResearchSource>,
    run: (task: SubagentTask) => Promise<SubagentOutcome>,
  ): Promise<string> {
    const fallback = claims.slice(0, 3).map((claim) => claim.claim).join("; ");
    const byId = new Map([...sources.values()].map((source) => [source.id, source]));
    const facts = claims.slice(0, 40).map((claim, index) => `${index + 1}. ${claim.claim} (${byId.get(claim.sourceId)?.domain ?? "источник"})`);
    const outcome = await run({
      role: "synthesis",
      tools: [],
      brief: [
        `Вопрос: ${query}`,
        "Проверенные факты:",
        ...facts,
        "Напиши сводку из 3–6 предложений по-русски. Опирайся только на эти факты, указывай источник в скобках.",
        "Если факты противоречат друг другу, скажи об этом. Ничего не добавляй от себя.",
      ].join("\n"),
    });
    const text = outcome.ok ? outcome.text.trim().slice(0, 3_000) : "";
    return text || fallback;
  }
}

function chunk<T>(items: T[], groups: number): T[][] {
  if (!items.length) return [];
  const count = Math.max(1, Math.min(groups, items.length));
  const result: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => result[index % count]!.push(item));
  return result;
}

function researchBrief(query: string, maxSources: number): string {
  return [
    `Вопрос: ${query}`,
    `Найди до ${maxSources} разных надёжных источников по этому вопросу инструментом web_search.`,
    "Сохраняй все имена и названия из вопроса как есть: другой город или человек — другой вопрос.",
    'Ответ — только JSON: {"sources": [{"url": "https://…", "title": "…", "why": "почему подходит"}]}.',
  ].join("\n");
}

function webBrief(query: string, urls: string[], maxFacts: number): string {
  return [
    `Вопрос: ${query}`,
    "Прочитай эти страницы инструментом web_read (если страница собирается скриптами — браузером):",
    ...urls.map((url) => `- ${url}`),
    `Выпиши до ${maxFacts} фактов, отвечающих на вопрос. Цитата — дословный отрывок со страницы, 12–400 знаков.`,
    'Ответ — только JSON: {"facts": [{"url": "адрес из списка", "claim": "факт своими словами", "evidence": "дословная цитата", "contradiction": "если противоречит другому источнику"}]}.',
  ].join("\n");
}

function documentBrief(query: string): string {
  return [
    `Вопрос: ${query}`,
    "Поищи ответ в документах пользователя инструментом knowledge_search.",
    'Ответ — только JSON: {"facts": [{"document": "название документа из результата", "claim": "факт", "evidence": "дословная цитата"}]}.',
    'Если в документах ничего нет — {"facts": []}.',
  ].join("\n");
}
