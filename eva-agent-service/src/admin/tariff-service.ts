/**
 * Тарифы: лимиты, пробные, цены в звёздах и фактический расход.
 *
 * Своего хранилища здесь нет. Лимиты живут в `quotas`, расход — в
 * `usage_counters`, и обе таблицы существовали до тарификации: первая
 * описывает «сколько положено на тарифе», вторая — «сколько израсходовал
 * человек». Новое только одно — цена тарифа в звёздах, и у неё своя
 * таблица, потому что ничего похожего в схеме не было.
 *
 * Сервис читает и правит эти три таблицы и больше ничего не хранит: два
 * места, знающих лимит тарифа, разошлись бы на первой же правке.
 */

import type pg from "pg";

import { adminBadRequest } from "./errors.js";
import { PERIOD_DAYS, PERIOD_TITLE, STARS_PROVIDER } from "../payments/stars.js";

/** Тарифы, которые панель показывает и правит. */
export const PLANS = ["free", "plus", "max"] as const;
/** Периоды лимита — те же, что допускает схема `quotas`. */
export const LIMIT_PERIODS = ["day", "week", "month"] as const;
/** Сроки подписки, за которые назначается цена. */
export const PRICE_PERIODS = ["week", "month", "quarter"] as const;

/**
 * Расходники, которые считаются.
 *
 * Порядок значим: в таком виде они показываются в панели, и первым идёт
 * то, ради чего тариф и покупают.
 */
export const METRICS = [
  { metric: "messages", title: "Сообщения человека" },
  { metric: "messages_out", title: "Ответы Евы" },
  { metric: "voice_in", title: "Принятые голосовые" },
  { metric: "voice_minutes", title: "Минуты распознавания" },
  { metric: "voice_out", title: "Озвученные ответы" },
  { metric: "images", title: "Изображения" },
  { metric: "documents", title: "Документы" },
  { metric: "web_search", title: "Поиск в интернете" },
] as const;

export interface TariffLimit {
  plan: string;
  metric: string;
  period: string;
  limit_value: number;
  free_value: number;
}

export class TariffService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Всё, что нужно вкладке «Тарифы», одним ответом.
   *
   * Лимиты, цены и расход собираются вместе намеренно: по отдельности их
   * пришлось бы сводить в браузере, а это второе место, знающее, как
   * тариф связан с расходом.
   */
  async state(): Promise<Record<string, unknown>> {
    const [limits, prices, usage, subscribers] = await Promise.all([
      this.pool.query(
        `SELECT plan, metric, period, limit_value, free_value
           FROM quotas ORDER BY plan, metric, period`,
      ),
      this.pool.query(
        `SELECT plan, period, stars, enabled, updated_at
           FROM plan_prices ORDER BY plan, period`,
      ),
      // Расход всей установки по метрикам за сутки и месяц. Людей в
      // ответе нет — только количества: кто именно сколько потратил,
      // видно в карточке пользователя, и туда ведёт отдельный доступ.
      this.pool.query(
        `
          -- tenant: system — сводный расход установки для вкладки тарифов, доступ ограничен RBAC на маршруте
          SELECT metric, period, sum(used)::bigint AS used, count(*)::int AS users
            FROM usage_counters
           WHERE period IN ('day', 'month')
             AND period_start = CASE period
                   WHEN 'day' THEN (now() AT TIME ZONE 'UTC')::date
                   ELSE date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date
                 END
           GROUP BY metric, period`,
      ),
      this.pool.query(
        `
          -- tenant: system — сколько человек на каждом тарифе, без единой пользовательской строки
          SELECT COALESCE(plan, 'free') AS plan, count(*)::int AS people
            FROM subscriptions
           WHERE status IN ('trialing', 'active', 'past_due')
           GROUP BY plan`,
      ),
    ]);
    return {
      plans: PLANS,
      limit_periods: LIMIT_PERIODS,
      price_periods: PRICE_PERIODS,
      metrics: METRICS,
      limits: limits.rows,
      prices: prices.rows,
      usage: usage.rows,
      subscribers: subscribers.rows,
      // Сколько дней в сроке — то же число, по которому продлевается
      // подписка. Панель показывает его человеку, а не выдумывает своё.
      period_days: PERIOD_DAYS,
      period_titles: PERIOD_TITLE,
    };
  }

  /**
   * Последние платежи звёздами.
   *
   * Отдельным запросом, а не частью `state()`: сводка тарифов нужна на
   * каждом открытии вкладки, а список платежей — когда его открыли.
   * Тянуть его всегда значит платить за него всегда.
   */
  async payments(limit = 50): Promise<Record<string, unknown>> {
    const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    const { rows } = await this.pool.query(
      `
        -- tenant: system — журнал платежей установки, доступ ограничен RBAC на маршруте
        SELECT p.id, p.status, p.amount_minor AS stars, p.paid_at, p.created_at,
               p.provider_payment_id AS charge_id, p.description,
               u.telegram_id, u.username, u.first_name
          FROM payments p
          JOIN users u ON u.id = p.user_id
         WHERE p.provider = $1
         ORDER BY p.created_at DESC
         LIMIT $2`,
      [STARS_PROVIDER, size],
    );
    const totals = await this.pool.query(
      `
        -- tenant: system — сводка по платежам установки
        SELECT status, count(*)::int AS payments, COALESCE(sum(amount_minor), 0)::bigint AS stars
          FROM payments WHERE provider = $1 GROUP BY status`,
      [STARS_PROVIDER],
    );
    return { payments: rows, totals: totals.rows, limit: size };
  }

  /**
   * Лимит тарифа. Пишется одной записью на (тариф, метрика, период).
   *
   * `-1` означает безлимит и допускается схемой; `free_value` — сколько
   * доступно без оплаченной подписки.
   */
  async setLimit(body: Record<string, unknown>): Promise<TariffLimit> {
    const plan = this.plan(body.plan);
    const metric = this.metric(body.metric);
    const period = this.oneOf(body.period, LIMIT_PERIODS, "период");
    const limit = this.integer(body.limit_value, "limit_value", -1);
    const free = this.integer(body.free_value ?? 0, "free_value", 0);
    if (free > limit && limit >= 0) {
      throw adminBadRequest(
        "Пробных не может быть больше лимита тарифа: иначе платить будет не за что.",
      );
    }
    const { rows } = await this.pool.query<TariffLimit>(
      `INSERT INTO quotas (plan, metric, period, limit_value, free_value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (plan, metric, period) DO UPDATE
         SET limit_value = EXCLUDED.limit_value,
             free_value = EXCLUDED.free_value,
             updated_at = now()
       RETURNING plan, metric, period, limit_value, free_value`,
      [plan, metric, period, limit, free],
    );
    return rows[0]!;
  }

  /** Цена тарифа в звёздах за срок. Одна на всех. */
  async setPrice(body: Record<string, unknown>, actorId: string | null): Promise<Record<string, unknown>> {
    const plan = this.plan(body.plan);
    if (plan === "free") throw adminBadRequest("Бесплатный тариф не продаётся");
    const period = this.oneOf(body.period, PRICE_PERIODS, "срок");
    const stars = this.integer(body.stars, "stars", 1);
    const enabled = body.enabled !== false;
    const { rows } = await this.pool.query(
      `INSERT INTO plan_prices (plan, period, stars, enabled, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (plan, period) DO UPDATE
         SET stars = EXCLUDED.stars, enabled = EXCLUDED.enabled,
             updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING plan, period, stars, enabled, updated_at`,
      [plan, period, stars, enabled, actorId],
    );
    return rows[0]!;
  }

  /**
   * Возврат звёзд.
   *
   * Порядок обязателен: сначала Telegram возвращает списание, и только
   * потом закрывается подписка. Обратный порядок оставил бы человека без
   * доступа при неудавшемся возврате — то есть без денег и без Евы.
   *
   * Записывается ровно та подписка, которую оплатил этот платёж:
   * `provider_subscription_id` — идентификатор его намерения оплаты.
   * Снимать всё живое разом нельзя, иначе возврат за неделю унёс бы и
   * оплаченный отдельно месяц.
   */
  async refund(
    chargeId: string,
    refundWithTelegram: (telegramId: number, chargeId: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const charge = String(chargeId ?? "").trim();
    if (!charge) throw adminBadRequest("Не указан идентификатор списания");
    const found = await this.pool.query<{
      id: string; user_id: string; telegram_id: string; intent_id: string | null;
      amount_minor: string;
    }>(
      `
        -- tenant: system — возврат платежа установки, доступ ограничен ролью и sudo на маршруте
        SELECT p.id, p.user_id, u.telegram_id, p.amount_minor,
               p.raw ->> 'invoice_payload' AS intent_id
          FROM payments p
          JOIN users u ON u.id = p.user_id
         WHERE p.provider = $1 AND p.provider_payment_id = $2 AND p.status = 'succeeded'`,
      [STARS_PROVIDER, charge],
    );
    const payment = found.rows[0];
    if (!payment) throw adminBadRequest("Платёж не найден или уже возвращён");

    await refundWithTelegram(Number(payment.telegram_id), charge);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          -- tenant: system — закрытие подписки, оплаченной возвращённым платежом
          UPDATE subscriptions SET status = 'canceled', canceled_at = now()
            WHERE user_id = $1 AND provider = $2 AND provider_subscription_id = $3
              AND status IN ('trialing', 'active', 'past_due')`,
        [payment.user_id, STARS_PROVIDER, payment.intent_id],
      );
      await client.query(
        `
          -- tenant: system — отметка возврата на платеже установки
          UPDATE payments SET status = 'refunded', updated_at = now()
            WHERE id = $1 AND user_id = $2`,
        [payment.id, payment.user_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      refunded: true,
      charge_id: charge,
      stars: Number(payment.amount_minor),
      telegram_id: Number(payment.telegram_id),
    };
  }

  private plan(value: unknown): string {
    return this.oneOf(value, PLANS, "тариф");
  }

  private metric(value: unknown): string {
    const metric = String(value ?? "");
    if (!METRICS.some((entry) => entry.metric === metric)) {
      throw adminBadRequest(`Неизвестный расходник ${metric}`);
    }
    return metric;
  }

  private oneOf(value: unknown, allowed: readonly string[], what: string): string {
    const parsed = String(value ?? "");
    if (!allowed.includes(parsed)) {
      throw adminBadRequest(`Неизвестный ${what}: ${parsed}. Допустимо: ${allowed.join(", ")}`);
    }
    return parsed;
  }

  private integer(value: unknown, field: string, minimum: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw adminBadRequest(`${field}: ожидается целое число`);
    }
    if (parsed < minimum) throw adminBadRequest(`${field}: не меньше ${minimum}`);
    return parsed;
  }
}
