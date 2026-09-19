import type { Database } from "../db.js";

export type MessageUsageMetric = "messages" | "messages_out";

export interface MessageUsageInput {
  userId: number;
  metric: MessageUsageMetric;
  source: string;
  idempotencyKey: string;
  amount?: number;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Записывает одну тарифицируемую единицу сообщения и тем же SQL
 * увеличивает агрегаты day/week/month.
 *
 * Каноническая идемпотентность живёт в PostgreSQL: durable retry,
 * повторный запуск фоновой задачи и соседняя реплика могут вызвать
 * функцию повторно, но usage_counters изменится только при первом INSERT
 * в usage_events.
 */
export async function recordMessageUsage(
  db: Database,
  input: MessageUsageInput,
): Promise<boolean> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("userId для учёта расхода должен быть положительным целым");
  }
  const amount = Math.trunc(input.amount ?? 1);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("amount для учёта расхода должен быть положительным целым");
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("idempotencyKey для учёта расхода обязателен");

  const { rows } = await db.query<{ recorded: boolean }>(
    `-- tenant: by user_id — расход относится к одному явно указанному пользователю
     WITH inserted AS (
       INSERT INTO usage_events (
         user_id, metric, source, amount, unit,
         correlation_id, idempotency_key, metadata
       )
       VALUES ($1, $2, $3, $4, 'message', $5, $6, $7::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING user_id, metric, amount
     ),
     counted AS (
       INSERT INTO usage_counters (user_id, metric, period, period_start, used)
       SELECT i.user_id, i.metric, p.period, p.period_start, i.amount
         FROM inserted i
         CROSS JOIN LATERAL (VALUES
           ('day',   (now() AT TIME ZONE 'UTC')::date),
           ('week',  date_trunc('week',  (now() AT TIME ZONE 'UTC')::date)::date),
           ('month', date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date)
         ) AS p(period, period_start)
       ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
         SET used = usage_counters.used + EXCLUDED.used,
             updated_at = now()
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM inserted) AS recorded`,
    [
      input.userId,
      input.metric,
      input.source.slice(0, 120),
      amount,
      input.correlationId?.slice(0, 300) ?? null,
      idempotencyKey.slice(0, 500),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rows[0]?.recorded === true;
}
