/**
 * Метрики базы знаний: вызовы Qdrant, эмбеддинги, reranker, поиск,
 * теневое сравнение, индексация.
 *
 * Счётчики живут в модуле, как у инструментов (`tools/tool-metrics.ts`):
 * клиенту Qdrant до сборщика метрик дела нет. Метки — закрытые наборы
 * операций и исходов; ни запросов, ни имён документов, ни идентификаторов
 * пользователей здесь не бывает.
 */

export type QdrantOperation = "search" | "upsert" | "delete" | "count" | "admin" | "health";

/**
 * Этапы: `embedding`, `rerank` — вызовы моделей; `search` — поиск целиком,
 * `vector` и `lexical` — его половины; `shadow` — теневое сравнение.
 */
export type KnowledgeTimedStage = "embedding" | "rerank" | "search" | "vector" | "lexical" | "shadow";

export type KnowledgeSearchMetricMode = "legacy" | "hybrid" | "vector" | "lexical";
export type KnowledgeSearchOutcome = "ok" | "empty" | "degraded" | "disabled";
export type KnowledgeShadowOutcome = "ok" | "empty" | "error" | "skipped";

interface Timing {
  count: number;
  errors: number;
  sum: number;
  max: number;
}

const QDRANT_OPERATIONS: readonly QdrantOperation[] = ["search", "upsert", "delete", "count", "admin", "health"];
const STAGES: readonly KnowledgeTimedStage[] = ["embedding", "rerank", "search", "vector", "lexical", "shadow"];
const SEARCH_MODES: readonly KnowledgeSearchMetricMode[] = ["legacy", "hybrid", "vector", "lexical"];
const SEARCH_OUTCOMES: readonly KnowledgeSearchOutcome[] = ["ok", "empty", "degraded", "disabled"];
const SHADOW_OUTCOMES: readonly KnowledgeShadowOutcome[] = ["ok", "empty", "error", "skipped"];

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

/** Поиски по режиму и исходу: 4 × 4 ряда, от людей и запросов не зависят. */
const searches = new Map<string, number>(
  SEARCH_MODES.flatMap((mode) => SEARCH_OUTCOMES.map((outcome) => [`${mode}:${outcome}`, 0] as [string, number])),
);
/** Теневые сравнения: исходы и сумма долей совпадения первых десяти. */
const shadow = {
  outcomes: new Map<KnowledgeShadowOutcome, number>(SHADOW_OUTCOMES.map((outcome) => [outcome, 0])),
  overlapSum: 0,
  overlapCount: 0,
};

export function recordKnowledgeSearch(mode: KnowledgeSearchMetricMode, outcome: KnowledgeSearchOutcome): void {
  const key = `${mode}:${outcome}`;
  if (searches.has(key)) searches.set(key, searches.get(key)! + 1);
}

export function recordKnowledgeShadow(outcome: KnowledgeShadowOutcome, overlap?: number): void {
  shadow.outcomes.set(outcome, shadow.outcomes.get(outcome)! + 1);
  if (overlap !== undefined && Number.isFinite(overlap)) {
    shadow.overlapSum += Math.max(0, Math.min(1, overlap));
    shadow.overlapCount += 1;
  }
}

export function knowledgeSearchMetrics(): {
  searches: Array<{ mode: string; outcome: string; value: number }>;
  shadow: { outcomes: Array<{ outcome: string; value: number }>; overlapSum: number; overlapCount: number };
} {
  return {
    searches: [...searches].map(([key, value]) => {
      const [mode, outcome] = key.split(":") as [string, string];
      return { mode, outcome, value };
    }),
    shadow: {
      outcomes: [...shadow.outcomes].map(([outcome, value]) => ({ outcome, value })),
      overlapSum: shadow.overlapSum,
      overlapCount: shadow.overlapCount,
    },
  };
}

export function recordQdrantCall(operation: QdrantOperation, ms: number, failed: boolean): void {
  add(qdrant.get(operation)!, ms, failed);
}

export function recordKnowledgeStage(stage: KnowledgeTimedStage, ms: number, failed: boolean): void {
  add(stages.get(stage)!, ms, failed);
}

/** Точек в коллекциях по области и версии — по последней сверке. */
const points = new Map<string, { scope: string; version: number; value: number }>();
/** Доля построенного индекса версии — по последней порции перестройки. */
const rebuild = new Map<number, number>();
/** Итоги сверок: что нашлось и что с этим сделано. */
const reconcile = { runs: 0, foreign: 0, scheduled: 0, orphans: 0, rebuilds: 0, files: 0 };

export function setKnowledgePoints(scope: "private" | "global", version: number, value: number): void {
  points.set(`${scope}:${version}`, { scope, version, value });
}

export function setKnowledgeRebuildProgress(version: number, ratio: number): void {
  rebuild.set(version, Math.max(0, Math.min(1, ratio)));
}

export function recordKnowledgeReconcile(report: { foreign: number; scheduled: number; orphans: number; rebuilds: number; files: number }): void {
  reconcile.runs += 1;
  reconcile.foreign += report.foreign;
  reconcile.scheduled += report.scheduled;
  reconcile.orphans += report.orphans;
  reconcile.rebuilds += report.rebuilds;
  reconcile.files += report.files;
}

export function knowledgeIndexMetrics(): {
  points: Array<{ scope: string; version: number; value: number }>;
  rebuild: Array<{ version: number; value: number }>;
  reconcile: typeof reconcile;
} {
  return {
    points: [...points.values()],
    rebuild: [...rebuild].map(([version, value]) => ({ version, value })),
    reconcile: { ...reconcile },
  };
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
  for (const key of searches.keys()) searches.set(key, 0);
  for (const outcome of shadow.outcomes.keys()) shadow.outcomes.set(outcome, 0);
  shadow.overlapSum = 0;
  shadow.overlapCount = 0;
  points.clear();
  rebuild.clear();
  Object.assign(reconcile, { runs: 0, foreign: 0, scheduled: 0, orphans: 0, rebuilds: 0, files: 0 });
}
