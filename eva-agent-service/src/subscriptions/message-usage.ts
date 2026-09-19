/**
 * Учёт сообщений пользователя в тарифных счётчиках.
 *
 * `usage_counters` остаётся единственным агрегатом квот. Отдельный ledger
 * здесь не создаётся: durable Telegram inbox уже содержит по одной
 * канонической строке на физическое сообщение и флаг `usage_charged`.
 * Мы используем этот флаг как идемпотентный маркер и в той же транзакции
 * увеличиваем сутки/неделю/месяц. Поэтому объединение нескольких быстрых
 * сообщений в один ход больше не превращает их в одну единицу тарифа.
 */

import type { Database } from "../db.js";

export interface InteractiveMessageUsage {
  charged: number;
  dailyUsed: number;
}

export async function countInteractiveUserMessages(
  db: Database,
  userId: number,
  updateIds: readonly number[],
): Promise<InteractiveMessageUsage> {
  const ids = [...new Set(updateIds.filter((id) => Number.isSafeInteger(id)))];
  if (ids.length === 0) return { charged: 0, dailyUsed: 0 };

  return await db.withUserScope(
    { userId, label: "subscriptions.message_usage.inbound", inherit: true },
    async () => await db.transaction(async (client) => {
      const claimed = await client.query<{ update_id: string }>(
        `UPDATE telegram_updates
            SET usage_charged = true
          WHERE user_id = $1
            AND update_id = ANY($2::bigint[])
            AND NOT usage_charged
          RETURNING update_id`,
        [userId, ids],
      );
      const charged = claimed.rowCount ?? claimed.rows.length;
      if (charged <= 0) {
        const current = await client.query<{ used: string }>(
          `SELECT used
             FROM usage_counters
            WHERE user_id = $1 AND metric = 'messages' AND period = 'day'
              AND period_start = (now() AT TIME ZONE 'UTC')::date`,
          [userId],
        );
        return { charged: 0, dailyUsed: Number(current.rows[0]?.used ?? 0) };
      }

      const { rows } = await client.query<{ period: string; used: string }>(
        `INSERT INTO usage_counters (user_id, metric, period, period_start, used)
         SELECT $1, 'messages', p.period, p.start, $2
           FROM (VALUES
             ('day', (now() AT TIME ZONE 'UTC')::date),
             ('week', date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date),
             ('month', date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date)
           ) AS p(period, start)
         ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
           SET used = usage_counters.used + EXCLUDED.used,
               updated_at = now()
         RETURNING period, used`,
        [userId, charged],
      );
      return {
        charged,
        dailyUsed: Number(rows.find((row) => row.period === "day")?.used ?? 0),
      };
    }),
  );
}
