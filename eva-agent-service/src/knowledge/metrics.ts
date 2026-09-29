/**
 * Метрики базы знаний: вызовы Qdrant, эмбеддинги, reranker, индексация.
 *
 * Счётчики живут в модуле, как у инструментов (`tools/tool-metrics.ts`):
 * клиенту Qdrant до сборщика метрик дела нет. Метки — закрытые наборы
 * операций и исходов; ни запросов, ни имён документов, ни идентификаторов
 * пользователей здесь не бывает.
 */

export type QdrantOperation = "search" | "upsert" | "delete" | "count" | "admin" | "health";

export type KnowledgeTimedStage = "embedding" | "rerank";

interface Timing {
  count: number;
  errors: number;
  sum: number;
  max: number;
}

const QDRANT_OPERATIONS: readonly QdrantOperation[] = ["search", "upsert", "delete", "count", "admin", "health"];
const STAGES: readonly KnowledgeTimedStage[] = ["embedding", "rerank"];

const empty = (): Timing => ({ count: 0, errors: 0, sum: 0, max: 0 });

const qdrant = new Map<QdrantOperation, Timing>(QDRANT_OPERATIONS.map((name) => [name, empty()]));
const stages = new Map<KnowledgeTimedStage, Timing>(STAGES.map((name) => [name, empty()]));

function add(timing: Timing, ms: number, failed: boolean): void {
  const value = Math.max(0, Math.round(ms));
  timing.count += 1;
  timing.sum += value;
  timing.max = Math.max(timing.max, value);
  if (failed) timing.errors += 1;
}

export function recordQdrantCall(operation: QdrantOperation, ms: number, failed: boolean): void {
  add(qdrant.get(operation)!, ms, failed);
}

export function recordKnowledgeStage(stage: KnowledgeTimedStage, ms: number, failed: boolean): void {
  add(stages.get(stage)!, ms, failed);
}

export interface KnowledgeTimingRow extends Timing {
  name: string;
}

export function knowledgeMetrics(): { qdrant: KnowledgeTimingRow[]; stages: KnowledgeTimingRow[] } {
  return {
    qdrant: [...qdrant].map(([name, timing]) => ({ name, ...timing })),
    stages: [...stages].map(([name, timing]) => ({ name, ...timing })),
  };
}

/** Только для тестов: счётчики модуля живут всё время процесса. */
export function resetKnowledgeMetrics(): void {
  for (const timing of [...qdrant.values(), ...stages.values()]) Object.assign(timing, empty());
}
