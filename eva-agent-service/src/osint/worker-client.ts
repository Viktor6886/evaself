/**
 * Клиент osint-worker.
 *
 * osint-worker — внутренний сервис в сети `tools` (см. osint-worker/README.md).
 * Адрес у него фиксированный и внутренний, поэтому запрос идёт напрямую,
 * как к media-service, а не через OutboundGateway: шлюз существует, чтобы
 * НЕ пускать во внутреннюю сеть, и адрес воркера он справедливо отклонил
 * бы. Во внешний интернет ходит сам воркер, со своей защитой от SSRF.
 *
 * Клиент ничего не решает: он переводит ответы воркера в типы и ошибки
 * eva-agent-service. Что делать с результатом — дело оркестратора
 * (batch OSINT-3), тождество — `resolver.ts`.
 *
 * Ошибки не содержат ни имени пользователя, ни адресов профилей: текст
 * ошибки уходит в логи и аудит, а там персональным данным не место.
 */

import { EvaError } from "../errors.js";
import type { DegradedReason } from "./types.js";

export type VerifierSource = "whatsmyname" | "sherlock";

export interface WorkerFoundProfile {
  site: string;
  url: string;
  tags: string[];
  httpStatus: number | null;
  ids: Record<string, string>;
  discoveredUsernames: string[];
  discoveredLinks: string[];
}

export interface WorkerScanResult {
  collector: "maigret";
  username: string;
  status: "ok" | "degraded";
  checked: number;
  found: WorkerFoundProfile[];
  degraded: Partial<Record<DegradedReason, number>>;
}

export type VerificationStatus = "found" | "not_found" | "unknown" | "skipped" | "degraded";

export interface WorkerVerification {
  source: VerifierSource;
  site: string;
  profileUrl: string;
  status: VerificationStatus;
  reason: string | null;
}

export interface WorkerFeature {
  name: string;
  score: number;
  detail: string | null;
}

export interface WorkerComparison {
  algorithm: string;
  score: number;
  features: WorkerFeature[];
}

/** Ответ инфраструктурного источника osint-worker. */
export interface InfraResult {
  collector: string;
  status: "ok" | "degraded";
  requests: number;
  sourceUrl: string | null;
  degradedReason: DegradedReason | null;
  data: Record<string, unknown>;
}

export function parseInfra(raw: unknown): InfraResult {
  const body = record(raw);
  const reason = DEGRADED_REASONS.find((value) => value === body.degraded_reason) ?? null;
  return {
    collector: text(body.collector),
    status: body.status === "degraded" ? "degraded" : "ok",
    requests: count(body.requests),
    sourceUrl: typeof body.source_url === "string" ? body.source_url : null,
    degradedReason: reason,
    data: record(body.data),
  };
}

/** Сущность FollowTheMoney для сравнения: схема и свойства. */
export interface FtmEntityInput {
  schema: "Person" | "Organization" | "Company" | "LegalEntity" | "PublicBody" | "UserAccount";
  properties: Record<string, string[]>;
}

export interface OsintWorkerOptions {
  baseUrl: string;
  token: string | null;
  /** Срок обычного запроса. */
  timeoutMs?: number;
  /** Срок скана Maigret: он проходит сотни сайтов. */
  scanTimeoutMs?: number;
  fetcher?: typeof fetch;
}

/** Срок поиска в реестре: общий срок worker (120 с) плюс запас на сеть. */
export const REGISTRY_TIMEOUT_MS = 135_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SCAN_TIMEOUT_MS = 200_000;
const VERIFICATION_STATUSES: readonly VerificationStatus[] = ["found", "not_found", "unknown", "skipped", "degraded"];
const DEGRADED_REASONS: readonly DegradedReason[] = ["rate_limited", "captcha", "timeout", "unavailable", "disabled"];

/**
 * Общее у клиентов OSINT-сервисов: ключ, сроки, повтор чтений и перевод
 * ответа в коды ошибок. Сервисов три (osint-worker, osint-harvester,
 * osint-spiderfoot), и расхождение в обработке ключа или срока между ними
 * было бы тем же дефектом, размноженным трижды.
 */
export class OsintHttpClient {
  protected readonly baseUrl: string;
  protected readonly token: string | null;
  protected readonly timeoutMs: number;
  protected readonly scanTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: OsintWorkerOptions, private readonly service = "osint-worker") {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.token = options.token?.trim() || null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? fetch;
  }

  protected async call(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    options: { timeoutMs: number; retry: boolean },
  ): Promise<unknown> {
    if (!this.token && path !== "/health") {
      throw new EvaError(`OSINT_WORKER_TOKEN не задан (${this.service})`, { code: "osint_worker_not_configured", statusCode: 503 });
    }
    const attempts = options.retry ? 2 : 1;
    let lastError: EvaError | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.once(method, path, payload, options.timeoutMs);
      } catch (error) {
        if (!(error instanceof EvaError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError!;
  }

  private async once(method: "GET" | "POST", path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.token) headers["X-Osint-Key"] = this.token;
    if (payload !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new EvaError(timeout ? `${this.service} не ответил вовремя` : `${this.service} недоступен`, {
        code: timeout ? "osint_worker_timeout" : "osint_worker_unavailable",
        statusCode: 503,
        retryable: true,
      });
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.ok) return body;
    const workerCode = text(record(record(body).error).code) || null;
    if (response.status === 401 || response.status === 403) {
      throw new EvaError(`${this.service} отклонил ключ`, { code: "osint_worker_unauthorized", statusCode: 502 });
    }
    if (response.status === 400 || response.status === 422) {
      throw new EvaError(`${this.service} отклонил запрос`, {
        code: "osint_worker_rejected",
        statusCode: 400,
        details: { workerCode },
      });
    }
    if (response.status === 504) {
      throw new EvaError("скан не уложился в срок", {
        code: "osint_worker_deadline",
        statusCode: 504,
        retryable: true,
        details: { workerCode },
      });
    }
    throw new EvaError(`${this.service} вернул HTTP ${response.status}`, {
      code: "osint_worker_unavailable",
      statusCode: 503,
      retryable: response.status >= 500,
    });
  }
}

export class OsintWorkerClient extends OsintHttpClient {
  constructor(options: OsintWorkerOptions) {
    super(options, "osint-worker");
  }

  /** RDAP: регистрационные данные домена, сети или AS. Чтение — повторяется. */
  async rdap(kind: "domain" | "ip" | "asn", value: string): Promise<InfraResult> {
    return parseInfra(await this.call("POST", "/v1/infra/rdap", { kind, value }, { timeoutMs: this.timeoutMs, retry: true }));
  }

  /** RIPEstat: кто анонсирует сеть или кто держит AS. */
  async ripestat(kind: "ip" | "asn", value: string): Promise<InfraResult> {
    return parseInfra(await this.call("POST", "/v1/infra/ripestat", { kind, value }, { timeoutMs: this.timeoutMs, retry: true }));
  }

  /** Имена из журналов Certificate Transparency (crt.sh). */
  async certificates(domain: string): Promise<InfraResult> {
    return parseInfra(await this.call("POST", "/v1/infra/certificates", { domain }, { timeoutMs: this.timeoutMs, retry: true }));
  }

  /** Записи DNS домена через резолвер. */
  async dns(domain: string): Promise<InfraResult> {
    return parseInfra(await this.call("POST", "/v1/infra/dns", { domain }, { timeoutMs: this.timeoutMs, retry: true }));
  }

  /**
   * ЕГРЮЛ/ЕГРИП: публичный поиск ФНС по ИНН, ОГРН или наименованию.
   * Не повторяется при сбое: ФНС отвечает на частые запросы капчей, и
   * повтор скорее её вызовет, чем получит ответ.
   */
  async egrul(kind: "tax_id" | "registration_number" | "organization", value: string): Promise<InfraResult> {
    // Поиск в ФНС — несколько запросов подряд с паузами, а не один: у
    // worker на него общий срок REGISTRY_DEADLINE, клиент ждёт чуть дольше,
    // чтобы деградацию по сроку вернул worker, а не обрыв соединения.
    return parseInfra(await this.call("POST", "/v1/registry/egrul", { kind, value }, { timeoutMs: REGISTRY_TIMEOUT_MS, retry: false }));
  }

  async health(): Promise<{ rules: Record<VerifierSource, number> }> {
    const body = await this.call("GET", "/health", undefined, { timeoutMs: this.timeoutMs, retry: true });
    const rules = record(record(body).rules);
    return { rules: { whatsmyname: count(rules.whatsmyname), sherlock: count(rules.sherlock) } };
  }

  /**
   * Скан Maigret. Не повторяется при сбое: это сотни запросов к чужим
   * сайтам, и повтор удвоил бы нагрузку на них. Повтор — решение
   * оркестратора с его бюджетом.
   */
  async scanUsername(username: string, options: { topSites?: number } = {}): Promise<WorkerScanResult> {
    const body = record(await this.call(
      "POST",
      "/v1/username/scan",
      { username, ...(options.topSites ? { top_sites: options.topSites } : {}) },
      { timeoutMs: this.scanTimeoutMs, retry: false },
    ));
    const degraded: Partial<Record<DegradedReason, number>> = {};
    for (const [reason, value] of Object.entries(record(body.degraded))) {
      if ((DEGRADED_REASONS as readonly string[]).includes(reason)) degraded[reason as DegradedReason] = count(value);
    }
    return {
      collector: "maigret",
      username: text(body.username),
      status: body.status === "degraded" ? "degraded" : "ok",
      checked: count(body.checked),
      found: list(body.found).map((raw) => {
        const profile = record(raw);
        return {
          site: text(profile.site),
          url: text(profile.url),
          tags: list(profile.tags).map(text),
          httpStatus: typeof profile.http_status === "number" ? profile.http_status : null,
          ids: Object.fromEntries(Object.entries(record(profile.ids)).map(([key, value]) => [key, text(value)])),
          discoveredUsernames: list(profile.discovered_usernames).map(text),
          discoveredLinks: list(profile.discovered_links).map(text),
        };
      }).filter((profile) => profile.site && profile.url),
      degraded,
    };
  }

  /** Проверка профилей правилами WhatsMyName и Sherlock. Чтение — повторяется. */
  async verifyProfiles(
    username: string,
    hosts: readonly string[],
    sources: readonly VerifierSource[] = ["whatsmyname", "sherlock"],
  ): Promise<WorkerVerification[]> {
    const body = record(await this.call(
      "POST",
      "/v1/username/verify",
      { username, hosts: [...new Set(hosts)].slice(0, 100), sources },
      { timeoutMs: this.timeoutMs, retry: true },
    ));
    return list(body.results).flatMap((raw) => {
      const item = record(raw);
      const source = item.source === "whatsmyname" || item.source === "sherlock" ? item.source : null;
      const status = VERIFICATION_STATUSES.find((value) => value === item.status);
      if (!source || !status) return [];
      return [{
        source,
        site: text(item.site),
        profileUrl: text(item.profile_url),
        status,
        reason: typeof item.reason === "string" ? item.reason : null,
      }];
    });
  }

  /** Признаки сходства nomenklatura. Вычисление без побочных эффектов — повторяется. */
  async compare(left: FtmEntityInput, right: FtmEntityInput): Promise<WorkerComparison> {
    const body = record(await this.call(
      "POST",
      "/v1/match/compare",
      { left, right },
      { timeoutMs: this.timeoutMs, retry: true },
    ));
    return {
      algorithm: text(body.algorithm),
      score: typeof body.score === "number" ? body.score : 0,
      features: list(body.features).flatMap((raw) => {
        const feature = record(raw);
        if (typeof feature.name !== "string" || typeof feature.score !== "number") return [];
        return [{ name: feature.name, score: feature.score, detail: typeof feature.detail === "string" ? feature.detail : null }];
      }),
    };
  }

}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
