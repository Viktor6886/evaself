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

import { adminBadRequest } from "../admin/errors.js";
import type { Database } from "../db.js";
import { grantPaidAccess } from "./grant.js";

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
  async offers(): Promise<StarsOffer[]> {
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
    return rows
      .filter((row) => PERIOD_DAYS[row.period] !== undefined)
      .map((row) => describe(row.plan, row.period, Number(row.stars)));
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
    if (days === undefined) throw adminBadRequest("Неизвестный срок подписки");
    const { rows } = await this.db.withSystemScope(
      "payments.stars.price",
      async () => await this.db.query<{ stars: number }>(
        `
          -- tenant: system — прайс общий для установки, владельца у строки нет
          SELECT stars FROM plan_prices WHERE plan = $1 AND period = $2 AND enabled`,
        [plan, period],
      ),
    );
    const stars = rows[0] ? Number(rows[0].stars) : null;
    if (stars === null || !Number.isSafeInteger(stars) || stars <= 0) {
      throw adminBadRequest("Для этого тарифа и срока цена не назначена");
    }
    const offer = describe(plan, period, stars);
    const created = await this.db.withUserScope(
      { userId, label: "payments.stars.intent" },
      async () => await this.db.query<{ id: string }>(
        `INSERT INTO payment_intents
           (user_id, provider, provider_product_id, plan, duration_days,
            amount_minor, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        [userId, STARS_PROVIDER, `${plan}:${period}`, plan, days, stars, STARS_CURRENCY],
      ),
    );
    return { ...offer, payload: created.rows[0]!.id };
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
    const { rows } = await this.db.withUserScope(
      { telegramId: input.telegramUserId, label: "payments.stars.pre_checkout" },
      async () => await this.db.query<{
        id: string; status: string; amount_minor: string; plan: string;
        telegram_id: string | null;
      }>(
        `
          -- tenant: by telegram_id — счёт ищется только среди своих
          SELECT i.id, i.status, i.amount_minor, i.plan, u.telegram_id
            FROM payment_intents i
            JOIN users u ON u.id = i.user_id
           WHERE i.id = $1 AND i.provider = $2 AND u.telegram_id = $3`,
        [input.payload, STARS_PROVIDER, input.telegramUserId],
      ),
    );
    // Чужой счёт сюда не доходит: запрос ограничен своим владельцем, и
    // от несуществующего чужой неотличим намеренно. За чужую подписку
    // платить нельзя — доступ получил бы не плательщик, — а сообщать
    // плательщику, что счёт существует и чей он, незачем.
    const intent = rows[0];
    if (!intent) return deny("unknown_intent", "Счёт больше не действителен");
    if (intent.status !== "pending") {
      return deny("not_pending", "Этот счёт уже оплачен или отменён");
    }
    if (Number(intent.amount_minor) !== input.totalAmount) {
      return deny("amount_changed", "Цена изменилась — откройте счёт заново");
    }
    return { ok: true, intentId: intent.id };
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
        amount_minor: string; currency: string; status: string;
      }>(
        `
          -- tenant: by telegram_id — платёж применяется только к своему намерению
          SELECT i.id, i.user_id, i.plan, i.duration_days,
                 i.amount_minor, i.currency, i.status
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
        || !["pending", "succeeded"].includes(intent.status)
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
