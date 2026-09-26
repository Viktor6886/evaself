/**
 * Отчёт OSINT-исследования.
 *
 * Отчёт собирается из графа детерминированно, без модели: каждая строка —
 * сущность, утверждение или цитата с источником. Модель получает готовый
 * отчёт через инструмент и пересказывает его человеку, но не дописывает
 * то, чего в графе нет.
 *
 * Отчёт показывает и то, чего не удалось: деградировавшие источники,
 * сработавшие ограничения, непроверенные связи. «Ничего не найдено» и «не
 * смогли проверить» — разные ответы, и человек должен видеть, какой из них
 * перед ним.
 */

import type { Queryable } from "./repository.js";

/** Сколько элементов каждого раздела попадает в отчёт. */
const LIMIT = { accounts: 30, entities: 30, claims: 300, identifiers: 100, mentions: 20 } as const;

export interface OsintReport {
  id: string;
  status: string;
  mode: string;
  purpose: string;
  createdAt: string;
  completedAt: string | null;
  subject: { caption: string; schema: string; identifiers: Array<{ type: string; value: string }> } | null;
  accounts: Array<{
    url: string;
    confidence: number;
    collectors: string[];
    claims: Array<{ property: string; value: string; status: string }>;
    match: { status: string; score: number } | null;
  }>;
  infrastructure: Array<{ schema: string; caption: string; properties: Record<string, string[]> }>;
  mentions: Array<{ url: string | null; quote: string }>;
  discovered: Array<{ type: string; value: string; depth: number }>;
  runs: Array<{ collector: string; status: string; reason: string | null; count: number }>;
  externalRequests: number;
  maxExternalRequests: number | null;
  limitations: string[];
}

type Row = Record<string, unknown>;

export class OsintReportBuilder {
  constructor(private readonly db: Queryable) {}

  async build(userId: number, id: string): Promise<OsintReport | null> {
    const { rows: [investigation] } = await this.db.query<{
      id: string; status: string; mode: string; purpose: string; budget: { maxExternalRequests?: number };
      created_at: Date; completed_at: Date | null; subject_entity_id: string | null;
    }>(
      `SELECT id, status, mode, purpose, budget, created_at, completed_at, subject_entity_id
         FROM osint_investigations WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!investigation) return null;
    const subjectId = investigation.subject_entity_id;

    const { rows: entities } = await this.db.query<{
      id: string; schema: string; caption: string; identifiers: Row[] | null;
    }>(
      `SELECT e.id, e.schema, e.caption,
              (SELECT json_agg(json_build_object(
                         'type', i.type, 'value', i.normalized_value,
                         'confidence', ei.confidence, 'collector', ei.collector))
                 FROM osint_entity_identifiers ei
                 JOIN osint_identifiers i ON i.id = ei.identifier_id AND i.user_id = ei.user_id
                 -- Сущность бывает общей у нескольких исследований; в отчёт
                 -- идут только связи, доказанные в этом.
                 JOIN osint_evidence ev ON ev.id = ei.evidence_id AND ev.user_id = ei.user_id
                                       AND ev.investigation_id = $1
                WHERE ei.entity_id = e.id AND ei.user_id = $2) AS identifiers
         FROM osint_investigation_entities ie
         JOIN osint_entities e ON e.id = ie.entity_id AND e.user_id = ie.user_id
        WHERE ie.investigation_id = $1 AND ie.user_id = $2
        ORDER BY e.created_at
        LIMIT 200`,
      [id, userId],
    );
    const { rows: claims } = await this.db.query<{ entity_id: string; property: string; value: string; status: string }>(
      `SELECT entity_id, property, value, status FROM osint_claims
        WHERE investigation_id = $1 AND user_id = $2
        ORDER BY confidence DESC, created_at
        LIMIT ${LIMIT.claims}`,
      [id, userId],
    );
    const { rows: matches } = await this.db.query<{ left_entity_id: string; right_entity_id: string; status: string; score: number }>(
      `SELECT left_entity_id, right_entity_id, status, score FROM osint_entity_matches
        WHERE investigation_id = $1 AND user_id = $2`,
      [id, userId],
    );
    const { rows: runs } = await this.db.query<{ collector: string; status: string; reason: string | null; count: number; requests: number }>(
      `SELECT collector, status, degraded_reason AS reason, count(*)::int AS count,
              coalesce(sum(external_requests), 0)::int AS requests
         FROM osint_collector_runs WHERE investigation_id = $1 AND user_id = $2
        GROUP BY collector, status, degraded_reason
        ORDER BY collector, status`,
      [id, userId],
    );
    const { rows: discovered } = await this.db.query<{ type: string; value: string; depth: number }>(
      `SELECT i.type, i.normalized_value AS value, f.depth
         FROM osint_frontier f
         JOIN osint_identifiers i ON i.id = f.identifier_id AND i.user_id = f.user_id
        WHERE f.investigation_id = $1 AND f.user_id = $2 AND f.depth > 0
        ORDER BY f.depth, f.created_at
        LIMIT ${LIMIT.identifiers}`,
      [id, userId],
    );
    const { rows: mentions } = await this.db.query<{ url: string | null; quote: string }>(
      `SELECT s.canonical_url AS url, e.quote
         FROM osint_evidence e
         JOIN osint_sources s ON s.id = e.source_id AND s.user_id = e.user_id
        WHERE e.investigation_id = $1 AND e.user_id = $2 AND e.kind = 'quote'
        ORDER BY e.created_at
        LIMIT ${LIMIT.mentions}`,
      [id, userId],
    );

    const claimsBy = new Map<string, Array<{ property: string; value: string; status: string }>>();
    for (const claim of claims) {
      const list = claimsBy.get(claim.entity_id) ?? [];
      list.push({ property: claim.property, value: claim.value, status: claim.status });
      claimsBy.set(claim.entity_id, list);
    }
    const matchOf = (entityId: string) => {
      const match = matches.find((item) =>
        (item.left_entity_id === entityId && item.right_entity_id === subjectId)
        || (item.right_entity_id === entityId && item.left_entity_id === subjectId));
      return match ? { status: match.status, score: Number(match.score) } : null;
    };
    const identifiersOf = (entity: { identifiers: Row[] | null }) => entity.identifiers ?? [];

    const subject = entities.find((entity) => entity.id === subjectId);
    const accounts = entities.filter((entity) => entity.schema === "UserAccount").slice(0, LIMIT.accounts).map((entity) => {
      const ids = identifiersOf(entity);
      return {
        url: entity.caption,
        confidence: Math.max(0, ...ids.map((item) => Number(item.confidence) || 0)),
        collectors: [...new Set(ids.map((item) => String(item.collector)))].sort(),
        claims: claimsBy.get(entity.id) ?? [],
        match: matchOf(entity.id),
      };
    });
    const infrastructure = entities
      .filter((entity) => entity.schema.startsWith("eva:") || (entity.id !== subjectId && entity.schema === "Organization"))
      .slice(0, LIMIT.entities)
      .map((entity) => {
        const properties: Record<string, string[]> = {};
        for (const claim of claimsBy.get(entity.id) ?? []) {
          const values = properties[claim.property] ?? [];
          if (!values.includes(claim.value) && values.length < 20) values.push(claim.value);
          properties[claim.property] = values;
        }
        return { schema: entity.schema, caption: entity.caption, properties };
      });

    const externalRequests = runs.reduce((sum, run) => sum + run.requests, 0);
    const maxExternalRequests = typeof investigation.budget?.maxExternalRequests === "number"
      ? investigation.budget.maxExternalRequests : null;
    return {
      id: investigation.id,
      status: investigation.status,
      mode: investigation.mode,
      purpose: investigation.purpose,
      createdAt: new Date(investigation.created_at).toISOString(),
      completedAt: investigation.completed_at ? new Date(investigation.completed_at).toISOString() : null,
      subject: subject ? {
        caption: subject.caption,
        schema: subject.schema,
        identifiers: identifiersOf(subject).map((item) => ({ type: String(item.type), value: String(item.value) })),
      } : null,
      accounts,
      infrastructure,
      mentions: mentions.map((item) => ({ url: item.url, quote: item.quote.slice(0, 400) })),
      discovered,
      runs: runs.map(({ collector, status, reason, count }) => ({ collector, status, reason, count })),
      externalRequests,
      maxExternalRequests,
      limitations: limitations(investigation.status, runs, accounts, externalRequests, maxExternalRequests),
    };
  }
}

function limitations(
  status: string,
  runs: Array<{ collector: string; status: string; reason: string | null }>,
  accounts: OsintReport["accounts"],
  externalRequests: number,
  maxExternalRequests: number | null,
): string[] {
  const notes: string[] = [];
  if (status === "queued" || status === "processing") notes.push("Исследование ещё идёт: отчёт неполный.");
  if (status === "cancelled") notes.push("Исследование отменено: собрано не всё.");
  if (status === "failed") notes.push("Исследование завершилось сбоем: собрано не всё.");
  const degraded = runs.filter((run) => run.status === "degraded" || run.status === "failed");
  if (degraded.length > 0) {
    const names = [...new Set(degraded.map((run) => run.reason ? `${run.collector} (${run.reason})` : run.collector))];
    notes.push(`Часть источников не ответила или ограничила доступ: ${names.join(", ")}. Отсутствие данных из них не означает, что данных нет.`);
  }
  if (maxExternalRequests !== null && externalRequests >= maxExternalRequests) {
    notes.push("Исчерпан бюджет внешних запросов: расширение остановлено.");
  }
  if (accounts.some((account) => !account.match || !["confirmed", "probable"].includes(account.match.status))) {
    notes.push("Найденные по нику аккаунты не подтверждены как принадлежащие субъекту: совпадение ника не доказывает, что это один человек.");
  }
  notes.push("Использованы только открытые источники. Базы утечек, закрытые реестры и распознавание лиц не применялись.");
  return notes;
}

/**
 * Отчёт текстом для модели: коротко, с пометками статуса у каждого пункта.
 * Длина ограничена — отчёт идёт в контекст хода.
 */
export function renderReport(report: OsintReport, maxLength = 6_000): string {
  const lines: string[] = [];
  lines.push(`Исследование ${report.id}: ${report.status}.`);
  if (report.subject) {
    lines.push(`Субъект: ${report.subject.caption} (${report.subject.identifiers.map((item) => `${item.type}: ${item.value}`).join("; ")}).`);
  }
  if (report.accounts.length > 0) {
    lines.push("", "Аккаунты (принадлежность субъекту НЕ установлена, если не сказано иное):");
    for (const account of report.accounts) {
      const match = account.match ? `связь с субъектом: ${account.match.status}` : "связь с субъектом не оценивалась";
      const claims = account.claims.slice(0, 3).map((claim) => `${claim.property}=${claim.value} [${claim.status}]`).join(", ");
      lines.push(`- ${account.url} — подтвердили: ${account.collectors.join(", ") || "—"}; ${match}${claims ? `; ${claims}` : ""}`);
    }
  }
  if (report.infrastructure.length > 0) {
    lines.push("", "Инфраструктура и организации:");
    for (const entity of report.infrastructure) {
      const props = Object.entries(entity.properties).slice(0, 8)
        .map(([key, values]) => `${key}: ${values.slice(0, 5).join(", ")}`).join("; ");
      lines.push(`- ${entity.caption} (${entity.schema})${props ? ` — ${props}` : ""}`);
    }
  }
  if (report.mentions.length > 0) {
    lines.push("", "Упоминания (дословные цитаты):");
    for (const mention of report.mentions.slice(0, 10)) lines.push(`- ${mention.url ?? "источник"}: «${mention.quote.slice(0, 200)}»`);
  }
  if (report.discovered.length > 0) {
    lines.push("", `Найдено новых идентификаторов: ${report.discovered.length}.`);
  }
  lines.push("", "Ограничения:", ...report.limitations.map((note) => `- ${note}`));
  const text = lines.join("\n");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
