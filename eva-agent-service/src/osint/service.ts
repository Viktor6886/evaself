/**
 * OSINT-исследования: создание, статус, отмена, удаление.
 *
 * Условия, на которых исследование людей разрешено (`docs/OSINT.md`,
 * инвариант 30): явная просьба человека, заявленная цель, дневной лимит,
 * аудит и выключенный по умолчанию флаг. Сервис проверяет их сам, а не
 * полагается на вызывающего: инструмент Letta, API Mini App и тест
 * проходят через одни и те же проверки.
 *
 * Запись идёт в PostgreSQL, фоновая работа — заданием `osint_investigation`
 * в очереди `research` через job outbox. Текст запроса и цель живут
 * только в строке исследования; в задании, аудите и журнале — id и типы.
 */

import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { EvaError } from "../errors.js";
import type { JobOutbox } from "../jobs/job-outbox.js";
import { jobIdempotencyKey } from "../jobs/job-outbox.js";
import type { JobRunJournal } from "../jobs/job-runs.js";
import { SOURCE_TIER_QUALITY } from "./confidence.js";
import { canonicalJson, structuredEvidence } from "./evidence.js";
import { normalizeIdentifier, type NormalizedIdentifier } from "./identifiers.js";
import { linkIdentifier, upsertIdentifier, type Queryable } from "./repository.js";
import { DEFAULT_BUDGET, isIdentifierType, type IdentifierType, type InvestigationBudget } from "./types.js";

export const OSINT_JOB_TYPE = "osint_investigation";

/** Сколько идентификаторов можно дать в одном запросе. */
export const MAX_SEEDS = 10;

/** Бюджет глубокого режима: больше глубина и запросов, срок тот же. */
export const DEEP_BUDGET: InvestigationBudget = {
  ...DEFAULT_BUDGET,
  maxDepth: 3,
  maxIdentifiers: 200,
  maxExternalRequests: 600,
};

export interface OsintDatabase {
  withUserScope<T>(input: { userId: number; label: string; inherit?: boolean }, work: () => Promise<T>): Promise<T>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  query: Queryable["query"];
}

export interface CreateInvestigationInput {
  userId: number;
  conversationId?: string | null;
  /** Просьба человека как есть. */
  query: string;
  /** Зачем это нужно. Без цели исследование не создаётся. */
  purpose: string;
  subject: "person" | "organization";
  seeds: Array<{ type: string; value: string }>;
  mode?: "standard" | "deep";
  /** Повтор с тем же ключом возвращает то же исследование. */
  idempotencyKey: string;
}

export interface InvestigationStatus {
  id: string;
  status: string;
  mode: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  frontier: { pending: number; done: number; skipped: number };
  runs: Record<string, number>;
  sources: number;
  entities: number;
  externalRequests: number;
}

const invalid = (code: string, message: string) => new EvaError(message, { code, statusCode: 400 });

export class OsintService {
  constructor(
    private readonly db: OsintDatabase,
    private readonly jobs: Pick<JobOutbox, "record">,
    private readonly runs: Pick<JobRunJournal, "requestCancelByCorrelation"> | null,
    private readonly options: { enabled: boolean; dailyLimit: number },
  ) {}

  /** Проверка и нормализация запроса. Отдельно — чтобы вызывающий мог показать ошибку до записи. */
  static validate(input: CreateInvestigationInput): NormalizedIdentifier[] {
    const query = input.query.trim();
    if (!query || query.length > 4_000) throw invalid("osint_query_invalid", "Запрос пуст или длиннее 4000 знаков");
    const purpose = input.purpose.trim();
    if (purpose.length < 3 || purpose.length > 1_000) {
      throw invalid("osint_purpose_required", "Нужна цель исследования: зачем это ищется");
    }
    if (!/^[A-Za-z0-9:_-]{8,200}$/.test(input.idempotencyKey)) {
      throw invalid("osint_idempotency_key_invalid", "Ключ идемпотентности не задан");
    }
    if (input.seeds.length === 0 || input.seeds.length > MAX_SEEDS) {
      throw invalid("osint_seeds_invalid", `Нужно от 1 до ${MAX_SEEDS} идентификаторов`);
    }
    const seen = new Set<string>();
    const seeds: NormalizedIdentifier[] = [];
    for (const seed of input.seeds) {
      if (!isIdentifierType(seed.type)) throw invalid("osint_seed_type_invalid", "Неизвестный тип идентификатора");
      const normalized = normalizeIdentifier(seed.type, seed.value);
      if (!normalized) throw invalid("osint_seed_invalid", `Идентификатор типа ${seed.type} не распознан`);
      const key = `${normalized.type}\u0000${normalized.normalized}`;
      if (!seen.has(key)) {
        seen.add(key);
        seeds.push(normalized);
      }
    }
    return seeds;
  }

  async create(input: CreateInvestigationInput): Promise<{ id: string; created: boolean }> {
    if (!this.options.enabled) {
      throw new EvaError("OSINT-исследования выключены", { code: "osint_disabled", statusCode: 403 });
    }
    const seeds = OsintService.validate(input);
    const mode = input.mode ?? "standard";
    const budget = mode === "deep" ? DEEP_BUDGET : DEFAULT_BUDGET;
    const outcome = await this.db.withUserScope({ userId: input.userId, label: "osint.create", inherit: true }, async () =>
      await this.db.transaction(async (client) => {
        // Всё — под блокировкой строки пользователя: два одновременных
        // запроса с тем же ключом получают одно исследование, а не отказ
        // по лимиту или уникальному ключу, и не проходят оба на последнем
        // месте лимита.
        await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [input.userId]);
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM osint_investigations WHERE user_id = $1 AND idempotency_key = $2`,
          [input.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

        const { rows: [usage] } = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM osint_investigations
            WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
          [input.userId],
        );
        if ((usage?.count ?? 0) >= this.options.dailyLimit) {
          throw new EvaError("Дневной лимит исследований исчерпан", {
            code: "osint_daily_limit", statusCode: 429, retryable: true,
          });
        }

        const id = randomUUID();
        await client.query(
          `INSERT INTO osint_investigations
             (id, user_id, conversation_id, query, purpose, mode, status, budget, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, $8)`,
          [id, input.userId, input.conversationId ?? null, input.query.trim(), input.purpose.trim(), mode,
            JSON.stringify(budget), input.idempotencyKey],
        );
        const subjectId = await this.createSubject(client, input, id, seeds);
        await client.query(
          `UPDATE osint_investigations SET subject_entity_id = $3 WHERE id = $1 AND user_id = $2`,
          [id, input.userId, subjectId],
        );
        await this.jobs.record(client, {
          type: OSINT_JOB_TYPE,
          queue: "research",
          userId: input.userId,
          conversationId: input.conversationId ?? null,
          agentId: null,
          traceId: id,
          correlationId: id,
          idempotencyKey: jobIdempotencyKey({ type: OSINT_JOB_TYPE, userId: input.userId, discriminator: id }),
          payloadRef: id,
          payload: { investigation_id: id },
          deadlineMs: 2 * 60 * 60_000,
          timezone: "UTC",
          source: "user",
          privacy: "restricted",
        });
        await audit(client, "osint.investigation.create", id, {
          user_id: input.userId,
          mode,
          subject: input.subject,
          seed_types: seeds.map((seed) => seed.type),
        });
        return { id, created: true };
      }));
    return outcome;
  }

  /**
   * Субъект и идентификаторы запроса.
   *
   * Идентификаторы, которые дал человек, принадлежат субъекту по
   * определению: так он и задан. Доказательство — сам запрос (источник
   * `seed`), а не найденное где-то подтверждение.
   */
  private async createSubject(
    client: Queryable,
    input: CreateInvestigationInput,
    investigationId: string,
    seeds: NormalizedIdentifier[],
  ): Promise<string> {
    const subjectId = randomUUID();
    const named = seeds.find((seed) => seed.type === "name" || seed.type === "organization");
    const caption = (named?.raw ?? seeds[0]!.normalized).trim().slice(0, 500);
    await client.query(
      `INSERT INTO osint_entities (id, user_id, schema, caption) VALUES ($1, $2, $3, $4)`,
      [subjectId, input.userId, input.subject === "organization" ? "Organization" : "Person", caption],
    );
    await client.query(
      `INSERT INTO osint_investigation_entities (investigation_id, entity_id, user_id) VALUES ($1, $2, $3)`,
      [investigationId, subjectId, input.userId],
    );
    const sourceId = randomUUID();
    await client.query(
      `INSERT INTO osint_sources
         (id, user_id, investigation_id, locator, canonical_url, domain, collector, tier, quality, retrieved_at)
       VALUES ($1, $2, $3, 'seed:request', NULL, 'seed', 'seed', 'unknown', $4, now())`,
      [sourceId, input.userId, investigationId, SOURCE_TIER_QUALITY.unknown],
    );
    for (const seed of seeds) {
      const data = { collector: "seed", type: seed.type, value: seed.normalized };
      const evidence = structuredEvidence(data);
      const evidenceId = randomUUID();
      await client.query(
        `INSERT INTO osint_evidence (id, user_id, investigation_id, source_id, kind, structured, evidence_hash)
         VALUES ($1, $2, $3, $4, 'structured', $5::jsonb, $6)`,
        [evidenceId, input.userId, investigationId, sourceId, canonicalJson(data), evidence.hash],
      );
      const identifierId = await upsertIdentifier(client, input.userId, seed);
      await linkIdentifier(client, input.userId, {
        entityId: subjectId, identifierId, evidenceId, collector: "seed", confidence: 1,
      });
      await client.query(
        `INSERT INTO osint_frontier (investigation_id, identifier_id, user_id, depth)
         VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
        [investigationId, identifierId, input.userId],
      );
    }
    return subjectId;
  }

  async status(userId: number, id: string): Promise<InvestigationStatus | null> {
    return await this.db.withUserScope({ userId, label: "osint.status", inherit: true }, async () => {
      const { rows: [row] } = await this.db.query<{
        id: string; status: string; mode: string; created_at: Date; started_at: Date | null;
        completed_at: Date | null; error_code: string | null;
      }>(
        `SELECT id, status, mode, created_at, started_at, completed_at, error_code
           FROM osint_investigations WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!row) return null;
      const { rows: [counts] } = await this.db.query<{
        pending: number; done: number; skipped: number; sources: number; entities: number; requests: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM osint_frontier WHERE investigation_id = $1 AND user_id = $2
              AND status IN ('pending', 'processing')) AS pending,
           (SELECT count(*)::int FROM osint_frontier WHERE investigation_id = $1 AND user_id = $2 AND status = 'done') AS done,
           (SELECT count(*)::int FROM osint_frontier WHERE investigation_id = $1 AND user_id = $2 AND status = 'skipped') AS skipped,
           (SELECT count(*)::int FROM osint_sources WHERE investigation_id = $1 AND user_id = $2 AND collector <> 'seed') AS sources,
           (SELECT count(*)::int FROM osint_investigation_entities WHERE investigation_id = $1 AND user_id = $2) AS entities,
           (SELECT coalesce(sum(external_requests), 0)::int FROM osint_collector_runs
             WHERE investigation_id = $1 AND user_id = $2) AS requests`,
        [id, userId],
      );
      // Просмотр данных о третьих лицах — тоже событие аудита.
      await audit(this.db, "osint.investigation.view", id, { user_id: userId });
      const { rows: runRows } = await this.db.query<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count FROM osint_collector_runs
          WHERE investigation_id = $1 AND user_id = $2 GROUP BY status`,
        [id, userId],
      );
      return {
        id: row.id,
        status: row.status,
        mode: row.mode,
        createdAt: new Date(row.created_at).toISOString(),
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        errorCode: row.error_code,
        frontier: { pending: counts!.pending, done: counts!.done, skipped: counts!.skipped },
        runs: Object.fromEntries(runRows.map((run) => [run.status, run.count])),
        sources: counts!.sources,
        entities: counts!.entities,
        externalRequests: counts!.requests,
      };
    });
  }

  /** Отмена: исследование останавливается на ближайшей границе шага. */
  async cancel(userId: number, id: string): Promise<boolean> {
    const requested = await this.runs?.requestCancelByCorrelation(id, userId, randomUUID()) ?? false;
    return await this.db.withUserScope({ userId, label: "osint.cancel", inherit: true }, async () =>
      await this.db.transaction(async (client) => {
        const result = await client.query(
          `UPDATE osint_investigations SET status = 'cancelled', completed_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'processing') RETURNING id`,
          [id, userId],
        );
        const cancelled = result.rows.length > 0;
        if (cancelled) await audit(client, "osint.investigation.cancel", id, { user_id: userId });
        return cancelled || requested;
      }));
  }

  /**
   * Удаление исследования и всего, что осталось без него.
   *
   * Сущность живёт на уровне пользователя и может быть нужна другому
   * исследованию — удаляются только те, что больше ни к одному не
   * привязаны. Так же идентификаторы: остаются только используемые.
   */
  async delete(userId: number, id: string): Promise<boolean> {
    return await this.db.withUserScope({ userId, label: "osint.delete", inherit: true }, async () =>
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE osint_investigations SET status = 'cancelled', completed_at = now()
            WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'processing')`,
          [id, userId],
        );
        const result = await client.query(
          `DELETE FROM osint_investigations WHERE id = $1 AND user_id = $2 RETURNING id`,
          [id, userId],
        );
        if (result.rows.length === 0) return false;
        await removeOrphans(client, userId);
        await audit(client, "osint.investigation.delete", id, { user_id: userId });
        return true;
      }));
  }
}

/** Сущности и идентификаторы пользователя, не нужные ни одному исследованию. */
export async function removeOrphans(client: Queryable, userId: number): Promise<void> {
  await client.query(
    `DELETE FROM osint_entities e
      WHERE e.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM osint_investigation_entities ie
                         WHERE ie.entity_id = e.id AND ie.user_id = $1)`,
    [userId],
  );
  await client.query(
    `DELETE FROM osint_identifiers i
      WHERE i.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM osint_entity_identifiers ei
                         WHERE ei.identifier_id = i.id AND ei.user_id = $1)
        AND NOT EXISTS (SELECT 1 FROM osint_frontier f
                         WHERE f.identifier_id = i.id AND f.user_id = $1)`,
    [userId],
  );
}

/** Запись аудита: id и типы, без запроса, цели и значений идентификаторов. */
async function audit(client: Queryable, operation: string, target: string, params: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor, operation, target, params_redacted_json, result, request_id)
     VALUES ('eva-agent-service', $1, $2, $3::jsonb, 'success', $4)`,
    [operation, target, JSON.stringify(params), randomUUID()],
  );
}

export type { IdentifierType };
