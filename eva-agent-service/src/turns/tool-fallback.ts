export interface ToolFallbackOutcome {
  toolName: string;
  ok: boolean;
  created?: number;
  recordedAt: number;
}

/**
 * Последний подтверждённый исход изменяющего данные инструмента в текущем
 * пользовательском ходе.
 *
 * Инструменты Agent SDK выполняются из callback, чей AsyncLocalStorage не
 * обязан совпадать с контекстом Telegram-хода. Поэтому состояние адресуется
 * каноническим user_id, а не ambient-контекстом. UserTurnLock сериализует
 * ходы одного пользователя; начало следующего хода очищает запись.
 */
const outcomes = new Map<number, ToolFallbackOutcome>();
const OUTCOME_TTL_MS = 2 * 60_000;

export function resetToolFallback(userId: number): void {
  outcomes.delete(userId);
}

export function recordToolFallback(
  userId: number,
  toolName: string,
  result: unknown,
): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;

  const value = result && typeof result === "object"
    ? result as Record<string, unknown>
    : null;
  const ok = value?.ok;
  if (typeof ok !== "boolean") return;

  const created = typeof value?.created === "number" && Number.isSafeInteger(value.created)
    ? value.created
    : undefined;
  outcomes.set(userId, {
    toolName,
    ok,
    ...(created === undefined ? {} : { created }),
    recordedAt: Date.now(),
  });
}

export function takeToolFallback(userId: number): ToolFallbackOutcome | null {
  const outcome = outcomes.get(userId) ?? null;
  outcomes.delete(userId);
  if (!outcome) return null;
  if (Date.now() - outcome.recordedAt > OUTCOME_TTL_MS) return null;
  return outcome;
}
