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

import { PRIORITY_VALUE } from "../delivery/priority.js";
import type { JobContext } from "../jobs/runtime.js";
import type { JobTimingPolicy } from "../jobs/policy.js";
import type { Collector } from "./collectors.js";
import { recordOsint } from "./metrics.js";
import type { OsintNarrator } from "./narrator.js";
import { OsintOrchestrator } from "./orchestrator.js";
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
export interface CompletionCounts {
  sources: number;
  accounts: number;
  discovered: number;
  degradedRuns: number;
  failedRuns: number;
}

export function completionText(summary: CompletionCounts): string {
  return [
    "OSINT-исследование завершено.",
    `Источников: ${summary.sources}, найденных аккаунтов: ${summary.accounts}, новых следов: ${summary.discovered}.`,
    summary.degradedRuns + summary.failedRuns > 0
      ? `Часть источников не ответила (${summary.degradedRuns + summary.failedRuns}) — это отмечено в отчёте.`
      : null,
    "Попросите Еву показать отчёт — она расскажет, что найдено и насколько это надёжно.",
  ].filter(Boolean).join("\n");
}

/** Флаги панели, которые включают отдельные сборщики. */
export interface OsintCollectorFlags {
  osintRuRegistriesEnabled: boolean;
  osintCollectorMaigret: boolean;
  osintCollectorWeb: boolean;
  osintCollectorInfrastructure: boolean;
  osintCollectorHarvester: boolean;
  osintCollectorSpiderfoot: boolean;
}

/** Включён ли сборщик. Неизвестное имя — включено: новый сборщик не должен молча пропадать. */
export function osintCollectorEnabled(flags: OsintCollectorFlags, name: string): boolean {
  switch (name) {
    case "egrul": return flags.osintRuRegistriesEnabled;
    case "maigret": return flags.osintCollectorMaigret;
    case "web_search": return flags.osintCollectorWeb;
    case "infrastructure": return flags.osintCollectorInfrastructure;
    case "theharvester": return flags.osintCollectorHarvester;
    case "spiderfoot": return flags.osintCollectorSpiderfoot;
    default: return true;
  }
}

/**
 * Как итог доходит до человека, когда рядом есть Letta и клиент Telegram:
 * пересказ Евы и отправка через тот же путь, что у её ответов (разметка,
 * деление длинного текста, durable outbox).
 */
export interface OsintAnnouncer {
  narrator: OsintNarrator;
  send(chatId: number, text: string, deliveryKey: string): Promise<void>;
}

export class OsintJobWorker {
  constructor(
    private readonly db: OsintJobDatabase,
    private readonly collectors: readonly Collector[],
    private readonly flags: {
      enabled: () => boolean;
      collectorEnabled: (name: string) => boolean;
    } = { enabled: () => true, collectorEnabled: () => true },
    private readonly announcer: OsintAnnouncer | null = null,
  ) {}

  /**
   * Уведомление через durable outbox Telegram; повтор задания второго не
   * создаёт. Счётчики берутся из сохранённого графа, а не из итога захода:
   * заход после сбоя пропускает уже сделанные прогоны, и его итог сказал
   * бы «ничего не найдено» о том, что нашёл первый.
   */
  private async notify(userId: number, investigationId: string, context: JobContext): Promise<void> {
    const { rows: [user] } = await this.db.query<{ telegram_id: string | number }>(
      `SELECT telegram_id FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) return;
    const { rows: [counts] } = await this.db.query<CompletionCounts>(
      `SELECT
         (SELECT count(*)::int FROM osint_sources
           WHERE investigation_id = $1 AND user_id = $2 AND collector <> 'seed') AS sources,
         (SELECT count(*)::int FROM osint_investigation_entities ie
            JOIN osint_entities e ON e.id = ie.entity_id AND e.user_id = ie.user_id
           WHERE ie.investigation_id = $1 AND ie.user_id = $2 AND e.schema = 'UserAccount') AS accounts,
         (SELECT count(*)::int FROM osint_frontier
           WHERE investigation_id = $1 AND user_id = $2 AND depth > 0) AS discovered,
         (SELECT count(*)::int FROM osint_collector_runs
           WHERE investigation_id = $1 AND user_id = $2 AND status = 'degraded') AS "degradedRuns",
         (SELECT count(*)::int FROM osint_collector_runs
           WHERE investigation_id = $1 AND user_id = $2 AND status = 'failed') AS "failedRuns"`,
      [investigationId, userId],
    );
    const chatId = Number(user.telegram_id);
    const deliveryKey = `osint-done:${investigationId}`;
    if (this.announcer) {
      // Повтор задания после отправленного итога второго хода не
      // запускает: ход Letta стоит денег и написал бы человеку дважды.
      // Поиск по чату, а не по user_id: ответы Евы (и этот пересказ)
      // пишутся в outbox без владельца, и проверка по user_id не видела бы
      // уже поставленное сообщение.
      const { rows: sent } = await this.db.query(
        `-- tenant: by chat_id — чат владельца исследования; строки ответов Евы пишутся без user_id
         SELECT 1 FROM telegram_outbox WHERE chat_id = $1 AND idempotency_key LIKE $2 LIMIT 1`,
        [chatId, `${deliveryKey}%`],
      );
      if (sent.length > 0) return;
      let text: string | null = null;
      try {
        text = await this.announcer.narrator.narrate({ userId, investigationId, signal: context.signal });
      } catch (error) {
        // Пересказ не удался — человек всё равно узнаёт, что готово:
        // шаблон со счётчиками, а отчёт Ева покажет по просьбе.
        context.logger.warn("OSINT-исследование: пересказ Евы не удался", {
          investigationId,
          code: error instanceof Error ? error.name : "unknown_error",
        });
      }
      await this.announcer.send(chatId, text ?? completionText(counts!), deliveryKey);
      return;
    }
    await this.db.query(
      `INSERT INTO telegram_outbox (idempotency_key, user_id, chat_id, telegram_method, payload, priority)
       VALUES ($1, $2, $3, 'sendMessage', $4::jsonb, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      // Сообщение человеку о фоновой работе — как напоминание: после ответов
      // и команд, но не служебная отметка, которую можно опоздать отправить.
      [`osint-done:${investigationId}`, userId, chatId, JSON.stringify({ chat_id: chatId, text: completionText(counts!) }),
        PRIORITY_VALUE.reminder],
    );
  }

  async run(context: JobContext): Promise<void> {
    const investigationId = context.envelope.payloadRef;
    const userId = context.envelope.userId;
    if (!investigationId || userId === null) throw new Error("osint_job_invalid");
    await this.db.withUserScope({ userId, label: "osint.run" }, async () => {
      const store = new PgOsintStore(this.db, userId, investigationId);
      // Контур выключили в панели после постановки задания: исследование
      // закрывается с причиной, а не выполняется вопреки выключателю и не
      // висит «в работе».
      if (!this.flags.enabled()) {
        await store.complete("cancelled", "osint_disabled");
        recordOsint("investigation", "cancelled");
        return;
      }
      const collectors = this.collectors.filter((collector) => this.flags.collectorEnabled(collector.name));
      let completed = false;
      try {
        const summary = await new OsintOrchestrator(store, collectors, {
          onRun: (collector, status, requests) => {
            recordOsint("run", collector, status);
            recordOsint("requests", collector, requests);
          },
        }).run(context.signal);
        if (summary.status === "completed") {
          recordOsint("investigation", "completed");
          completed = true;
        } else if (summary.status === "not_runnable") {
          // Повтор после сбоя уведомления: исследование уже завершено, а
          // сообщения о нём может не быть. Ключ outbox не даст второго.
          completed = await store.status() === "completed";
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
      // Вне перехвата выше: сбой постановки уведомления — повод повторить
      // задание, а не «отменённое исследование», каким его счёл бы
      // перехват по статусу, уже не равному processing.
      if (completed) await this.notify(userId, investigationId, context);
    });
  }
}
