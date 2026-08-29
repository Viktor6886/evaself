/**
 * Как оплата становится правом доступа.
 *
 * Раньше это знал только вебхук Lava — единственный в тот момент способ
 * заплатить. Со звёздами Telegram способов стало два, и переписать те же
 * четыре запроса во втором месте значило бы завести вторую правду о том,
 * что происходит после оплаты: одна из них рано или поздно отстала бы, а
 * разошлись бы они молча — на живых деньгах.
 *
 * Поведение прежнее, слово в слово. Меняются только имена провайдера и
 * валюты, которые раньше были написаны в запросах строками.
 *
 * Идемпотентность держит уникальная пара `(provider, provider_payment_id)`:
 * повторное событие не создаёт ни второго платежа, ни второй подписки.
 * Продление считается от конца прежнего срока, а не от «сейчас», — иначе
 * оплата за неделю до конца съедала бы остаток.
 */

import type pg from "pg";

import { paidPlanLevel } from "./plans.js";

export interface PaidPlan {
  plan: string;
  amountMinor: number;
  durationDays: number;
  currency: string;
}

export interface PaymentFacts {
  /** Кто платит — внутренний идентификатор. */
  userId: string;
  /** Имя провайдера в `payments.provider`. */
  provider: string;
  /** Идентификатор платежа у провайдера: он же ключ идемпотентности. */
  paymentId: string;
  /**
   * Идентификатор подписки у провайдера, если он есть. Нет — берётся
   * идентификатор платежа: у разовой оплаты подписки как сущности нет.
   */
  contractId?: string | null;
  /** Внутренний payment_intent, если провайдер возвращает его в событии. */
  intentId?: string | null;
  /** Сырое событие для разбора спорных случаев. Секретов в нём быть не должно. */
  raw: Record<string, unknown>;
}

export type GrantOutcome = "applied" | "duplicate";

/**
 * Записать платёж и продлить подписку.
 *
 * Вызывается внутри транзакции и в области владельца: проверка
 * принадлежности пользователя — на стороне вызывающего, здесь только
 * запись.
 */
export async function grantPaidAccess(
  client: pg.PoolClient,
  facts: PaymentFacts,
  plan: PaidPlan,
): Promise<GrantOutcome> {
  const payment = await client.query<{ id: string }>(
    `INSERT INTO payments
       (user_id, provider, provider_payment_id, amount_minor, currency,
        status, description, paid_at, raw)
     VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, now(), $7::jsonb)
     ON CONFLICT (provider, provider_payment_id)
       WHERE provider_payment_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      facts.userId,
      facts.provider,
      facts.paymentId,
      plan.amountMinor,
      plan.currency,
      `План ${plan.plan}`,
      JSON.stringify(facts.raw),
    ],
  );
  if (!payment.rows[0]) return "duplicate";

  const previous = await client.query<{
    id: string;
    plan: string;
    status: string;
    current_period_end: Date | null;
  }>(
    `SELECT id, plan, status, current_period_end
       FROM subscriptions
      WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')
        AND (current_period_end IS NULL OR current_period_end > now())
      ORDER BY current_period_end DESC NULLS FIRST, created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [facts.userId],
  );
  const previousSubscription = previous.rows[0];
  const previousDays = remainingDays(previousSubscription?.current_period_end ?? null);
  const previousIndefinite = Boolean(previousSubscription && !previousSubscription.current_period_end);
  const previousLevel = previousSubscription ? paidPlanLevel(previousSubscription.plan) : null;
  const targetLevel = paidPlanLevel(plan.plan);
  // После списания понизить доступ нельзя. Штатный путь Stars отсекает
  // downgrade до списания; этот fail-safe нужен для внешнего провайдера
  // или гонки с ручным изменением подписки.
  const effectivePlan = previousSubscription
      && previousLevel !== null
      && targetLevel !== null
      && previousLevel > targetLevel
    ? previousSubscription.plan
    : plan.plan;
  const blended = previousSubscription && !previousIndefinite && previousDays > 0
    ? await blendQuotaLimits(
      client,
      facts.userId,
      previousSubscription,
      plan.plan,
      previousDays,
      plan.durationDays,
    )
    : [];
  await client.query(
    `UPDATE subscriptions SET status = 'expired'
      WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')`,
    [facts.userId],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO subscriptions
       (user_id, plan, status, provider, provider_subscription_id,
        current_period_start, current_period_end)
     VALUES (
       $1, $2, 'active', $6, $3, now(),
       CASE
         WHEN $7::boolean THEN NULL
         ELSE GREATEST(now(), COALESCE($5::timestamptz, now()))
              + make_interval(days => $4)
       END
     )
     RETURNING id`,
    [
      facts.userId,
      effectivePlan,
      facts.contractId ?? facts.paymentId,
      plan.durationDays,
      previousSubscription?.current_period_end?.toISOString() ?? null,
      facts.provider,
      previousIndefinite,
    ],
  );
  const subscriptionId = inserted.rows[0]!.id;
  for (const quota of blended) {
    await client.query(
      `INSERT INTO subscription_quota_limits
         (subscription_id, user_id, metric, period, limit_value)
       VALUES ($1, $2, $3, $4, $5)`,
      [subscriptionId, facts.userId, quota.metric, quota.period, quota.limitValue],
    );
  }
  await client.query(
    `UPDATE payments SET subscription_id = $2, updated_at = now()
      WHERE id = $1 AND user_id = $3`,
    [payment.rows[0].id, subscriptionId, facts.userId],
  );
  await client.query(
    `UPDATE payment_intents SET status = 'succeeded'
      WHERE provider = $3
        AND (
          ($4::text IS NOT NULL AND id::text = $4)
          OR ($4::text IS NULL AND $1::text IS NOT NULL AND provider_contract_id = $1)
          OR ($4::text IS NULL AND $1::text IS NULL AND user_id = $2)
        )
        AND status IN ('pending', 'expired')`,
    [facts.contractId ?? null, facts.userId, facts.provider, facts.intentId ?? null],
  );
  return "applied";
}

interface QuotaLimit {
  metric: string;
  period: string;
  limitValue: number;
}

const PERIOD_DAYS: Readonly<Record<string, number>> = Object.freeze({
  day: 1,
  week: 7,
  month: 30,
});

/**
 * Сложить оставшуюся ценность старого тарифа с купленным сроком нового.
 *
 * Срок складывается буквально. Для каждой периодической квоты считается
 * сохранённый объём: `старый лимит × старые дни + новый лимит × новые дни`,
 * затем он делится на общий срок. Так Plus→Max не превращает уже оплаченные
 * дни Plus в Max бесплатно и одновременно не сжигает ни одной квоты.
 */
async function blendQuotaLimits(
  client: pg.PoolClient,
  userId: string,
  previous: { id: string; plan: string; status: string },
  targetPlan: string,
  previousDays: number,
  targetDays: number,
): Promise<QuotaLimit[]> {
  const oldRows = await client.query<{
    metric: string; period: string; limit_value: string;
  }>(
    `SELECT q.metric, q.period,
            CASE WHEN $4::text = 'trialing' THEN q.free_value
                 ELSE COALESCE(sq.limit_value, q.limit_value)
            END::text AS limit_value
       FROM quotas q
       LEFT JOIN subscription_quota_limits sq
         ON sq.subscription_id = $2
        AND sq.user_id = $3
        AND sq.metric = q.metric
        AND sq.period = q.period
      WHERE q.plan = $1`,
    [previous.plan, previous.id, userId, previous.status],
  );
  const targetRows = await client.query<{
    metric: string; period: string; limit_value: string;
  }>(
    `SELECT metric, period, limit_value::text AS limit_value
       FROM quotas WHERE plan = $1`,
    [targetPlan],
  );
  const old = quotaMap(oldRows.rows);
  const target = quotaMap(targetRows.rows);
  const keys = new Set([...old.keys(), ...target.keys()]);
  const totalDays = previousDays + targetDays;
  const result: QuotaLimit[] = [];
  for (const key of keys) {
    const [metric, period] = key.split("\u0000");
    if (!metric || !period) continue;
    const oldLimit = old.get(key) ?? 0;
    const targetLimit = target.get(key) ?? 0;
    let limitValue: number;
    if (oldLimit < 0 || targetLimit < 0) {
      limitValue = -1;
    } else if (period === "total") {
      limitValue = safeCeil(oldLimit + targetLimit);
    } else {
      const periodDays = PERIOD_DAYS[period];
      if (!periodDays) continue;
      const dailyCapacity = (oldLimit / periodDays) * previousDays
        + (targetLimit / periodDays) * targetDays;
      limitValue = safeCeil((dailyCapacity / totalDays) * periodDays);
    }
    result.push({ metric, period, limitValue });
  }
  return result;
}

function quotaMap(rows: Array<{ metric: string; period: string; limit_value: string }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.limit_value);
    if (!Number.isSafeInteger(value) || value < -1) {
      throw new Error("Некорректный лимит тарифа");
    }
    map.set(`${row.metric}\u0000${row.period}`, value);
  }
  return map;
}

function remainingDays(end: Date | null): number {
  if (!end) return 0;
  return Math.max(0, (end.getTime() - Date.now()) / 86_400_000);
}

function safeCeil(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Смешанная квота вышла за безопасные границы");
  }
  return Math.ceil(value);
}
