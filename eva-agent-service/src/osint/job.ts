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
import { recordOsint } from "./metrics.js";
import { OsintOrchestrator, type InvestigationSummary } from "./orchestrator.js";
import { PgOsintStore, type Queryable } from "./repository.js";

/**
 * Сроки задания. Бюджет исследования — 15 минут работы; мягкий срок
 * задания чуть больше, чтобы оркестратор успел остановиться сам на
 * границе шага, а не был оборван посреди записи. Самый длинный внешний
 * запрос — скан SpiderFoot (до 4,5 минуты с запасом на ответ) —
 * укладывается в `externalRequestTimeoutMs`.
 */
export const OSINT_JOB_TIMING: Partial<JobTimingPolicy> = {
  softTimeoutMs: 20 * 60_000,
  hardDeadlineMs: 25 * 60_000,
  externalRequestTimeoutMs: 280_000,
  leaseDurationMs: 120_000,
  leaseRenewIntervalMs: 30_000,
  maxAttempts: 2,
  backoffMs: 30_000,
};

export interface OsintJobDatabase extends Queryable {
  withUserScope<T>(input: { userId: number; label: string; inherit?: boolean }, work: () => Promise<T>): Promise<T>;
}

/**
 * Текст уведомления о завершении. Только счётчики: ни имени, ни
 * идентификаторов, ни адресов — сообщение уходит в Telegram и хранится в
 * outbox, а подробности человек получает у Евы по запросу.
 */
export function completionText(summary: InvestigationSummary): string {
  return [
    "OSINT-исследование завершено.",
    `Источников: ${summary.sources}, найденных аккаунтов: ${summary.accounts}, новых следов: ${summary.discovered}.`,
    summary.degradedRuns + summary.failedRuns > 0
      ? `Часть источников не ответила (${summary.degradedRuns + summary.failedRuns}) — это отмечено в отчёте.`
      : null,
    "Попросите Еву показать отчёт — она расскажет, что найдено и насколько это надёжно.",
  ].filter(Boolean).join("\n");
}

export class OsintJobWorker {
  constructor(
    private readonly db: OsintJobDatabase,
    private readonly collectors: readonly Collector[],
  ) {}

  /** Уведомление через durable outbox Telegram; повтор задания второго не создаёт. */
  private async notify(userId: number, investigationId: string, summary: InvestigationSummary): Promise<void> {
    const { rows: [user] } = await this.db.query<{ telegram_id: string | number }>(
      `SELECT telegram_id FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) return;
    const chatId = Number(user.telegram_id);
    await this.db.query(
      `INSERT INTO telegram_outbox (idempotency_key, user_id, chat_id, telegram_method, payload, priority)
       VALUES ($1, $2, $3, 'sendMessage', $4::jsonb, 0)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [`osint-done:${investigationId}`, userId, chatId, JSON.stringify({ chat_id: chatId, text: completionText(summary) })],
    );
  }

  async run(context: JobContext): Promise<void> {
    const investigationId = context.envelope.payloadRef;
    const userId = context.envelope.userId;
    if (!investigationId || userId === null) throw new Error("osint_job_invalid");
    await this.db.withUserScope({ userId, label: "osint.run" }, async () => {
      const store = new PgOsintStore(this.db, userId, investigationId);
      try {
        const summary = await new OsintOrchestrator(store, this.collectors, {
          onRun: (collector, status, requests) => {
            recordOsint("run", collector, status);
            recordOsint("requests", collector, requests);
          },
        }).run(context.signal);
        if (summary.status === "completed") {
          recordOsint("investigation", "completed");
          await this.notify(userId, investigationId, summary);
        } else if (summary.status === "cancelled") {
          recordOsint("investigation", "cancelled");
        }
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
          recordOsint("investigation", "failed");
        }
        throw error;
      }
    });
  }
}
