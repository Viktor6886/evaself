/**
 * Реестры РФ: ЕГРЮЛ и ЕГРИП (публичный поиск ФНС через osint-worker).
 *
 * Запись реестра становится сущностью: организация — `Organization`,
 * индивидуальный предприниматель — `LegalEntity`. Ключ сущности — ИНН,
 * поэтому у исследования организации по её ИНН сведения реестра ложатся
 * на сам субъект: субъект заведён с тем же идентификатором.
 *
 * Тождество здесь, как и везде, не решается. Поиск по наименованию
 * возвращает до десяти организаций с похожим именем; каждая — отдельная
 * сущность, и ни одна не объявляется субъектом. Их номера запоминаются,
 * но в очередь не встают: иначе исследование «Ромашки» разошлось бы на
 * десять чужих компаний.
 *
 * ФИО руководителя — свойство организации из открытой части ЕГРЮЛ, а не
 * новый след: человек за ним в поиск не отправляется.
 */

import { structuredEvidence } from "./evidence.js";
import { normalizeIdentifier, type NormalizedIdentifier } from "./identifiers.js";
import type { Collector, CollectorContext, CollectorOutput, Finding } from "./collectors.js";
import type { IdentifierType } from "./types.js";
import type { OsintWorkerClient } from "./worker-client.js";

/** POST с запросом и до четырёх GET по токену результата. */
export const EGRUL_BOUND = 5;

type EntityFinding = Extract<Finding, { kind: "entity" }>;
type RegistryKind = "tax_id" | "registration_number" | "organization";

interface RegistryRecord {
  kind: "organization" | "entrepreneur";
  name: string;
  inn: string | null;
  ogrn: string | null;
  registered: string | null;
  terminated: string | null;
  region: string | null;
  short_name?: string | null;
  kpp?: string | null;
  address?: string | null;
  head?: string | null;
}

const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

function records(raw: unknown): RegistryRecord[] {
  if (!Array.isArray(raw)) return [];
  const result: RegistryRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const kind = row.kind === "organization" || row.kind === "entrepreneur" ? row.kind : null;
    const name = str(row.name);
    if (!kind || !name) continue;
    result.push({
      kind,
      name,
      inn: str(row.inn),
      ogrn: str(row.ogrn),
      registered: str(row.registered),
      terminated: str(row.terminated),
      region: str(row.region),
      short_name: str(row.short_name),
      kpp: str(row.kpp),
      address: str(row.address),
      head: str(row.head),
    });
  }
  return result;
}

/** Запрос к реестру: только российские номера с верной контрольной суммой. */
function registryQuery(type: IdentifierType, normalized: string): { kind: RegistryKind; value: string } | null {
  if (type === "tax_id" || type === "registration_number") {
    const russian = normalizeIdentifier(type, normalized, { country: "RU" });
    return russian && /^\d+$/.test(russian.normalized) ? { kind: type, value: russian.normalized } : null;
  }
  if (type === "organization" && normalized.length >= 3 && normalized.length <= 200) {
    return { kind: "organization", value: normalized };
  }
  return null;
}

function properties(entries: Array<[string, string | null | undefined]>): EntityFinding["properties"] {
  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
    .map(([property, value]) => ({ property, value: value.slice(0, 500) }));
}

export class EgrulCollector implements Collector {
  readonly name = "egrul";

  constructor(
    private readonly worker: Pick<OsintWorkerClient, "egrul">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  accepts(type: IdentifierType): boolean {
    return type === "tax_id" || type === "registration_number" || type === "organization";
  }

  reserve(remainingRequests: number): number {
    return Math.max(0, Math.min(remainingRequests, EGRUL_BOUND));
  }

  async collect({ target, signal, remainingRequests }: CollectorContext): Promise<CollectorOutput> {
    const query = registryQuery(target.type, target.normalized);
    // Иностранный номер или слишком короткое наименование — не для ФНС.
    if (!query) return { status: "skipped", errorCode: "osint_registry_not_applicable", externalRequests: 0, sources: [] };
    if (remainingRequests < EGRUL_BOUND) {
      return { status: "skipped", errorCode: "osint_budget_exhausted", externalRequests: 0, sources: [] };
    }
    signal.throwIfAborted();
    const result = await this.worker.egrul(query.kind, query.value);
    const found = records(result.data.records);
    const evidence = structuredEvidence({ collector: "egrul", query: query.kind, records: found });
    const findings: Finding[] = [];
    for (const record of found) findings.push(...this.findings(record, evidence));
    return {
      status: result.status === "degraded" ? "degraded" : "succeeded",
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      externalRequests: Math.min(result.requests, EGRUL_BOUND),
      sources: findings.length > 0 ? [{
        locator: `egrul:${query.kind}:${query.value}`,
        canonicalUrl: result.sourceUrl,
        domain: "egrul.nalog.ru",
        tier: "official_registry",
        retrievedAt: this.now().toISOString(),
        contentHash: evidence.hash,
        findings,
      }] : [],
    };
  }

  private findings(record: RegistryRecord, evidence: Finding["evidence"]): Finding[] {
    const inn = record.inn ? normalizeIdentifier("tax_id", record.inn, { country: "RU" }) : null;
    const ogrn = record.ogrn ? normalizeIdentifier("registration_number", record.ogrn, { country: "RU" }) : null;
    const key: NormalizedIdentifier | null = inn ?? ogrn;
    if (!key) return [];
    const organization = record.kind === "organization";
    const entity: EntityFinding = {
      kind: "entity",
      evidence,
      schema: organization ? "Organization" : "LegalEntity",
      identifier: key,
      caption: record.name,
      properties: properties([
        ["name", record.name],
        ["alias", record.short_name],
        ["legalForm", organization ? null : "индивидуальный предприниматель"],
        ["innCode", record.inn],
        ["ogrnCode", record.ogrn],
        ["kppCode", record.kpp],
        ["incorporationDate", record.registered],
        ["dissolutionDate", record.terminated],
        ["status", record.terminated ? "деятельность прекращена" : "действует"],
        ["jurisdiction", "ru"],
        ["region", record.region],
        ["address", organization ? record.address : null],
        ["director", organization ? record.head : null],
      ]),
    };
    // Второй номер той же записи — тот же субъект: он запоминается за
    // сущностью. Расширять его незачем: реестр уже ответил о нём.
    const discovered: Finding[] = [inn, ogrn]
      .filter((item): item is NormalizedIdentifier => item !== null && item.normalized !== key.normalized)
      .map((identifier) => ({ kind: "discovered" as const, evidence, identifier, owner: key.normalized, expand: false }));
    return [entity, ...discovered];
  }
}
