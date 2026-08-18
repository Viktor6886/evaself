/**
 * Разбор темы по источникам: план → поиск → чтение → факты → отчёт.
 *
 * Три правила, ради которых модуль устроен именно так:
 *
 *  1. Один отказ не отменяет разбор. Поиск и чтение идут пачками, и
 *     раньше любая пачка выполнялась через `Promise.all`: 404 на одной
 *     странице отменял всю работу, включая уже прочитанное.
 *  2. Источники отбираются после канонизации и дедупликации, а не до
 *     них. Прежний порядок сначала обрезал выдачу по `maxSources`, а
 *     потом выбрасывал дубли — и до чтения доходило вдвое меньше
 *     страниц, чем просили.
 *  3. Схема фактов у запроса и у разбора одна. Извлечение, не
 *     уложившееся в схему, — это отказ, а не «ноль фактов»: молчаливый
 *     ноль выглядит как успешный разбор, в котором просто ничего не
 *     нашлось.
 */

import { createHash, randomUUID } from "node:crypto";

import { sanitizeUntrustedContent } from "../knowledge/security.js";

export interface ResearchLimits {
  maxQueries: number;
  maxSources: number;
  maxPagesPerDomain: number;
  timeoutMs: number;
  tokenBudget: number;
  maxPageBytes: number;
  maxConcurrency: number;
}

interface SearchResult { url: string; title: string }
interface Page {
  url: string;
  content: string;
  title: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  type?: string;
}
interface Fact { claim: string; evidence: string; contradiction?: string }

export interface ResearchSource {
  id: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  contentHash: string;
  type: string;
  language: string;
  relevance: number;
  quality: number;
  status: "read";
}

export interface ResearchClaim {
  claim: string;
  sourceId: string;
  evidenceQuote: string;
  evidenceStart: number;
  evidenceEnd: number;
  evidenceHash: string;
  contradiction: string | null;
}

/** Что не получилось. Пустой разбор и разбор с отказами — разные вещи. */
export interface ResearchIssues {
  searchFailed: number;
  readFailed: number;
  extractFailed: number;
}

export interface ResearchReport {
  id: string;
  userId: number;
  conversationId: string;
  summary: string;
  claims: ResearchClaim[];
  sources: ResearchSource[];
  confidence: number;
  checkedAt: string;
  memoryWritten: false;
  issues: ResearchIssues;
}

interface Dependencies {
  plan(query: string, maxQueries: number, signal: AbortSignal): Promise<string[]>;
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
  read(url: string, signal: AbortSignal, maxBytes: number): Promise<Page>;
  extract(content: string, signal: AbortSignal): Promise<Fact[]>;
  save(report: ResearchReport): Promise<void>;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Параметры слежения: к адресу страницы они отношения не имеют. */
const TRACKING_PARAMS = /^(?:utm_[a-z_]+|yclid|gclid|fbclid|_openstat|ref|referrer)$/i;

/**
 * Канонический адрес: один и тот же материал не должен занимать два
 * места в выдаче из-за метки рассылки или хвостового слэша.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

/**
 * Насколько результат отвечает запросу.
 *
 * Считаются слова запроса, встретившиеся в заголовке и в адресе. Этого
 * достаточно, чтобы «Пермь» не подменялась соседним городом: у чужого
 * города совпадений меньше, и он уходит вниз. Порядок выдачи остаётся
 * вторым признаком — при равном счёте побеждает найденное раньше.
 */
export function relevanceScore(query: string, result: SearchResult): number {
  const terms = new Set(
    query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3),
  );
  if (terms.size === 0) return 0;
  const haystack = `${result.title} ${decodeURIComponent(result.url)}`.toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits / terms.size;
}

export class ResearchOrchestrator {
  constructor(
    private readonly dependencies: Dependencies,
    private readonly limits: ResearchLimits,
  ) {}

  async run(input: {
    userId: number;
    conversationId: string;
    query: string;
    signal: AbortSignal;
    reportId?: string;
    queries?: string[];
  }): Promise<ResearchReport> {
    input.signal.throwIfAborted();
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    if (this.limits.maxQueries < 3 || this.limits.maxQueries > 7) {
      throw new Error("research_query_limit");
    }
    const issues: ResearchIssues = { searchFailed: 0, readFailed: 0, extractFailed: 0 };

    const queries = input.queries
      ?? await this.dependencies.plan(input.query, this.limits.maxQueries, signal);
    if (queries.length < 3 || queries.length > this.limits.maxQueries) {
      throw new Error("research_query_limit");
    }

    // Поиск: отказ одного запроса не отменяет остальные.
    const searches = await Promise.allSettled(
      queries.map(async (query) => await this.dependencies.search(query, signal)),
    );
    const found: SearchResult[] = [];
    for (const outcome of searches) {
      if (outcome.status === "fulfilled") found.push(...outcome.value);
      else issues.searchFailed += 1;
    }
    if (found.length === 0) throw new Error("research_search_failed");

    const selected = this.select(input.query, found);
    if (selected.length === 0) throw new Error("research_search_failed");

    // Чтение: та же логика. Страница, которую не отдали, — минус
    // источник, а не минус разбор.
    const pages: Page[] = [];
    const step = Math.max(1, this.limits.maxConcurrency);
    for (let index = 0; index < selected.length; index += step) {
      signal.throwIfAborted();
      const batch = await Promise.allSettled(selected.slice(index, index + step).map(
        async (item) => await this.dependencies.read(item.url, signal, this.limits.maxPageBytes),
      ));
      for (const outcome of batch) {
        if (outcome.status === "fulfilled") pages.push(outcome.value);
        else if (isAbort(outcome.reason)) throw outcome.reason;
        else issues.readFailed += 1;
      }
    }
    if (pages.length === 0) throw new Error("research_no_sources");

    const sources: ResearchSource[] = [];
    const claims: ResearchClaim[] = [];
    let tokens = 0;
    for (const page of pages) {
      signal.throwIfAborted();
      const raw = Buffer.from(page.content).subarray(0, this.limits.maxPageBytes).toString();
      tokens += Math.ceil(raw.length / 4);
      if (tokens > this.limits.tokenBudget) throw new Error("research_token_limit");
      const clean = sanitizeUntrustedContent(raw);
      const canonical = new URL(page.url);
      const source: ResearchSource = {
        id: randomUUID(),
        url: page.url,
        canonicalUrl: canonicalizeUrl(page.url) ?? canonical.toString(),
        domain: canonical.hostname,
        title: page.title,
        author: page.author ?? null,
        publishedAt: page.publishedAt ?? null,
        retrievedAt: new Date().toISOString(),
        contentHash: hash(raw),
        type: page.type ?? "text/html",
        language: page.language ?? "und",
        relevance: 1,
        quality: 0.5,
        status: "read",
      };
      sources.push(source);

      let facts: Fact[];
      try {
        facts = await this.dependencies.extract(clean, signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        // Схема не сошлась. Это отказ этой страницы, а не ноль фактов на
        // ней: разница видна и в отчёте, и в проверке ниже.
        issues.extractFailed += 1;
        continue;
      }
      for (const fact of facts) {
        if (!clean.includes(fact.evidence)) continue;
        claims.push({
          claim: fact.claim,
          sourceId: source.id,
          evidenceQuote: fact.evidence,
          evidenceStart: clean.indexOf(fact.evidence),
          evidenceEnd: clean.indexOf(fact.evidence) + fact.evidence.length,
          evidenceHash: hash(fact.evidence),
          contradiction: fact.contradiction ?? null,
        });
      }
    }
    // Ни одного факта и при этом сорванное извлечение — это отказ.
    // Пустой отчёт здесь означал бы «проверили и не нашли», а проверить
    // как раз не удалось.
    if (claims.length === 0 && issues.extractFailed > 0) {
      throw new Error("research_extraction_failed");
    }

    signal.throwIfAborted();
    const report: ResearchReport = {
      id: input.reportId ?? randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      summary: claims.slice(0, 3).map((claim) => claim.claim).join("; "),
      claims,
      sources,
      confidence: claims.length ? Math.min(1, claims.length / sources.length) : 0,
      checkedAt: new Date().toISOString(),
      memoryWritten: false,
      issues,
    };
    await this.dependencies.save(report);
    return report;
  }

  /**
   * Отбор источников: канонизация, дедупликация, ранжирование и только
   * потом лимиты. Порядок важен — обрезав выдачу первой, до чтения
   * доходят дубли вместо разных источников.
   */
  private select(query: string, found: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const unique: Array<{ item: SearchResult; order: number; score: number }> = [];
    for (const [order, item] of found.entries()) {
      const canonical = canonicalizeUrl(item.url);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      const normalized = { ...item, url: canonical };
      unique.push({ item: normalized, order, score: relevanceScore(query, normalized) });
    }
    unique.sort((left, right) => right.score - left.score || left.order - right.order);

    const domains = new Map<string, number>();
    const selected: SearchResult[] = [];
    for (const entry of unique) {
      if (selected.length >= this.limits.maxSources) break;
      const host = new URL(entry.item.url).hostname;
      const count = domains.get(host) ?? 0;
      if (count >= this.limits.maxPagesPerDomain) continue;
      domains.set(host, count + 1);
      selected.push(entry.item);
    }
    return selected;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
