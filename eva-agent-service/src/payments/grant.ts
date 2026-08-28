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

  const previous = await client.query<{ current_period_end: Date | null }>(
    `SELECT current_period_end
       FROM subscriptions
      WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')
      ORDER BY current_period_end DESC NULLS LAST, created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [facts.userId],
  );
  await client.query(
    `UPDATE subscriptions SET status = 'expired'
      WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')`,
    [facts.userId],
  );
  await client.query(
    `INSERT INTO subscriptions
       (user_id, plan, status, provider, provider_subscription_id,
        current_period_start, current_period_end)
     VALUES (
       $1, $2, 'active', $6, $3, now(),
       GREATEST(now(), COALESCE($5::timestamptz, now())) + make_interval(days => $4)
     )`,
    [
      facts.userId,
      plan.plan,
      facts.contractId ?? facts.paymentId,
      plan.durationDays,
      previous.rows[0]?.current_period_end?.toISOString() ?? null,
      facts.provider,
    ],
  );
  await client.query(
    `UPDATE payment_intents SET status = 'succeeded'
      WHERE provider = $3
        AND (provider_contract_id = $1 OR user_id = $2)
        AND status = 'pending'`,
    [facts.contractId ?? null, facts.userId, facts.provider],
  );
  return "applied";
}
