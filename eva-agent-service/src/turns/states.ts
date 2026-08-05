/**
 * Канонические состояния хода и допустимые переходы между ними.
 *
 * Список состояний взят из `CLAUDE.md` дословно и синонимов не имеет.
 * Здесь он один раз превращается в граф: переход, которого в графе нет,
 * отклоняется кодом, а не «замечается на ревью».
 *
 * Граф намеренно нестрогий в одном месте: из любого незавершённого
 * состояния можно уйти в отмену и в отказ. Ход обрывается тем, что
 * произошло снаружи — перезапуском, отменой пользователя, недоступным
 * App Server, — и запрещать эти переходы значило бы запрещать правду.
 */

export const TURN_STATES = [
  "accepted",
  "aggregating",
  "queued",
  "claimed",
  "context_building",
  "context_built",
  "sent_to_letta",
  "letta_processing",
  "tools_pending",
  "approval_pending",
  "result_received",
  "outbox_committed",
  "delivering",
  "delivered",
  "completed",
  "cancelling",
  "cancelled",
  "failed_retryable",
  "recovery_required",
  "recovering",
  "failed_terminal",
] as const;

export type TurnState = (typeof TURN_STATES)[number];

/** Состояния, после которых ход закончен и продолжения не имеет. */
export const TERMINAL_STATES: ReadonlySet<TurnState> = new Set<TurnState>([
  "completed",
  "cancelled",
  "failed_terminal",
]);

/** Прямой путь хода. Ветвления описаны отдельно ниже. */
const HAPPY_PATH: ReadonlyArray<readonly [TurnState, TurnState]> = [
  ["accepted", "aggregating"],
  ["accepted", "queued"],
  ["aggregating", "queued"],
  ["queued", "claimed"],
  ["claimed", "context_building"],
  ["context_building", "context_built"],
  ["context_built", "sent_to_letta"],
  ["sent_to_letta", "letta_processing"],
  ["letta_processing", "tools_pending"],
  ["letta_processing", "result_received"],
  ["tools_pending", "letta_processing"],
  ["tools_pending", "approval_pending"],
  ["approval_pending", "tools_pending"],
  ["approval_pending", "letta_processing"],
  ["result_received", "outbox_committed"],
  ["result_received", "completed"],
  ["outbox_committed", "delivering"],
  ["delivering", "delivered"],
  ["delivered", "completed"],
];

/** Возврат в работу после сбоя или перезапуска. */
const RECOVERY_PATH: ReadonlyArray<readonly [TurnState, TurnState]> = [
  ["failed_retryable", "queued"],
  ["failed_retryable", "recovery_required"],
  ["failed_retryable", "failed_terminal"],
  ["recovery_required", "recovering"],
  ["recovering", "queued"],
  ["recovering", "claimed"],
  ["recovering", "failed_terminal"],
  ["cancelling", "cancelled"],
];

function buildGraph(): Map<TurnState, ReadonlySet<TurnState>> {
  const graph = new Map<TurnState, Set<TurnState>>();
  for (const state of TURN_STATES) graph.set(state, new Set());
  for (const [from, to] of [...HAPPY_PATH, ...RECOVERY_PATH]) {
    graph.get(from)!.add(to);
  }
  // Отмена и отказ достижимы из любого незавершённого состояния: ход
  // может оборваться снаружи в любой момент.
  for (const state of TURN_STATES) {
    if (TERMINAL_STATES.has(state)) continue;
    if (state !== "cancelling") graph.get(state)!.add("cancelling");
    graph.get(state)!.add("failed_retryable");
    graph.get(state)!.add("failed_terminal");
  }
  return graph as Map<TurnState, ReadonlySet<TurnState>>;
}

const GRAPH = buildGraph();

export function isTurnState(value: string): value is TurnState {
  return (TURN_STATES as readonly string[]).includes(value);
}

/** Допустим ли переход. Начало хода — это переход из `null`. */
export function canTransition(from: TurnState | null, to: TurnState): boolean {
  if (from === null) return to === "accepted";
  if (from === to) return false;
  return GRAPH.get(from)?.has(to) === true;
}

export function nextStates(from: TurnState): ReadonlySet<TurnState> {
  return GRAPH.get(from) ?? new Set<TurnState>();
}

export class InvalidTurnTransitionError extends Error {
  readonly code = "invalid_turn_transition";
  constructor(
    readonly from: TurnState | null,
    readonly to: string,
  ) {
    super(`Недопустимый переход хода: ${from ?? "нет состояния"} → ${to}`);
    this.name = "InvalidTurnTransitionError";
  }
}
