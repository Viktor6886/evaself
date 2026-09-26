/**
 * Задание `osint_investigation`: один заход оркестратора по исследованию.
 *
 * Задание идёт в очереди `research` — это фоновая работа, а не ход
 * агента, и Telegram ingress её не касается. Всё состояние в PostgreSQL,
 * поэтому повтор после сбоя продолжает с того места, где остановился
 * прошлый заход.
 *
 * В журнал уходят только id и счётчики: ни запроса, ни идентификаторов,
 * ни адресов найденных профилей.
 */

import type { JobContext } from "../jobs/runtime.js";
import type { JobTimingPolicy } from "../jobs/policy.js";
import type { Collector } from "./collectors.js";
import { OsintOrchestrator } from "./orchestrator.js";
import { PgOsintStore, type Queryable } from "./repository.js";

/**
 * Сроки задания. Бюджет исследования — 15 минут работы; мягкий срок
 * задания чуть больше, чтобы оркестратор успел остановиться сам на
 * границе шага, а не был оборван посреди записи. Скан Maigret — самый
 * длинный внешний запрос — укладывается в `externalRequestTimeoutMs`.
 */
export const OSINT_JOB_TIMING: Partial<JobTimingPolicy> = {
  softTimeoutMs: 20 * 60_000,
  hardDeadlineMs: 25 * 60_000,
  externalRequestTimeoutMs: 210_000,
  leaseDurationMs: 120_000,
  leaseRenewIntervalMs: 30_000,
  maxAttempts: 2,
  backoffMs: 30_000,
};

export interface OsintJobDatabase extends Queryable {
  withUserScope<T>(input: { userId: number; label: string; inherit?: boolean }, work: () => Promise<T>): Promise<T>;
}

export class OsintJobWorker {
  constructor(
    private readonly db: OsintJobDatabase,
    private readonly collectors: readonly Collector[],
  ) {}

  async run(context: JobContext): Promise<void> {
    const investigationId = context.envelope.payloadRef;
    const userId = context.envelope.userId;
    if (!investigationId || userId === null) throw new Error("osint_job_invalid");
    await this.db.withUserScope({ userId, label: "osint.run" }, async () => {
      const store = new PgOsintStore(this.db, userId, investigationId);
      try {
        const summary = await new OsintOrchestrator(store, this.collectors).run(context.signal);
        context.logger.info("OSINT-исследование: заход завершён", {
          investigationId,
          status: summary.status,
          stoppedBy: summary.stoppedBy,
          processed: summary.processed,
          runs: summary.runs,
          sources: summary.sources,
          accounts: summary.accounts,
          discovered: summary.discovered,
          externalRequests: summary.externalRequests,
          degradedRuns: summary.degradedRuns,
          failedRuns: summary.failedRuns,
        });
      } catch (error) {
        // Отменённое человеком исследование — не сбой: повторять нечего.
        if (await store.isCancelled().catch(() => false)) return;
        // Последняя попытка: исследование не должно навсегда остаться
        // «в работе». Остальные попытки продолжат с того же места.
        if (context.attempt >= context.timing.maxAttempts) {
          await store.complete("failed", "osint_run_failed").catch(() => undefined);
        }
        throw error;
      }
    });
  }
}
