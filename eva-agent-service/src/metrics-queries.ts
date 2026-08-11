/**
 * Запросы метрик, добавленные шагом 09.
 *
 * Вынесены из `metrics.ts` тем же шагом, который их принёс: файл
 * перешагнул шестьсот строк, а перечитывается он целиком каждой
 * сессией, которая трогает наблюдаемость. Рендер остался там, чтение
 * базы — здесь.
 *
 * Общее правило у всех трёх: пользовательских данных в выдаче нет по
 * построению — только счётчики, длительности и метки низкой
 * кардинальности (модель, класс, состояние). Отказ запроса не роняет
 * сбор: метрики нужны в том числе тогда, когда что-то сломалось.
 */

import type { Database } from "./db.js";

function number(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Состояние фоновых заданий.
 *
 * Три числа отвечают на три разных вопроса: «намерения копятся»
 * (публикатор встал или брокер лежит), «задания зависли» (исполнитель
 * пропал, аренда истекла) и «задания хоронятся» (что-то системно не
 * выполняется). Слить их в одно значение нельзя — лечатся они
 * по-разному.
 */
export async function jobStats(db: Database): Promise<{
  outboxPending: number;
  outboxOldestSeconds: number;
  running: number;
  stuck: number;
  deadLetters: number;
}> {
  const empty = {
    outboxPending: 0,
    outboxOldestSeconds: 0,
    running: 0,
    stuck: 0,
    deadLetters: 0,
  };
  try {
    return await db.withSystemScope(
      "metrics.jobs",
      async () => {
        const { rows } = await db.query(
          `-- tenant: system — счётчики заданий по всем пользователям,
           -- ни одной строки данных наружу
           SELECT
             (SELECT count(*) FROM job_outbox
               WHERE status IN ('pending', 'publishing')) AS outbox_pending,
             (SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(available_at)), 0)
                FROM job_outbox WHERE status IN ('pending', 'publishing')) AS outbox_age,
             (SELECT count(*) FROM job_runs WHERE status = 'running') AS running,
             (SELECT count(*) FROM job_runs
               WHERE status = 'running'
                 AND lease_until IS NOT NULL
                 AND lease_until < now()) AS stuck,
             (SELECT count(*) FROM job_dead_letters
               WHERE created_at > now() - interval '1 day') AS dead_letters`,
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return empty;
        return {
          outboxPending: number(row.outbox_pending),
          outboxOldestSeconds: number(row.outbox_age),
          running: number(row.running),
          stuck: number(row.stuck),
          deadLetters: number(row.dead_letters),
        };
      },
      { crossUser: true },
    );
  } catch {
    return empty;
  }
}

/**
 * Нагрузка на провайдеров и состояние предохранителей.
 *
 * Метки — только модель и провайдер: их десятки, и это осознанный
 * потолок кардинальности. Идентификатора пользователя, conversation и
 * маршрута с параметрами здесь нет (требование 5 шага 9): каждая
 * такая метка умножает число временных рядов на число людей.
 */
export async function providerStats(db: Database): Promise<{
  rpm: Array<{ labels: Record<string, string>; value: number }>;
  tpm: Array<{ labels: Record<string, string>; value: number }>;
  inflight: Array<{ labels: Record<string, string>; value: number }>;
  breaker: Array<{ labels: Record<string, string>; value: number }>;
}> {
  const empty = { rpm: [], tpm: [], inflight: [], breaker: [] };
  try {
    return await db.withSystemScope(
      "metrics.providers",
      async () => {
        const usage = await db.query(
          `-- tenant: system — агрегат по всем запросам к моделям,
           -- пользовательских данных в выдаче нет
           SELECT COALESCE(model, 'unknown') AS model,
                  count(*) AS requests,
                  COALESCE(sum(tokens_in + tokens_out), 0) AS tokens,
                  count(*) FILTER (WHERE finished_at IS NULL) AS inflight
             FROM llm_requests
            WHERE started_at > now() - interval '1 minute'
            GROUP BY 1
            ORDER BY 1
            LIMIT 50`,
        );
        const breaker = await db.query(
          `SELECT model, state FROM llm_breaker_model_state ORDER BY model LIMIT 50`,
        );
        const stateValue = (state: unknown): number =>
          state === "open" ? 2 : state === "half_open" ? 1 : 0;
        return {
          rpm: usage.rows.map((row) => ({
            labels: { model: String((row as Record<string, unknown>).model) },
            value: number((row as Record<string, unknown>).requests),
          })),
          tpm: usage.rows.map((row) => ({
            labels: { model: String((row as Record<string, unknown>).model) },
            value: number((row as Record<string, unknown>).tokens),
          })),
          inflight: usage.rows.map((row) => ({
            labels: { model: String((row as Record<string, unknown>).model) },
            value: number((row as Record<string, unknown>).inflight),
          })),
          breaker: breaker.rows.map((row) => ({
            labels: { model: String((row as Record<string, unknown>).model) },
            value: stateValue((row as Record<string, unknown>).state),
          })),
        };
      },
      { crossUser: true },
    );
  } catch {
    return empty;
  }
}

/**
 * Доставка Telegram: сколько раз нас притормозили и как долго идёт
 * сообщение от постановки в очередь до отправки.
 */
export async function deliveryStats(db: Database): Promise<{
  rateLimited: number;
  latencyAvg: number;
  latencyMax: number;
}> {
  const empty = { rateLimited: 0, latencyAvg: 0, latencyMax: 0 };
  try {
    return await db.withSystemScope(
      "metrics.delivery",
      async () => {
        const { rows } = await db.query(
          `-- tenant: system — агрегат доставки по всем чатам,
           -- ни текста, ни идентификаторов наружу
           SELECT
             count(*) FILTER (
               WHERE last_error IS NOT NULL AND last_error LIKE '%429%'
             ) AS rate_limited,
             COALESCE(AVG(EXTRACT(EPOCH FROM sent_at - created_at)) * 1000, 0) AS latency_avg,
             COALESCE(MAX(EXTRACT(EPOCH FROM sent_at - created_at)) * 1000, 0) AS latency_max
             FROM telegram_outbox
            WHERE created_at > now() - interval '1 hour'`,
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) return empty;
        return {
          rateLimited: number(row.rate_limited),
          latencyAvg: number(row.latency_avg),
          latencyMax: number(row.latency_max),
        };
      },
      { crossUser: true },
    );
  } catch {
    return empty;
  }
}
