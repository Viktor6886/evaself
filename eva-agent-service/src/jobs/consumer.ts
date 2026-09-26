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

export function jobProcessor(runtime: Pick<JobRuntime, "execute">): JobProcessor {
  return async (data, attemptsMade) => {
    const outcome = await runtime.execute(data, attemptsMade + 1);
    if (outcome.status === "failed" && outcome.retry) throw new JobRetryError(outcome.code);
  };
}
