/**
 * Обработчик очереди BullMQ поверх `JobRuntime.execute`.
 *
 * Все правила исполнения — сроки, аренда, DLQ, классификация отказов —
 * живут в `JobRuntime`. Здесь только перевод его исхода на язык BullMQ:
 * бросок — «повторить с отсрочкой», обычный возврат — «задание закрыто».
 * Постоянный отказ уже записан в DLQ, и повтор вернул бы тот же отказ.
 */

import type { JobProcessor } from "./queue-registry.js";
import type { JobRuntime } from "./runtime.js";

/** Сигнал BullMQ повторить задание. В тексте — только код отказа. */
export class JobRetryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JobRetryError";
  }
}

export function jobProcessor(
  runtime: Pick<JobRuntime, "execute">,
  rejected?: (data: unknown, code: string) => Promise<void>,
): JobProcessor {
  return async (data, attemptsMade) => {
    const outcome = await runtime.execute(data, attemptsMade + 1);
    // Дедлайн может закрыть задание до вызова бизнес-обработчика. Без
    // уведомления его запись оставалась queued навсегда. Отказ записи
    // бросается: BullMQ повторит уведомление вместо потери состояния.
    if (outcome.status === "failed" && !outcome.retry && outcome.runId === null) {
      await rejected?.(data, outcome.code);
    }
    if (outcome.status === "failed" && outcome.retry) throw new JobRetryError(outcome.code);
  };
}
