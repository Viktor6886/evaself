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
 * Записывает одну тарифицируемую единицу сообщения.
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
  return (await recordMessageUsageBatch(db, [input])) > 0;
}

/**
 * Атомарная запись нескольких сообщений одного пользователя.
 *
 * Нужна Telegram aggregation: один ход может содержать несколько быстрых
 * сообщений человека, и тариф обязан увидеть каждое. Один SQL не оставляет
 * половину окна списанной, если база отказала посередине учёта.
 */
export async function recordMessageUsageBatch(
  db: Database,
  inputs: MessageUsageInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const userId = inputs[0]!.userId;
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("userId для учёта расхода должен быть положительным целым");
  }
  const events = inputs.map((input) => {
    if (input.userId !== userId) {
      throw new Error("один batch расхода не может содержать разных пользователей");
    }
    const amount = Math.trunc(input.amount ?? 1);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("amount для учёта расхода должен быть положительным целым");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error("idempotencyKey для учёта расхода обязателен");
    return {
      user_id: input.userId,
      metric: input.metric,
      source: input.source.slice(0, 120),
      amount,
      correlation_id: input.correlationId?.slice(0, 300) ?? null,
      idempotency_key: idempotencyKey.slice(0, 500),
      metadata: input.metadata ?? {},
    };
  });

  const { rows } = await db.query<{ recorded: string | number }>(
    `-- tenant: by user_id — весь batch принадлежит одному явно проверенному пользователю
     WITH source AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS e(
           user_id bigint,
           metric text,
           source text,
           amount bigint,
           correlation_id text,
           idempotency_key text,
           metadata jsonb
         )
     ),
     inserted AS (
       INSERT INTO usage_events (
         user_id, metric, source, amount, unit,
         correlation_id, idempotency_key, metadata
       )
       SELECT user_id, metric, source, amount, 'message',
              correlation_id, idempotency_key, metadata
         FROM source
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING user_id, metric, amount
     ),
     counted AS (
       INSERT INTO usage_counters (user_id, metric, period, period_start, used)
       SELECT i.user_id, i.metric, p.period, p.period_start, SUM(i.amount)
         FROM inserted i
         CROSS JOIN LATERAL (VALUES
           ('day',   (now() AT TIME ZONE 'UTC')::date),
           ('week',  date_trunc('week',  (now() AT TIME ZONE 'UTC')::date)::date),
           ('month', date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date)
         ) AS p(period, period_start)
       GROUP BY i.user_id, i.metric, p.period, p.period_start
       ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
         SET used = usage_counters.used + EXCLUDED.used,
             updated_at = now()
       RETURNING 1
     )
     SELECT count(*)::text AS recorded FROM inserted`,
    [JSON.stringify(events)],
  );
  return Number(rows[0]?.recorded ?? 0);
}
