/**
 * Сборка temporal-памяти.
 *
 * Одна точка входа: писатель памяти получает согласованный набор
 * (дедупликация → версия → доказательство → разрешение сущности) или не
 * получает ничего. Собирать их по отдельности значило бы допустить
 * запись версии в обход дедупликации.
 *
 * Флаг `EVA_TEMPORAL_MEMORY` выключен — сборка не создаётся, и весь
 * существующий граф работает как раньше.
 */

export { MemoryDeduplicator, periodsOverlap } from "./dedup.js";
export type { EdgeDuplicate, NodeDuplicate } from "./dedup.js";
export {
  AUTO_MERGE_SCORE,
  CANDIDATE_SCORE,
  EntityResolver,
  normalizeName,
} from "./entity-resolution.js";
export type {
  EntityCandidate,
  ResolutionDecision,
  ResolutionResult,
  ResolveInput,
} from "./entity-resolution.js";
export {
  aggregateConfidence,
  buildEvidence,
  evidenceHash,
  hasDirectStatement,
} from "./evidence.js";
export type { EvidenceInput, EvidenceRecord, EvidenceSupport } from "./evidence.js";
export { TemporalMemoryQueries } from "./queries.js";
export type { FactVersion } from "./queries.js";
export {
  assertTransition,
  canTransition,
  isInference,
  isTemporalStatus,
  isTerminal,
  LIVE_STATUSES,
  MemoryStatusError,
  sourceTrust,
  TEMPORAL_STATUSES,
} from "./status.js";
export type { TemporalStatus } from "./status.js";
export { TemporalBackfill } from "./backfill.js";
export type { BackfillProgress, BackfillResult } from "./backfill.js";
export { defaultStatus, normalizeStatus, valueFingerprint } from "./fact-value.js";
export { TemporalMemoryRepository } from "./versions.js";
export type { FactInput, FactOutcome, FactResult, MemoryActor } from "./versions.js";

import { MemoryDeduplicator } from "./dedup.js";
import { EntityResolver } from "./entity-resolution.js";
import { TemporalMemoryQueries } from "./queries.js";
import { TemporalBackfill } from "./backfill.js";
import { TemporalMemoryRepository } from "./versions.js";

export interface TemporalMemoryLayer {
  versions: TemporalMemoryRepository;
  queries: TemporalMemoryQueries;
  entities: EntityResolver;
  dedup: MemoryDeduplicator;
  backfill: TemporalBackfill;
  enabled: boolean;
}

export function buildTemporalMemory(enabled: boolean): TemporalMemoryLayer {
  const versions = new TemporalMemoryRepository();
  return {
    versions,
    queries: new TemporalMemoryQueries(),
    entities: new EntityResolver(),
    dedup: new MemoryDeduplicator(),
    backfill: new TemporalBackfill(versions),
    enabled,
  };
}
