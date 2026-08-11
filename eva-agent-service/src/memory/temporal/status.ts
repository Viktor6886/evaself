/**
 * Статусы temporal-памяти и уровни доверия к источнику.
 *
 * Словарь закрыт и живёт в одном месте по той же причине, что и
 * состояния хода: синоним статуса — это молчаливая развилка в логике,
 * а не удобство. Прежние статусы графа (`unconfirmed`, `disputed`,
 * `archived`) продолжают существовать в схеме ради старого кода, но в
 * temporal-путь не входят: у него собственный список.
 */

export const TEMPORAL_STATUSES = [
  "candidate",
  "active",
  "superseded",
  "refuted",
  "rejected",
  "forgotten",
  "deleted",
  "quarantined",
] as const;

export type TemporalStatus = (typeof TEMPORAL_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(TEMPORAL_STATUSES);

export function isTemporalStatus(value: unknown): value is TemporalStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/** Статусы, при которых факт участвует в текущем снимке памяти. */
export const LIVE_STATUSES: readonly TemporalStatus[] = ["active", "candidate"];

/**
 * Статусы, из которых версия больше не выходит. Забытый и удалённый
 * разделены намеренно: «забыт» — решение системы хранения, «удалён» —
 * решение человека, и путать их в отчёте нельзя.
 */
const TERMINAL: ReadonlySet<TemporalStatus> = new Set<TemporalStatus>([
  "rejected",
  "forgotten",
  "deleted",
]);

const TRANSITIONS: Readonly<Record<TemporalStatus, readonly TemporalStatus[]>> = {
  // Кандидат тоже замещается: человек, исправивший непроверенный факт,
  // не должен натыкаться на запрет перехода — прежняя догадка обязана
  // остаться в истории ровно так же, как замещённый факт.
  candidate: ["active", "rejected", "quarantined", "deleted", "refuted", "superseded"],
  active: ["superseded", "refuted", "forgotten", "deleted", "quarantined"],
  superseded: ["deleted", "forgotten"],
  refuted: ["active", "deleted", "forgotten"],
  quarantined: ["active", "rejected", "deleted"],
  rejected: ["deleted"],
  forgotten: ["deleted"],
  deleted: [],
};

export function canTransition(from: TemporalStatus, to: TemporalStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TemporalStatus): boolean {
  return TERMINAL.has(status);
}

export class MemoryStatusError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "MemoryStatusError";
  }
}

export function assertTransition(from: TemporalStatus, to: TemporalStatus): void {
  if (!canTransition(from, to)) {
    throw new MemoryStatusError("memory_status_transition_forbidden", `${from} → ${to}`);
  }
}

/**
 * Насколько источник заслуживает доверия.
 *
 * Прямое утверждение человека и вывод модели НЕ равны (требование 4
 * шага 15). Число — множитель уверенности, а не сама уверенность:
 * модель может быть уверена в своей догадке, но догадка от этого не
 * становится словами пользователя.
 */
const SOURCE_TRUST: Readonly<Record<string, number>> = {
  user_statement: 1,
  user_confirmation: 1,
  profile: 0.95,
  goal: 0.9,
  goal_result: 0.9,
  task: 0.9,
  work_block: 0.85,
  goal_review: 0.85,
  import: 0.8,
  conversation: 0.75,
  highlight: 0.6,
  model_inference: 0.5,
  curator: 0.5,
};

/** Неизвестный источник получает самый низкий множитель, а не средний. */
export const UNKNOWN_SOURCE_TRUST = 0.4;

export function sourceTrust(sourceType: string): number {
  return SOURCE_TRUST[sourceType] ?? UNKNOWN_SOURCE_TRUST;
}

/** Источники, чей вывод сам по себе фактом не становится. */
export function isInference(sourceType: string): boolean {
  return sourceTrust(sourceType) <= 0.5;
}
