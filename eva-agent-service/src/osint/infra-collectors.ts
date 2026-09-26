/**
 * Сборщики инфраструктуры: DNS, RDAP, журналы сертификатов, RIPEstat
 * (osint-worker), theHarvester (osint-harvester) и SpiderFoot
 * (osint-spiderfoot).
 *
 * Как и остальные сборщики, они ничего не решают о тождестве: домен, адрес
 * и сеть становятся сущностями со свойствами из реестров, а найденные
 * рядом идентификаторы — кандидатами следующей итерации.
 *
 * Расширение ограничено по смыслу, а не только бюджетом. Поддомены из
 * журналов сертификатов и пассивного DNS запоминаются, но в очередь не
 * встают: их сотни, и каждый не стоит отдельного шага. Адреса, AS и почта
 * встают, но не больше `MAX_EXPANDED_PER_KIND` каждого вида.
 */

import { BlockList, isIP } from "node:net";

import { structuredEvidence } from "./evidence.js";
import { normalizeIdentifier, type NormalizedIdentifier } from "./identifiers.js";
import type { Collector, CollectedSource, CollectorContext, CollectorOutput, Finding } from "./collectors.js";
import type { HarvesterClient, SpiderfootClient } from "./service-clients.js";
import type { IdentifierType, SourceTier } from "./types.js";
import type { InfraResult, OsintWorkerClient } from "./worker-client.js";

/** Сколько адресов, AS и почтовых ящиков одного вида встаёт в очередь за один прогон. */
export const MAX_EXPANDED_PER_KIND = 10;
/** Сколько поддоменов запоминается за один прогон. */
export const MAX_REMEMBERED_HOSTS = 50;

const TIER: Readonly<Record<string, SourceTier>> = {
  rdap: "official_registry",
  dns: "official_registry",
  ripestat: "official_registry",
  ct: "public_repository",
};

type Discovered = Extract<Finding, { kind: "discovered" }>;

/**
 * Частные, служебные и документационные диапазоны. Адрес из них в DNS
 * чужого домена — не след, а внутренняя сеть: реестры о нём ничего не
 * скажут, а расспрашивать о нём внешние сервисы нельзя.
 */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");

export function isPublicIp(value: string): boolean {
  const version = isIP(value);
  if (version === 0) return false;
  // IPv4, записанный как IPv6 (`::ffff:10.0.0.1`), проверяется как IPv4.
  // Подсеть `::ffff:0:0/96` в BlockList не годится: Node применяет её и к
  // обычным IPv4-адресам, и все они оказывались бы частными.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return isPublicIp(mapped[1]!);
  if (version === 6 && /^::ffff:/i.test(value)) return false;
  return !NON_PUBLIC.check(value, version === 4 ? "ipv4" : "ipv6");
}
type EntityFinding = Extract<Finding, { kind: "entity" }>;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

/** Найденные значения одного типа: нормализованные, без дублей, с пределом. */
function discover(
  type: IdentifierType,
  values: readonly string[],
  evidence: Finding["evidence"],
  options: { owner?: string; expand: boolean; limit: number },
): Discovered[] {
  const seen = new Set<string>();
  const found: Discovered[] = [];
  for (const value of values) {
    if (found.length >= options.limit) break;
    const identifier = normalizeIdentifier(type, value);
    if (!identifier || seen.has(identifier.normalized)) continue;
    if (type === "ip" && !isPublicIp(identifier.normalized)) continue;
    seen.add(identifier.normalized);
    found.push({
      kind: "discovered",
      evidence,
      identifier,
      ...(options.owner ? { owner: options.owner } : {}),
      expand: options.expand,
    });
  }
  return found;
}

function properties(entries: Array<[string, unknown]>): Array<{ property: string; value: string }> {
  const result: Array<{ property: string; value: string }> = [];
  for (const [property, raw] of entries) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if ((typeof value === "string" && value.trim()) || typeof value === "number" || typeof value === "boolean") {
        result.push({ property, value: String(value).trim().slice(0, 500) });
      }
    }
  }
  return result;
}

function source(result: InfraResult, locator: string, domain: string, now: Date, findings: Finding[]): CollectedSource {
  return {
    locator: result.sourceUrl ?? locator,
    canonicalUrl: result.sourceUrl,
    domain,
    tier: TIER[result.collector] ?? "unknown",
    retrievedAt: now.toISOString(),
    contentHash: findings[0]?.evidence.hash ?? null,
    findings,
  };
}

function sourceHost(result: InfraResult, fallback: string): string {
  if (!result.sourceUrl) return fallback;
  try {
    return new URL(result.sourceUrl).hostname;
  } catch {
    return fallback;
  }
}

function combine(results: InfraResult[], sources: CollectedSource[]): CollectorOutput {
  const degraded = results.find((result) => result.status === "degraded");
  return {
    status: degraded ? "degraded" : "succeeded",
    ...(degraded?.degradedReason ? { degradedReason: degraded.degradedReason } : {}),
    externalRequests: results.reduce((sum, result) => sum + result.requests, 0),
    sources: sources.filter((item) => item.findings.length > 0),
  };
}

/**
 * Домен, адрес и AS: регистрационные данные, DNS, журналы сертификатов.
 * Все источники — реестры и публичные журналы; сам хост не опрашивается.
 */
export class InfrastructureCollector implements Collector {
  readonly name = "infrastructure";

  constructor(
    private readonly worker: Pick<OsintWorkerClient, "rdap" | "ripestat" | "certificates" | "dns">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accepts(type: IdentifierType): boolean {
    return type === "domain" || type === "ip" || type === "asn";
  }

  reserve(remainingRequests: number): number {
    // Три-четыре запроса к реестрам плюс файлы bootstrap RDAP.
    return Math.max(0, Math.min(remainingRequests, 8));
  }

  async collect({ target, signal, remainingRequests }: CollectorContext): Promise<CollectorOutput> {
    if (remainingRequests < 4) return { status: "skipped", errorCode: "osint_budget_exhausted", externalRequests: 0, sources: [] };
    signal.throwIfAborted();
    if (target.type === "domain") return await this.domain(target.normalized, signal);
    if (target.type === "ip") return await this.address(target.normalized, signal);
    return await this.autonomousSystem(target.normalized, signal);
  }

  private async domain(domain: string, signal: AbortSignal): Promise<CollectorOutput> {
    const now = this.now();
    const dns = await this.worker.dns(domain);
    signal.throwIfAborted();
    const rdap = await this.worker.rdap("domain", domain);
    signal.throwIfAborted();
    const ct = await this.worker.certificates(domain);
    const key = normalizeIdentifier("domain", domain);
    const sources: CollectedSource[] = [];
    if (key) {
      const records = (dns.data.records ?? {}) as Record<string, unknown>;
      const dnsEvidence = structuredEvidence({ collector: "dns", domain, records });
      sources.push(source(dns, `dns:${domain}`, "dns", now, [
        entity("eva:Domain", key, dnsEvidence, Object.entries(records).map(([type, values]) => [`dns${type}`, values])),
        ...discover("ip", [...strings(records.A), ...strings(records.AAAA)], dnsEvidence,
          { owner: key.normalized, expand: true, limit: MAX_EXPANDED_PER_KIND }),
      ]));
      if (rdap.data.found) {
        const events = (rdap.data.events ?? {}) as Record<string, unknown>;
        const rdapEvidence = structuredEvidence({ collector: "rdap", ...rdap.data });
        sources.push(source(rdap, `rdap:domain/${domain}`, sourceHost(rdap, "rdap"), now, [
          entity("eva:Domain", key, rdapEvidence, [
            ["registrar", rdap.data.registrar],
            ["registrantOrganization", rdap.data.registrant_organizations],
            ["nameserver", rdap.data.nameservers],
            ["createdAt", events.registration],
            ["expiresAt", events.expiration],
            ["status", rdap.data.status],
          ]),
          // Организация-регистрант — след дальше: её ищут в открытых
          // источниках. Человек-регистрант сюда не попадает никогда:
          // osint-worker его не извлекает.
          ...discover("organization", strings(rdap.data.registrant_organizations), rdapEvidence,
            { owner: key.normalized, expand: true, limit: 3 }),
        ]));
      }
      const names = strings(ct.data.names).filter((name) => name !== domain);
      const ctEvidence = structuredEvidence({
        collector: "ct", domain, certificates: ct.data.certificates, names: names.slice(0, MAX_REMEMBERED_HOSTS),
      });
      sources.push(source(ct, `ct:${domain}`, sourceHost(ct, "crt.sh"), now, [
        entity("eva:Domain", key, ctEvidence, [
          ["certificateCount", ct.data.certificates],
          ["certificateFirstSeen", ct.data.first_seen],
          ["certificateLastSeen", ct.data.last_seen],
        ]),
        ...discover("domain", names, ctEvidence, { owner: key.normalized, expand: false, limit: MAX_REMEMBERED_HOSTS }),
      ]));
    }
    return combine([dns, rdap, ct], sources);
  }

  private async address(ip: string, signal: AbortSignal): Promise<CollectorOutput> {
    const now = this.now();
    const rdap = await this.worker.rdap("ip", ip);
    signal.throwIfAborted();
    const stat = await this.worker.ripestat("ip", ip);
    const key = normalizeIdentifier("ip", ip);
    const sources: CollectedSource[] = [];
    if (key) {
      if (rdap.data.found) {
        const evidence = structuredEvidence({ collector: "rdap", ...rdap.data });
        sources.push(source(rdap, `rdap:ip/${ip}`, sourceHost(rdap, "rdap"), now, [
          entity("eva:IPAddress", key, evidence, [
            ["networkName", rdap.data.name],
            ["country", rdap.data.country],
            ["cidr", rdap.data.cidrs],
            ["registrantOrganization", rdap.data.organizations],
          ]),
          ...discover("cidr", strings(rdap.data.cidrs), evidence, { owner: key.normalized, expand: false, limit: 5 }),
        ]));
      }
      if (stat.data.found) {
        const asns = Array.isArray(stat.data.asns) ? stat.data.asns as Array<{ asn?: unknown; holder?: unknown }> : [];
        const evidence = structuredEvidence({ collector: "ripestat", ...stat.data });
        sources.push(source(stat, `ripestat:${ip}`, "stat.ripe.net", now, [
          entity("eva:IPAddress", key, evidence, [
            ["announced", stat.data.announced],
            ["asn", asns.map((item) => item.asn).filter((asn) => typeof asn === "number").map(String)],
            ["asnHolder", asns.map((item) => item.holder)],
          ]),
          ...discover("asn", asns.map((item) => String(item.asn ?? "")), evidence,
            { owner: key.normalized, expand: true, limit: 3 }),
        ]));
      }
    }
    return combine([rdap, stat], sources);
  }

  private async autonomousSystem(asn: string, signal: AbortSignal): Promise<CollectorOutput> {
    const now = this.now();
    const number = asn.replace(/^AS/i, "");
    const rdap = await this.worker.rdap("asn", number);
    signal.throwIfAborted();
    const stat = await this.worker.ripestat("asn", number);
    const key = normalizeIdentifier("asn", asn);
    const sources: CollectedSource[] = [];
    if (key) {
      if (rdap.data.found) {
        const evidence = structuredEvidence({ collector: "rdap", ...rdap.data });
        sources.push(source(rdap, `rdap:autnum/${number}`, sourceHost(rdap, "rdap"), now, [
          entity("eva:Network", key, evidence, [
            ["name", rdap.data.name],
            ["country", rdap.data.country],
            ["registrantOrganization", rdap.data.organizations],
          ]),
        ]));
      }
      if (stat.data.found) {
        const evidence = structuredEvidence({ collector: "ripestat", ...stat.data });
        sources.push(source(stat, `ripestat:AS${number}`, "stat.ripe.net", now, [
          entity("eva:Network", key, evidence, [["holder", stat.data.holder], ["announced", stat.data.announced]]),
        ]));
      }
    }
    return combine([rdap, stat], sources);
  }
}

function entity(
  schema: EntityFinding["schema"],
  identifier: NormalizedIdentifier,
  evidence: Finding["evidence"],
  entries: Array<[string, unknown]>,
): EntityFinding {
  return { kind: "entity", evidence, schema, identifier, properties: properties(entries) };
}

/** theHarvester: хосты, адреса и почта домена из пассивных источников. */
export class HarvesterCollector implements Collector {
  readonly name = "theharvester";

  constructor(
    private readonly harvester: Pick<HarvesterClient, "harvest">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accepts(type: IdentifierType): boolean {
    return type === "domain";
  }

  reserve(remainingRequests: number): number {
    // Несколько запросов на каждый из семи источников по умолчанию.
    return Math.max(0, Math.min(remainingRequests, 30));
  }

  async collect({ target, signal, remainingRequests }: CollectorContext): Promise<CollectorOutput> {
    if (remainingRequests < 10) return { status: "skipped", errorCode: "osint_budget_exhausted", externalRequests: 0, sources: [] };
    signal.throwIfAborted();
    const result = await this.harvester.harvest(target.normalized);
    const key = normalizeIdentifier("domain", target.normalized);
    const evidence = structuredEvidence({
      collector: "theharvester", domain: target.normalized, sources: result.sources,
      hosts: result.hosts.slice(0, MAX_REMEMBERED_HOSTS), ips: result.ips, emails: result.emails, asns: result.asns,
    });
    const findings: Finding[] = key ? [
      entity("eva:Domain", key, evidence, [["harvestedHosts", result.hosts.length]]),
      ...discover("domain", result.hosts.filter((host) => host !== target.normalized), evidence,
        { owner: key.normalized, expand: false, limit: MAX_REMEMBERED_HOSTS }),
      ...discover("ip", result.ips, evidence, { owner: key.normalized, expand: true, limit: MAX_EXPANDED_PER_KIND }),
      // Почта домена — публично опубликованные адреса; дальше их ищут в
      // открытом вебе в пределах бюджета.
      ...discover("email", result.emails, evidence, { owner: key.normalized, expand: true, limit: MAX_EXPANDED_PER_KIND }),
      ...discover("asn", result.asns, evidence, { owner: key.normalized, expand: true, limit: 3 }),
    ] : [];
    return {
      status: result.status === "degraded" ? "degraded" : "succeeded",
      ...(result.status === "degraded" ? { degradedReason: "unavailable" as const } : {}),
      externalRequests: Math.max(result.requests, result.sources.length),
      sources: findings.length > 0 ? [{
        locator: `theharvester:${target.normalized}`,
        canonicalUrl: null,
        domain: "theharvester",
        tier: "aggregator",
        retrievedAt: this.now().toISOString(),
        contentHash: evidence.hash,
        findings,
      }] : [],
    };
  }
}

/** SpiderFoot: пассивный DNS, реестры и репутационные списки для домена или адреса. */
export class SpiderfootCollector implements Collector {
  readonly name = "spiderfoot";

  constructor(
    private readonly spiderfoot: Pick<SpiderfootClient, "scan">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accepts(type: IdentifierType): boolean {
    return type === "domain" || type === "ip";
  }

  reserve(remainingRequests: number): number {
    // Около двух запросов на каждый из разрешённых модулей.
    return Math.max(0, Math.min(remainingRequests, 60));
  }

  async collect({ target, signal, remainingRequests }: CollectorContext): Promise<CollectorOutput> {
    if (remainingRequests < 30) return { status: "skipped", errorCode: "osint_budget_exhausted", externalRequests: 0, sources: [] };
    signal.throwIfAborted();
    const kind = target.type === "ip" ? "ip" : "domain";
    const result = await this.spiderfoot.scan(kind, target.normalized);
    const key = normalizeIdentifier(kind, target.normalized);
    const evidence = structuredEvidence({
      collector: "spiderfoot", target: target.normalized, organizations: result.organizations, lei: result.lei,
      reputation: result.reputation, asns: result.asns, netblocks: result.netblocks,
      hosts: result.hosts.slice(0, MAX_REMEMBERED_HOSTS), ips: result.ips,
    });
    const findings: Finding[] = key ? [
      entity(kind === "ip" ? "eva:IPAddress" : "eva:Domain", key, evidence, [
        ["organization", result.organizations],
        ["leiCode", result.lei],
        ["reputation", result.reputation.map((item) => `${item.type}: ${item.data} (${item.module})`)],
      ]),
      ...discover("domain", [...result.hosts, ...result.domains].filter((host) => host !== target.normalized), evidence,
        { owner: key.normalized, expand: false, limit: MAX_REMEMBERED_HOSTS }),
      ...discover("ip", result.ips.filter((ip) => ip !== target.normalized), evidence,
        { owner: key.normalized, expand: true, limit: MAX_EXPANDED_PER_KIND }),
      ...discover("asn", result.asns, evidence, { owner: key.normalized, expand: true, limit: 3 }),
      ...discover("cidr", result.netblocks, evidence, { owner: key.normalized, expand: false, limit: 5 }),
    ] : [];
    return {
      status: result.status === "degraded" ? "degraded" : "succeeded",
      ...(result.status === "degraded" ? { degradedReason: "timeout" as const } : {}),
      externalRequests: this.reserve(remainingRequests),
      sources: findings.length > 0 ? [{
        locator: `spiderfoot:${target.normalized}`,
        canonicalUrl: null,
        domain: "spiderfoot",
        tier: "aggregator",
        retrievedAt: this.now().toISOString(),
        contentHash: evidence.hash,
        findings,
      }] : [],
    };
  }
}
