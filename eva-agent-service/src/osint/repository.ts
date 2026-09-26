/**
 * Хранилище OSINT в PostgreSQL.
 *
 * Каждый запрос называет владельца: `user_id` стоит в условии даже там,
 * где строку уже однозначно задаёт её id. Внешние ключи схемы 084 не
 * дают сослаться на чужую строку, а условие здесь не даёт её прочитать.
 *
 * Повтор безопасен: вставки идут через уникальные ключи схемы
 * (`ON CONFLICT`), и повтор задания после сбоя возвращает те же строки,
 * а не создаёт вторые.
 */

import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { canonicalJson } from "./evidence.js";
import { SOURCE_TIER_QUALITY } from "./confidence.js";
import type { CollectedSource, FrontierItem } from "./collectors.js";
import type { NormalizedIdentifier } from "./identifiers.js";
import type { OsintStore, RunResult } from "./orchestrator.js";
import type { MatchDecision } from "./resolver.js";
import type { ClaimStatus, Evidence, IdentifierType, InvestigationBudget } from "./types.js";

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export class PgOsintStore implements OsintStore {
  constructor(
    private readonly db: Queryable,
    private readonly userId: number,
    private readonly investigationId: string,
  ) {}

  async begin(): Promise<{ budget: InvestigationBudget; subjectEntityId: string | null; startedAt: number } | null> {
    const { rows } = await this.db.query<{ budget: InvestigationBudget; subject_entity_id: string | null; started_at: Date }>(
      `UPDATE osint_investigations
          SET status = 'processing', started_at = coalesce(started_at, now()), updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'processing')
        RETURNING budget, subject_entity_id, started_at`,
      [this.investigationId, this.userId],
    );
    const row = rows[0];
    if (!row) return null;
    // Прерванный прошлый заход оставил элементы «в работе»: без возврата
    // в очередь они не обработались бы никогда.
    await this.db.query(
      `UPDATE osint_frontier SET status = 'pending'
        WHERE investigation_id = $1 AND user_id = $2 AND status = 'processing'`,
      [this.investigationId, this.userId],
    );
    return { budget: row.budget, subjectEntityId: row.subject_entity_id, startedAt: new Date(row.started_at).getTime() };
  }

  async status(): Promise<string | null> {
    const { rows } = await this.db.query<{ status: string }>(
      `SELECT status FROM osint_investigations WHERE id = $1 AND user_id = $2`,
      [this.investigationId, this.userId],
    );
    return rows[0]?.status ?? null;
  }

  async isCancelled(): Promise<boolean> {
    const { rows } = await this.db.query<{ status: string }>(
      `SELECT status FROM osint_investigations WHERE id = $1 AND user_id = $2`,
      [this.investigationId, this.userId],
    );
    return rows[0]?.status !== "processing";
  }

  async counters(): Promise<{ externalRequests: number; identifiers: number; entities: number }> {
    const { rows } = await this.db.query<{ requests: number; identifiers: number; entities: number }>(
      `SELECT
         (SELECT coalesce(sum(external_requests), 0)::int FROM osint_collector_runs
           WHERE investigation_id = $1 AND user_id = $2) AS requests,
         (SELECT count(*)::int FROM osint_frontier
           WHERE investigation_id = $1 AND user_id = $2) AS identifiers,
         (SELECT count(*)::int FROM osint_investigation_entities
           WHERE investigation_id = $1 AND user_id = $2) AS entities`,
      [this.investigationId, this.userId],
    );
    const row = rows[0]!;
    return { externalRequests: row.requests, identifiers: row.identifiers, entities: row.entities };
  }

  async nextFrontier(maxDepth: number): Promise<FrontierItem | null> {
    const { rows } = await this.db.query<{ identifier_id: string; depth: number; type: IdentifierType; normalized_value: string }>(
      `WITH next AS (
         SELECT identifier_id FROM osint_frontier
          WHERE investigation_id = $1 AND user_id = $2 AND status = 'pending' AND depth <= $3
          ORDER BY depth, created_at, identifier_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE osint_frontier f
          SET status = 'processing'
         FROM next, osint_identifiers i
        WHERE f.investigation_id = $1 AND f.user_id = $2
          AND f.identifier_id = next.identifier_id
          AND i.id = f.identifier_id AND i.user_id = $2
       RETURNING f.identifier_id, f.depth, i.type, i.normalized_value`,
      [this.investigationId, this.userId, maxDepth],
    );
    const row = rows[0];
    return row
      ? { identifierId: row.identifier_id, depth: row.depth, type: row.type, normalized: row.normalized_value }
      : null;
  }

  async finishFrontier(identifierId: string, status: "done" | "skipped"): Promise<void> {
    await this.db.query(
      `UPDATE osint_frontier SET status = $4
        WHERE investigation_id = $1 AND user_id = $2 AND identifier_id = $3`,
      [this.investigationId, this.userId, identifierId, status],
    );
  }

  async startRun(collector: string, identifierId: string): Promise<string | null> {
    // Завершённый прогон по той же цели не повторяется. Прогон, который
    // оборвался (`running`) или упал (`failed`), запускается заново.
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO osint_collector_runs
         (id, user_id, investigation_id, collector, target_identifier_id, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'running', now())
       ON CONFLICT (investigation_id, collector, target_identifier_id) WHERE target_identifier_id IS NOT NULL
       DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL, error_code = NULL
        WHERE osint_collector_runs.user_id = $2
          AND osint_collector_runs.status IN ('queued', 'running', 'failed')
       RETURNING id`,
      [randomUUID(), this.userId, this.investigationId, collector, identifierId],
    );
    return rows[0]?.id ?? null;
  }

  async finishRun(runId: string, result: RunResult): Promise<void> {
    await this.db.query(
      `UPDATE osint_collector_runs
          SET status = $3, degraded_reason = $4, error_code = $5, external_requests = $6, finished_at = now()
        WHERE id = $1 AND user_id = $2`,
      [runId, this.userId, result.status, result.degradedReason ?? null, result.errorCode ?? null, result.externalRequests],
    );
  }

  async saveSource(collector: string, source: CollectedSource): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO osint_sources
         (id, user_id, investigation_id, locator, canonical_url, domain, collector, tier, quality, retrieved_at, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (investigation_id, collector, locator)
       DO UPDATE SET retrieved_at = EXCLUDED.retrieved_at, content_hash = EXCLUDED.content_hash
        WHERE osint_sources.user_id = $2
       RETURNING id`,
      [
        randomUUID(), this.userId, this.investigationId, source.locator.slice(0, 2_000), source.canonicalUrl,
        source.domain, collector, source.tier, SOURCE_TIER_QUALITY[source.tier], source.retrievedAt, source.contentHash,
      ],
    );
    return rows[0]!.id;
  }

  async saveEvidence(sourceId: string, evidence: Evidence): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO osint_evidence
         (id, user_id, investigation_id, source_id, kind, quote, structured, evidence_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (source_id, evidence_hash)
       DO UPDATE SET evidence_hash = EXCLUDED.evidence_hash
        WHERE osint_evidence.user_id = $2
       RETURNING id`,
      [
        randomUUID(), this.userId, this.investigationId, sourceId, evidence.kind,
        evidence.kind === "quote" ? evidence.quote : null,
        evidence.kind === "structured" ? canonicalJson(evidence.data) : null,
        evidence.hash,
      ],
    );
    return rows[0]!.id;
  }

  async upsertIdentifier(identifier: NormalizedIdentifier): Promise<string> {
    return await upsertIdentifier(this.db, this.userId, identifier);
  }

  async upsertEntity(
    schema: string,
    caption: string,
    identifierId: string,
    allowCreate: boolean,
  ): Promise<{ entityId: string; created: boolean } | null> {
    // Одна сущность на идентификатор у одного пользователя, в каком бы
    // исследовании она ни нашлась.
    const existing = await this.db.query<{ id: string }>(
      `SELECT e.id FROM osint_entities e
         JOIN osint_entity_identifiers ei ON ei.entity_id = e.id AND ei.user_id = e.user_id
        WHERE e.user_id = $1 AND e.schema = $2 AND ei.identifier_id = $3
        ORDER BY e.created_at
        LIMIT 1`,
      [this.userId, schema, identifierId],
    );
    let entityId = existing.rows[0]?.id;
    const created = !entityId;
    if (!entityId && !allowCreate) return null;
    if (!entityId) {
      entityId = randomUUID();
      await this.db.query(
        `INSERT INTO osint_entities (id, user_id, schema, caption) VALUES ($1, $2, $3, $4)`,
        [entityId, this.userId, schema, caption.slice(0, 500)],
      );
    }
    await this.db.query(
      `INSERT INTO osint_investigation_entities (investigation_id, entity_id, user_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [this.investigationId, entityId, this.userId],
    );
    return { entityId, created };
  }

  async linkIdentifier(input: {
    entityId: string;
    identifierId: string;
    evidenceId: string;
    collector: string;
    confidence: number;
  }): Promise<void> {
    await linkIdentifier(this.db, this.userId, input);
  }

  async addClaim(input: {
    entityId: string;
    property: string;
    value: string;
    evidenceId: string;
    collector: string;
    confidence: number;
    status: ClaimStatus;
    retrievedAt: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO osint_claims
         (id, user_id, investigation_id, entity_id, property, value, evidence_id, collector, confidence, status, retrieved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (entity_id, property, value, evidence_id) DO NOTHING`,
      [
        randomUUID(), this.userId, this.investigationId, input.entityId, input.property, input.value.slice(0, 1_000),
        input.evidenceId, input.collector, input.confidence, input.status, input.retrievedAt,
      ],
    );
  }

  async recordMatch(leftEntityId: string, rightEntityId: string, decision: MatchDecision): Promise<void> {
    const [left, right] = leftEntityId < rightEntityId ? [leftEntityId, rightEntityId] : [rightEntityId, leftEntityId];
    // Решение человека правилом не перезаписывается.
    await this.db.query(
      `INSERT INTO osint_entity_matches
         (id, user_id, investigation_id, left_entity_id, right_entity_id, status, score, features, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'rule')
       ON CONFLICT (left_entity_id, right_entity_id)
       DO UPDATE SET status = EXCLUDED.status, score = EXCLUDED.score, features = EXCLUDED.features
        WHERE osint_entity_matches.user_id = $2 AND osint_entity_matches.decided_by = 'rule'`,
      [
        randomUUID(), this.userId, this.investigationId, left, right, decision.status,
        Math.min(1, Math.max(0, decision.score)),
        JSON.stringify(decision.features.map((feature) => ({
          kind: feature.kind, weight: feature.weight, evidenceIds: feature.evidenceIds,
        }))),
      ],
    );
  }

  async enqueue(identifierId: string, depth: number, runId: string): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO osint_frontier (investigation_id, identifier_id, user_id, depth, discovered_by_run)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (investigation_id, identifier_id) DO NOTHING`,
      [this.investigationId, identifierId, this.userId, depth, runId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(status: "completed" | "failed" | "cancelled", errorCode?: string): Promise<void> {
    // Отмена человеком не перезаписывается «завершением» воркера.
    await this.db.query(
      `UPDATE osint_investigations
          SET status = $3, error_code = $4, completed_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'processing')`,
      [this.investigationId, this.userId, status, errorCode ?? null],
    );
  }
}

export async function upsertIdentifier(db: Queryable, userId: number, identifier: NormalizedIdentifier): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO osint_identifiers (id, user_id, type, raw_value, normalized_value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, type, normalized_value)
     DO UPDATE SET last_seen = now()
      WHERE osint_identifiers.user_id = $2
     RETURNING id`,
    [randomUUID(), userId, identifier.type, identifier.raw.slice(0, 2_000), identifier.normalized],
  );
  return rows[0]!.id;
}

export async function linkIdentifier(
  db: Queryable,
  userId: number,
  input: { entityId: string; identifierId: string; evidenceId: string; collector: string; confidence: number },
): Promise<void> {
  await db.query(
    `INSERT INTO osint_entity_identifiers
       (entity_id, identifier_id, user_id, evidence_id, collector, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (entity_id, identifier_id, evidence_id)
     DO UPDATE SET last_seen = now(), confidence = EXCLUDED.confidence
      WHERE osint_entity_identifiers.user_id = $3`,
    [input.entityId, input.identifierId, userId, input.evidenceId, input.collector, input.confidence],
  );
}
