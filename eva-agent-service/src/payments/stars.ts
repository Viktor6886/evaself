/**
 * Оплата звёздами Telegram.
 *
 * Второго платёжного контура здесь нет: звёзды — ещё один провайдер в
 * тех же `payment_intents`, `payments` и `subscriptions`, а право
 * доступа выдаёт общий `grantPaidAccess`. Отличий от карточной оплаты
 * ровно три, и все они про Telegram, а не про подписку.
 *
 * Первое. Валюта `XTR` целая: одна звезда — одна единица, дробной звезды
 * не существует. Поэтому `amount_minor` хранит звёзды как есть, без
 * копеечной арифметики.
 *
 * Второе. Перед списанием Telegram спрашивает подтверждение и ждёт
 * ответа десять секунд. Ответ обязан быть детерминированным и быстрым:
 * ни модели, ни очереди на этом пути нет и быть не может. Проверяется
 * то, что можно проверить наверняка, — намерение оплаты существует,
 * принадлежит этому человеку, ещё не оплачено, и цена с тех пор не
 * менялась.
 *
 * Третье. Идентификатор списания `telegram_payment_charge_id` — он же
 * ключ идемпотентности и он же единственный способ сделать возврат.
 * Поэтому он ложится в `payments.provider_payment_id`, где уникальный
 * индекс уже стоит: повторное событие второй подписки не выдаст.
 */

import type { Database } from "../db.js";
import { badRequest } from "../errors.js";
import { grantPaidAccess } from "./grant.js";
import { isPaidPlan, paidPlanLevel } from "./plans.js";

/** Имя провайдера в `payments`, `payment_intents` и `subscriptions`. */
export const STARS_PROVIDER = "telegram_stars";

/** Валюта звёзд у Telegram. */
export const STARS_CURRENCY = "XTR";

/**
 * Сколько дней в сроке подписки.
 *
 * Календарных месяцев тариф не считает: «месяц» — это тридцать дней для
 * всех одинаково, иначе февральская подписка стоила бы дороже мартовской
 * при той же цене.
 */
export const PERIOD_DAYS: Record<string, number> = {
  week: 7,
  month: 30,
  quarter: 90,
};

/** Как срок называется человеку в заголовке: «Ева Плюс — неделя». */
export const PERIOD_TITLE: Record<string, string> = {
  week: "неделя",
  month: "месяц",
  quarter: "три месяца",
};

/**
 * Тот же срок в винительном падеже: «подписка на неделю».
 *
 * Отдельной формой, а не склейкой: «на неделя» человек читает как
 * небрежность, и первое же впечатление от платного продукта — что его
 * делали наспех.
 */
export const PERIOD_FOR: Record<string, string> = {
  week: "неделю",
  month: "месяц",
  quarter: "три месяца",
};

/** Как тариф называется человеку. */
export const PLAN_TITLE: Record<string, string> = {
  plus: "Ева Плюс",
  max: "Ева Макс",
};

export interface StarsOffer {
  plan: string;
  period: string;
  stars: number;
  title: string;
  description: string;
}

export interface StarsInvoice extends StarsOffer {
  /** Идентификатор намерения оплаты: он же payload счёта. */
  payload: string;
}

/** Что вернула предварительная проверка. */
export type PreCheckoutVerdict =
  | { ok: true; intentId: string }
  | { ok: false; reason: string; message: string };

/**
 * Отдельного выключателя продаж здесь нет намеренно.
 *
 * Продаётся то, у чего в `plan_prices` стоит включённая цена, — и это же
 * владелец правит в панели. Второй флаг «продажи включены» стал бы вторым
 * местом, знающим один и тот же факт: рассогласуйся они, панель
 * показывала бы цену тарифа, который не продаётся, или наоборот.
 * Остановить продажи целиком — снять галочки с цен.
 */
export interface StarsPaymentsOptions {
  db: Database;
}

export class StarsPayments {
  constructor(private readonly options: StarsPaymentsOptions) {}

  private get db(): Database { return this.options.db; }

  /** Что сейчас продаётся: только тарифы с назначенной и включённой ценой. */
  async offers(userId?: number): Promise<StarsOffer[]> {
    const { rows } = await this.db.withSystemScope(
      "payments.stars.offers",
      async () => await this.db.query<{ plan: string; period: string; stars: number }>(
        `
          -- tenant: system — прайс общий для установки, владельца у строки нет
          SELECT plan, period, stars
            FROM plan_prices
           WHERE enabled
           ORDER BY plan, period`,
      ),
    );
    const active = userId === undefined ? null : await this.activeSubscription(userId);
    return rows
      .filter((row) => isPaidPlan(row.plan))
      .filter((row) => PERIOD_DAYS[row.period] !== undefined)
      .filter((row) => purchaseBlock(active, row.plan) === null)
      .map((row) => describe(row.plan, row.period, Number(row.stars)));
  }

  /** Единая read-only проверка для Stars, Mini App и внешних кнопок. */
  async eligibility(
    userId: number,
    targetPlan: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    if (!isPaidPlan(targetPlan)) {
      return { ok: false, reason: "unknown_plan", message: "Неизвестный тариф подписки" };
    }
    const blocked = purchaseBlock(await this.activeSubscription(userId), targetPlan);
    return blocked ? { ok: false, ...blocked } : { ok: true };
  }

  /** Почему сейчас нет ни одного допустимого тарифа. */
  async unavailableMessage(userId: number): Promise<string | null> {
    const active = await this.activeSubscription(userId);
    return active ? purchaseBlock(active, active.plan)?.message ?? null : null;
  }

  /**
   * Намерение оплаты и счёт к нему.
   *
   * Намерение записывается до счёта: без него предварительная проверка
   * не найдёт, что именно человек оплачивает, и Telegram отменит платёж.
   * Цена берётся из `plan_prices` в этот момент и запоминается в
   * намерении — если владелец поменяет её, пока счёт висит в чате,
   * проверка увидит расхождение и не даст списать не ту сумму.
   */
  async invoice(userId: number, plan: string, period: string): Promise<StarsInvoice> {
    const days = PERIOD_DAYS[period];
    if (days === undefined) throw badRequest("Неизвестный срок подписки");
    if (!isPaidPlan(plan)) throw badRequest("Неизвестный тариф подписки");
    return await this.db.withUserScope(
      { userId, label: "payments.stars.intent" },
      async () => await this.db.transaction(async (client) => {
        const owner = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        if (!owner.rows[0]) throw badRequest("Пользователь не найден");
        // Неоткрытый счёт заменяется новым. После pre-checkout даём
        // Telegram пятнадцать минут завершить списание и второй checkout
        // не создаём: иначе два быстрых нажатия могли списать деньги дважды.
        await client.query(
          `UPDATE payment_intents SET status = 'expired'
            WHERE user_id = $1 AND provider = $2 AND status = 'pending'
              AND (prechecked_at IS NULL OR prechecked_at < now() - interval '15 minutes')`,
          [userId, STARS_PROVIDER],
        );
        const inProgress = await client.query(
          `SELECT 1 FROM payment_intents
            WHERE user_id = $1 AND provider = $2 AND status = 'pending'
              AND prechecked_at >= now() - interval '15 minutes'
            LIMIT 1`,
          [userId, STARS_PROVIDER],
        );
        if (inProgress.rows[0]) {
          throw badRequest("Предыдущая оплата ещё завершается. Подождите несколько минут");
        }
        const active = await activeSubscriptionWith(client, userId);
        const blocked = purchaseBlock(active, plan);
        if (blocked) throw badRequest(blocked.message, { reason: blocked.reason });
        const priced = await client.query<{ stars: number }>(
          `SELECT stars FROM plan_prices WHERE plan = $1 AND period = $2 AND enabled`,
          [plan, period],
        );
        const stars = priced.rows[0] ? Number(priced.rows[0].stars) : null;
        if (stars === null || !Number.isSafeInteger(stars) || stars <= 0) {
          throw badRequest("Для этого тарифа и срока цена не назначена");
        }
        const created = await client.query<{ id: string }>(
          `INSERT INTO payment_intents
             (user_id, provider, provider_product_id, plan, duration_days,
              amount_minor, currency, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING id`,
          [userId, STARS_PROVIDER, `${plan}:${period}`, plan, days, stars, STARS_CURRENCY],
        );
        return { ...describe(plan, period, stars), payload: created.rows[0]!.id };
      }),
    );
  }

  /**
   * Предварительная проверка перед списанием.
   *
   * Отказ здесь дешевле возврата: Telegram просто не спишет звёзды.
   * Поэтому проверяется всё, что можно проверить наверняка, и молчаливое
   * «наверное, всё в порядке» не допускается.
   */
  async preCheckout(input: {
    payload: string;
    telegramUserId: number;
    totalAmount: number;
    currency: string;
  }): Promise<PreCheckoutVerdict> {
    if (input.currency !== STARS_CURRENCY) {
      return deny("currency", "Этот счёт оплачивается звёздами Telegram");
    }
    if (!UUID.test(input.payload)) {
      return deny("payload", "Счёт больше не действителен");
    }
    return await this.db.withUserScope(
      { telegramId: input.telegramUserId, label: "payments.stars.pre_checkout" },
      async () => await this.db.transaction(async (client) => {
        const owner = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE telegram_id = $1 FOR UPDATE",
          [input.telegramUserId],
        );
        const userId = Number(owner.rows[0]?.id ?? 0);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
          return deny("unknown_intent", "Счёт больше не действителен");
        }
        const found = await client.query<{
          id: string; status: string; amount_minor: string; plan: string;
          provider_product_id: string | null;
        }>(
          `SELECT i.id, i.status, i.amount_minor, i.plan, i.provider_product_id
             FROM payment_intents i
            WHERE i.id = $1 AND i.provider = $2 AND i.user_id = $3
            FOR UPDATE`,
          [input.payload, STARS_PROVIDER, userId],
        );
        const intent = found.rows[0];
        if (!intent) return deny("unknown_intent", "Счёт больше не действителен");
        if (intent.status !== "pending") {
          return deny("not_pending", "Этот счёт уже оплачен или отменён");
        }
        // Старый контейнер до rolling deploy мог оставить несколько
        // счетов. Первый реальный pre-checkout атомарно занимает слот:
        // неоткрытые старые счета закрываются, уже начатое списание
        // другого счёта не перебивается.
        const anotherCheckout = await client.query(
          `SELECT 1 FROM payment_intents
            WHERE user_id = $1 AND provider = $2 AND id <> $3
              AND status = 'pending'
              AND prechecked_at >= now() - interval '15 minutes'
            LIMIT 1`,
          [userId, STARS_PROVIDER, intent.id],
        );
        if (anotherCheckout.rows[0]) {
          return deny("payment_in_progress", "Предыдущая оплата ещё завершается");
        }
        await client.query(
          `UPDATE payment_intents SET status = 'expired'
            WHERE user_id = $1 AND provider = $2 AND id <> $3
              AND status = 'pending' AND prechecked_at IS NULL`,
          [userId, STARS_PROVIDER, intent.id],
        );
        if (Number(intent.amount_minor) !== input.totalAmount) {
          return deny("amount_changed", "Цена изменилась — откройте счёт заново");
        }
        const period = intent.provider_product_id?.split(":", 2)[1] ?? "";
        const currentPrice = await client.query<{ stars: number }>(
          `SELECT stars FROM plan_prices WHERE plan = $1 AND period = $2 AND enabled`,
          [intent.plan, period],
        );
        if (Number(currentPrice.rows[0]?.stars ?? 0) !== input.totalAmount) {
          return deny("amount_changed", "Цена изменилась — откройте счёт заново");
        }
        const blocked = purchaseBlock(await activeSubscriptionWith(client, userId), intent.plan);
        if (blocked) return deny(blocked.reason, blocked.message);
        await client.query(
          `UPDATE payment_intents SET prechecked_at = now() WHERE id = $1 AND user_id = $2`,
          [intent.id, userId],
        );
        return { ok: true, intentId: intent.id };
      }),
    );
  }

  /**
   * Состоявшийся платёж: запись и подписка.
   *
   * Возвращает, что именно произошло. `duplicate` — Telegram прислал
   * событие второй раз; это норма, а не отказ, и человеку писать об этом
   * не нужно.
   */
  async apply(input: {
    telegramUserId: number;
    payload: string;
    chargeId: string;
    totalAmount: number;
    currency: string;
    raw: Record<string, unknown>;
  }): Promise<
    | { state: "applied" | "duplicate"; plan: string; days: number }
    | { state: "unknown_intent" }
  > {
    return await this.db.transaction(async (client) => {
      const { rows } = await client.query<{
        id: string; user_id: string; plan: string; duration_days: number;
        amount_minor: string; currency: string; status: string; prechecked_at: Date | null;
      }>(
        `
          -- tenant: by telegram_id — платёж применяется только к своему намерению
          SELECT i.id, i.user_id, i.plan, i.duration_days,
                 i.amount_minor, i.currency, i.status, i.prechecked_at
            FROM payment_intents i
            JOIN users u ON u.id = i.user_id
           WHERE i.id = $1 AND i.provider = $2 AND u.telegram_id = $3
           FOR UPDATE OF i`,
        [UUID.test(input.payload) ? input.payload : NIL_UUID, STARS_PROVIDER, input.telegramUserId],
      );
      const intent = rows[0];
      if (!intent) return { state: "unknown_intent" as const };
      // Предварительная проверка была до списания, но состоявшийся платёж
      // является отдельным событием и проверяется заново. Иначе
      // повреждённый update мог выдать тариф за другую сумму или валюту.
      if (
        input.currency !== STARS_CURRENCY
        || intent.currency !== STARS_CURRENCY
        || Number(intent.amount_minor) !== input.totalAmount
        || !Number.isSafeInteger(input.totalAmount)
        || input.totalAmount <= 0
        || !input.chargeId.trim()
        || !(
          ["pending", "succeeded"].includes(intent.status)
          || (intent.status === "expired" && intent.prechecked_at)
        )
      ) {
        throw new Error("Успешный платёж не совпадает с намерением оплаты");
      }
      return await this.db.withUserScope(
        {
          userId: Number(intent.user_id),
          telegramId: input.telegramUserId,
          label: "payments.stars.apply",
        },
        async () => {
          const outcome = await grantPaidAccess(
            client,
            {
              userId: intent.user_id,
              provider: STARS_PROVIDER,
              paymentId: input.chargeId,
              contractId: intent.id,
              intentId: intent.id,
              raw: input.raw,
            },
            {
              plan: intent.plan,
              // Сумма берётся из платежа, а не из намерения: заплачено
              // столько, сколько списал Telegram.
              amountMinor: input.totalAmount,
              durationDays: Number(intent.duration_days),
              currency: STARS_CURRENCY,
            },
          );
          return { state: outcome, plan: intent.plan, days: Number(intent.duration_days) };
        },
      );
    });
  }

  private async activeSubscription(userId: number): Promise<ActiveSubscription | null> {
    return await this.db.withUserScope(
      { userId, label: "payments.stars.active_subscription" },
      async () => await activeSubscriptionWith(this.db, userId),
    );
  }

}

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface ActiveSubscription {
  [key: string]: unknown;
  plan: string;
  status: string;
  source: string;
  current_period_end: Date | null;
}

async function activeSubscriptionWith(
  queryable: Queryable,
  userId: number,
): Promise<ActiveSubscription | null> {
  const { rows } = await queryable.query<ActiveSubscription>(
    `SELECT plan, status, source, current_period_end
       FROM subscriptions
      WHERE user_id = $1
        AND status IN ('trialing', 'active', 'past_due')
        AND (current_period_end IS NULL OR current_period_end > now())
      ORDER BY current_period_end DESC NULLS FIRST, created_at DESC
      LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

function purchaseBlock(
  active: ActiveSubscription | null,
  targetPlan: string,
): { reason: string; message: string } | null {
  if (!active) return null;
  const currentLevel = paidPlanLevel(active.plan);
  const targetLevel = paidPlanLevel(targetPlan);
  if (currentLevel === null || targetLevel === null) {
    return { reason: "unknown_plan", message: "Текущий тариф нельзя изменить онлайн" };
  }
  if (!active.current_period_end) {
    return {
      reason: "indefinite_subscription",
      message: "Текущий доступ бессрочный. Изменить его может только администратор",
    };
  }
  // Пробный доступ можно превратить в оплату того же тарифа. Все прочие
  // действующие права повторно не продаются.
  if (currentLevel === targetLevel && active.status !== "trialing") {
    return {
      reason: "same_plan_active",
      message: `Этот тариф уже действует до ${formatDate(active.current_period_end)}. Повторная оплата будет доступна после окончания`,
    };
  }
  if (targetLevel < currentLevel) {
    return {
      reason: "downgrade_active",
      message: `Понизить тариф можно после ${formatDate(active.current_period_end)}, когда закончится текущий`,
    };
  }
  return null;
}

function formatDate(value: Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "окончания текущей подписки"
    : new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "UTC" }).format(parsed);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const deny = (reason: string, message: string): PreCheckoutVerdict =>
  ({ ok: false, reason, message });

/** Как предложение выглядит человеку. */
function describe(plan: string, period: string, stars: number): StarsOffer {
  const planTitle = PLAN_TITLE[plan] ?? plan;
  const periodTitle = PERIOD_TITLE[period] ?? period;
  return {
    plan,
    period,
    stars,
    title: `${planTitle} — ${periodTitle}`,
    description: `Подписка «${planTitle}» на ${PERIOD_FOR[period] ?? periodTitle}.`
      + " Оплата звёздами Telegram.",
  };
}
