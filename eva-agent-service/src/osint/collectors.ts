/**
 * Сборщики OSINT.
 *
 * Сборщик — детерминированный код: он получает идентификатор, ходит в
 * свои источники и возвращает находки с доказательствами. Модель здесь
 * не участвует ни в выборе запросов, ни в чтении страниц: варианты
 * запросов строит `planning.ts`, совпадение ищется буквально в тексте,
 * а цитата-доказательство обязана входить в текст источника.
 *
 * Сборщик ничего не решает о тождестве. Найденный аккаунт — это находка
 * «по такому имени есть профиль», а не «это профиль того человека»:
 * сравнение с субъектом делает оркестратор через `resolver.ts`.
 *
 * Отказ источника — не отказ исследования: сборщик возвращает статус
 * `degraded` с причиной, а исключение означает только сбой самого кода.
 */

import { canonicalizeUrl } from "../research/orchestrator.js";
import { sha256, quoteEvidence, structuredEvidence } from "./evidence.js";
import { normalizeIdentifier, type NormalizedIdentifier } from "./identifiers.js";
import { personNameVariants, phoneVariants, searchQueries } from "./planning.js";
import type { CollectorStatus, DegradedReason, Evidence, IdentifierType, SourceTier } from "./types.js";
import { mergeProfileObservations, type ProfileCollector } from "./worker-mapping.js";
import type { OsintWorkerClient } from "./worker-client.js";

/** Элемент очереди расширения: идентификатор и глубина, на которой найден. */
export interface FrontierItem {
  identifierId: string;
  type: IdentifierType;
  normalized: string;
  depth: number;
}

export interface CollectorContext {
  target: FrontierItem;
  signal: AbortSignal;
  /** Сколько внешних запросов ещё разрешает бюджет исследования. */
  remainingRequests: number;
}

/** Страница или ответ API с тем, что в нём найдено. */
export interface CollectedSource {
  locator: string;
  canonicalUrl: string | null;
  domain: string;
  tier: SourceTier;
  retrievedAt: string;
  contentHash: string | null;
  findings: Finding[];
}

export type Finding =
  /** Источник упоминает искомый идентификатор: цитата это доказывает. */
  | { kind: "mention"; evidence: Evidence }
  /** По идентификатору найден аккаунт. Чей он — решает resolver. */
  | {
    kind: "account";
    evidence: Evidence;
    site: string;
    url: string;
    confirmedBy: ProfileCollector[];
    contradictedBy: ProfileCollector[];
    unverifiedBy: ProfileCollector[];
    /** Свойства профиля в терминах FollowTheMoney (`name`, `username`). */
    properties: Array<{ property: string; value: string }>;
  }
  /**
   * Инфраструктурная сущность — домен, IP-адрес, сеть — со свойствами из
   * реестров. Ключ сущности — её идентификатор: один домен у одного
   * пользователя — одна сущность, сколько бы сборщиков о нём ни сообщили.
   */
  | {
    kind: "entity";
    evidence: Evidence;
    schema: "eva:Domain" | "eva:IPAddress" | "eva:Network" | "Organization";
    identifier: NormalizedIdentifier;
    properties: Array<{ property: string; value: string }>;
  }
  /**
   * Новый идентификатор. `owner` — ключ аккаунта или сущности из того же
   * источника, которому он принадлежит. `expand: false` — идентификатор
   * запоминается, но в очередь расширения не встаёт (поддомены из
   * журналов сертификатов: их сотни, и каждый не стоит отдельного шага).
   */
  | { kind: "discovered"; evidence: Evidence; identifier: NormalizedIdentifier; owner?: string; expand?: boolean };

export interface CollectorOutput {
  status: Extract<CollectorStatus, "succeeded" | "degraded" | "failed" | "skipped">;
  degradedReason?: DegradedReason;
  errorCode?: string;
  externalRequests: number;
  sources: CollectedSource[];
}

export interface Collector {
  readonly name: string;
  accepts(type: IdentifierType): boolean;
  /** Сколько внешних запросов прогон может сделать при таком остатке бюджета — верхняя граница. */
  reserve(remainingRequests: number): number;
  collect(context: CollectorContext): Promise<CollectorOutput>;
}

const VERIFIER_SOURCES = ["whatsmyname", "sherlock"] as const;

const skipped = (errorCode: string): CollectorOutput => ({ status: "skipped", errorCode, externalRequests: 0, sources: [] });

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** Поля профиля, которые Maigret извлекает, в свойства UserAccount/Person. */
const PROFILE_PROPERTIES: Readonly<Record<string, string>> = {
  fullname: "name",
  name: "name",
  username: "username",
};

/**
 * Username → профили: Maigret и независимая проверка правилами
 * WhatsMyName и Sherlock (osint-worker).
 */
export class UsernameProfilesCollector implements Collector {
  readonly name = "maigret";

  constructor(
    private readonly worker: Pick<OsintWorkerClient, "scanUsername" | "verifyProfiles">,
    private readonly options: { topSites: number; now?: () => Date } = { topSites: 300 },
  ) {}

  accepts(type: IdentifierType): boolean {
    return type === "username";
  }

  reserve(remainingRequests: number): number {
    return Math.max(0, remainingRequests);
  }

  async collect({ target, signal, remainingRequests }: CollectorContext): Promise<CollectorOutput> {
    signal.throwIfAborted();
    // Скан меньше десятка сайтов ничего не говорит, а верхнюю границу
    // держит бюджет: одна проверка сайта — один внешний запрос.
    const topSites = Math.min(this.options.topSites, remainingRequests);
    if (topSites < 10) return skipped("osint_budget_exhausted");
    const scan = await this.worker.scanUsername(target.normalized, { topSites });
    let requests = scan.checked;
    const hosts = [...new Set(scan.found.flatMap((profile) => {
      const url = canonicalizeUrl(profile.url);
      return url ? [hostOf(url)] : [];
    }))];
    let verifications: Awaited<ReturnType<OsintWorkerClient["verifyProfiles"]>> = [];
    let verifyFailed = false;
    // Проверка стоит запрос на каждый набор правил на каждый хост: хостов
    // берётся столько, сколько помещается в остаток по обоим наборам.
    const verifiable = hosts.slice(0, Math.floor((remainingRequests - requests) / VERIFIER_SOURCES.length));
    if (verifiable.length > 0) {
      signal.throwIfAborted();
      try {
        verifications = await this.worker.verifyProfiles(target.normalized, verifiable, VERIFIER_SOURCES);
        requests += verifications.length;
      } catch {
        // Проверка — второе мнение. Без неё находки Maigret остаются
        // находками одного сборщика, а не исчезают.
        verifyFailed = true;
      }
    }
    const merged = mergeProfileObservations(scan, verifications);
    const retrievedAt = (this.options.now?.() ?? new Date()).toISOString();
    const byHost = new Map(scan.found.map((profile) => {
      const url = canonicalizeUrl(profile.url);
      return [url ? hostOf(url) : "", profile] as const;
    }));
    const sources: CollectedSource[] = merged.profiles.map((profile) => {
      const found = byHost.get(profile.host);
      const properties = Object.entries(found?.ids ?? {}).flatMap(([key, value]) => {
        const property = PROFILE_PROPERTIES[key];
        const text = value.trim();
        return property && text && text.length <= 200 ? [{ property, value: text }] : [];
      });
      const evidence = structuredEvidence({
        collector: "maigret",
        site: profile.site,
        url: profile.url,
        httpStatus: found?.httpStatus ?? null,
        confirmedBy: profile.confirmedBy,
        contradictedBy: profile.contradictedBy,
      });
      const findings: Finding[] = [{
        kind: "account",
        evidence,
        site: profile.site,
        url: profile.url,
        confirmedBy: profile.confirmedBy,
        contradictedBy: profile.contradictedBy,
        unverifiedBy: profile.unverifiedBy,
        properties,
      }];
      for (const username of found?.discoveredUsernames ?? []) {
        const identifier = normalizeIdentifier("username", username);
        if (identifier && identifier.normalized !== target.normalized) {
          findings.push({ kind: "discovered", evidence, identifier, owner: profile.url });
        }
      }
      for (const link of found?.discoveredLinks ?? []) {
        const identifier = normalizeIdentifier("social_account", link) ?? normalizeIdentifier("url", link);
        if (identifier) findings.push({ kind: "discovered", evidence, identifier, owner: profile.url });
      }
      return {
        locator: profile.url,
        canonicalUrl: profile.url,
        domain: profile.host,
        // Сам сайт — первоисточник факта «такой профиль существует».
        // Чей это профиль, из этого не следует.
        tier: "official_profile",
        retrievedAt,
        contentHash: evidence.hash,
        findings,
      };
    });
    const degradedReason = verifyFailed
      ? "unavailable"
      : (Object.keys(scan.degraded)[0] as DegradedReason | undefined);
    return {
      status: scan.status === "degraded" || verifyFailed ? "degraded" : "succeeded",
      ...(degradedReason ? { degradedReason } : {}),
      externalRequests: requests,
      sources,
    };
  }
}

/** Поиск и чтение через SearXNG и Crawl4AI (`research/adapters.ts`). */
export interface WebAccess {
  search(query: string, signal: AbortSignal): Promise<Array<{ url: string; title: string }>>;
  read(url: string, signal: AbortSignal, maxBytes: number): Promise<{ url: string; content: string; title: string }>;
}

export interface WebSearchLimits {
  queriesPerIdentifier: number;
  pagesPerIdentifier: number;
  maxPageBytes: number;
}

/** Типы, по которым найденные на странице профили идут в расширение. */
const EXPANDING_TYPES = new Set<IdentifierType>(["email", "phone", "username"]);

/** Сколько знаков вокруг совпадения идёт в цитату. */
const QUOTE_CONTEXT = 160;

/** В каких записях идентификатор встречается на страницах. */
export function mentionVariants(target: Pick<FrontierItem, "type" | "normalized">): string[] {
  switch (target.type) {
    case "name":
      return personNameVariants(target.normalized);
    case "phone":
      return phoneVariants(target.normalized);
    default:
      return [target.normalized];
  }
}

/**
 * Цитата вокруг первого упоминания. Возвращается подстрока самого
 * текста — `quoteEvidence` это перепроверяет.
 */
export function mentionQuote(content: string, variants: readonly string[]): Evidence | null {
  const lowered = content.toLocaleLowerCase("ru");
  for (const variant of variants) {
    const needle = variant.toLocaleLowerCase("ru");
    if (needle.length < 3) continue;
    const index = lowered.indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - QUOTE_CONTEXT);
    const end = Math.min(content.length, index + needle.length + QUOTE_CONTEXT);
    const evidence = quoteEvidence(content.slice(start, end), content);
    if (evidence) return evidence;
  }
  return null;
}

/**
 * Поиск по открытому вебу.
 *
 * Страница попадает в источники, только если искомый идентификатор в
 * ней действительно есть: выдача поисковика — это кандидаты, а не
 * находки. По имени и названию организации расширения нет вовсе:
 * профиль тёзки на странице с тем же именем — не след искомого человека.
 */
export class WebSearchCollector implements Collector {
  readonly name = "web_search";

  constructor(
    private readonly web: WebAccess,
    private readonly limits: WebSearchLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accepts(type: IdentifierType): boolean {
    return ["name", "username", "email", "phone", "organization", "domain", "tax_id", "registration_number"]
      .includes(type);
  }

  reserve(remainingRequests: number): number {
    return Math.max(0, Math.min(remainingRequests, this.limits.queriesPerIdentifier + this.limits.pagesPerIdentifier));
  }

  async collect({ target, signal, remainingRequests }: CollectorContext): Promise<CollectorOutput> {
    const queries = searchQueries({ type: target.type, raw: target.normalized, normalized: target.normalized })
      .slice(0, Math.max(0, Math.min(this.limits.queriesPerIdentifier, remainingRequests - 1)));
    if (queries.length === 0) return skipped("osint_budget_exhausted");
    let requests = 0;
    let failures = 0;
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      signal.throwIfAborted();
      requests += 1;
      try {
        for (const result of await this.web.search(query, signal)) {
          const canonical = canonicalizeUrl(result.url);
          if (canonical && !seen.has(canonical)) {
            seen.add(canonical);
            candidates.push(canonical);
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        failures += 1;
      }
    }
    if (failures === queries.length) {
      return { status: "degraded", degradedReason: "unavailable", externalRequests: requests, sources: [] };
    }

    const pages = candidates.slice(0, Math.max(0, Math.min(this.limits.pagesPerIdentifier, remainingRequests - requests)));
    const variants = mentionVariants(target);
    const sources: CollectedSource[] = [];
    let readFailures = 0;
    for (const url of pages) {
      signal.throwIfAborted();
      requests += 1;
      let content: string;
      try {
        content = (await this.web.read(url, signal, this.limits.maxPageBytes)).content;
      } catch (error) {
        if (signal.aborted) throw error;
        readFailures += 1;
        continue;
      }
      const evidence = mentionQuote(content, variants);
      if (!evidence) continue;
      const findings: Finding[] = [{ kind: "mention", evidence }];
      if (EXPANDING_TYPES.has(target.type)) {
        // Страница, которая сама является профилем и называет искомую
        // почту или телефон, — след, по которому стоит пойти дальше.
        const profile = normalizeIdentifier("social_account", url);
        if (profile) findings.push({ kind: "discovered", evidence, identifier: profile });
      }
      sources.push({
        locator: url,
        canonicalUrl: url,
        domain: hostOf(url),
        tier: "unknown",
        retrievedAt: this.now().toISOString(),
        contentHash: sha256(content),
        findings,
      });
    }
    const degraded = failures > 0 || (pages.length > 0 && readFailures === pages.length);
    return {
      status: degraded ? "degraded" : "succeeded",
      ...(degraded ? { degradedReason: "unavailable" as const } : {}),
      externalRequests: requests,
      sources,
    };
  }
}
