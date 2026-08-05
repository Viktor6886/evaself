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

/**
 * Рёбра, которыми ход можно **закрывать**, но нельзя двигать вперёд.
 *
 * Разница принципиальная. Довести до конца уже полученный результат —
 * это дописать то, что случилось. Пройти `claimed → context_building →
 * … → result_received` задним числом — это сочинить, будто ход собрал
 * контекст и получил ответ модели, когда он на самом деле оборвался.
 */
const CLOSING_PATH: ReadonlyArray<readonly [TurnState, TurnState]> = [
  ["outbox_committed", "delivering"],
  ["delivering", "delivered"],
  ["delivered", "completed"],
];

function buildGraph(
  edges: ReadonlyArray<readonly [TurnState, TurnState]>,
): Map<TurnState, ReadonlySet<TurnState>> {
  const graph = new Map<TurnState, Set<TurnState>>();
  for (const state of TURN_STATES) graph.set(state, new Set());
  for (const [from, to] of edges) graph.get(from)!.add(to);
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

const GRAPH = buildGraph([...HAPPY_PATH, ...RECOVERY_PATH]);

/**
 * Подграф, которым разрешено ходить восстановлению: возврат в работу,
 * обрыв, отмена и закрытие уже полученного результата. Движения вперёд
 * в нём нет — их совершает сам ход, а не тот, кто разбирает его следы.
 */
const CLOSING_GRAPH = buildGraph([...RECOVERY_PATH, ...CLOSING_PATH]);

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

/**
 * Кратчайший путь, не включая исходное состояние.
 *
 * Нужен там, где состояние на входе заранее неизвестно: восстановление
 * застаёт ход в любом из двадцати одного состояния, и путь, выписанный
 * руками под одно из них, для остальных оказывается набором отклонённых
 * переходов. Здесь путь строится по тому же графу, который его потом и
 * проверяет, поэтому разойтись им негде.
 *
 * `[]` — идти некуда, уже на месте. `null` — цели не достичь.
 */
function searchPath(
  graph: Map<TurnState, ReadonlySet<TurnState>>,
  from: TurnState,
  to: TurnState,
): TurnState[] | null {
  if (from === to) return [];
  const previous = new Map<TurnState, TurnState>();
  const seen = new Set<TurnState>([from]);
  const queue: TurnState[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const path: TurnState[] = [];
        for (let step: TurnState = to; step !== from; step = previous.get(step)!) {
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** Путь по полному графу хода. */
export function pathBetween(from: TurnState, to: TurnState): TurnState[] | null {
  return searchPath(GRAPH, from, to);
}

/**
 * Путь, которым разрешено ходить восстановлению.
 *
 * Отличается от `pathBetween` тем, что не умеет двигать ход вперёд.
 * Кратчайший путь по полному графу из `failed_retryable` в `completed`
 * проходит через `claimed → context_building → … → result_received` —
 * законный по рёбрам и полностью выдуманный по смыслу. Здесь такого
 * пути просто нет, и `null` честнее восьми сочинённых переходов.
 */
export function closingPath(from: TurnState, to: TurnState): TurnState[] | null {
  return searchPath(CLOSING_GRAPH, from, to);
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
