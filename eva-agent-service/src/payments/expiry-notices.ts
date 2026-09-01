/**
 * Предупреждение о конце подписки.
 *
 * Подписка кончается тихо: доступ просто перестаёт работать, и человек
 * узнаёт об этом, упёршись в лимит посреди разговора. Три предупреждения
 * — за три дня, за сутки и в день окончания — превращают обрыв в
 * ожидаемое событие, которое можно предотвратить одним нажатием.
 *
 * Своего хранилища здесь нет и новой таблицы не появилось. Отметка о
 * том, что предупреждение отправлено, ложится в `subscriptions.meta` —
 * туда же, где живут остальные служебные отметки подписки. Она и есть
 * идемпотентность: повторный проход видит отметку и молчит, поэтому
 * планировщик может звать проверку сколько угодно часто, а человек
 * получит каждое предупреждение ровно один раз.
 *
 * Второго планировщика тоже нет: проверка вызывается из существующего
 * фонового цикла (инвариант 9).
 */

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

/** За сколько дней предупреждаем. Ноль — день окончания. */
export const EXPIRY_NOTICE_DAYS = [3, 1, 0] as const;

export interface ExpiryCandidate {
  subscription_id: string;
  user_id: string;
  telegram_id: string;
  chat_id: string;
  plan: string;
  days_left: number;
}

export interface ExpiryNoticeOptions {
  db: Database;
  logger: Logger;
  /** Как отправить сообщение. Кнопки готовит вызывающий: он знает про звёзды. */
  notify(input: {
    chatId: number;
    telegramId: number;
    plan: string;
    daysLeft: number;
  }): Promise<void>;
  /** Сколько предупреждений за один проход. Ограничение — против лавины. */
  batchSize?: number;
}

export class SubscriptionExpiryNotices {
  constructor(private readonly options: ExpiryNoticeOptions) {}

  /**
   * Один проход.
   *
   * Возвращает, сколько предупреждений отправлено: ноль — норма, а не
   * признак поломки.
   */
  async run(): Promise<{ sent: number }> {
    const limit = Math.max(1, Math.min(200, this.options.batchSize ?? 50));
    const candidates = await this.candidates(limit);
    let sent = 0;
    for (const candidate of candidates) {
      // Отметка ставится до отправки: повторная отправка человеку хуже,
      // чем пропущенное предупреждение. Если отправка не удастся, он
      // узнает о конце подписки из следующего предупреждения или из
      // самого лимита — а получить одно и то же трижды подряд он не
      // должен ни при каких обстоятельствах.
      const marked = await this.mark(candidate.subscription_id, candidate.days_left);
      if (!marked) continue;
      try {
        await this.options.notify({
          chatId: Number(candidate.chat_id),
          telegramId: Number(candidate.telegram_id),
          plan: candidate.plan,
          daysLeft: candidate.days_left,
        });
        sent += 1;
      } catch (error) {
        this.options.logger.warn("Предупреждение о конце подписки не доставлено", {
          days_left: candidate.days_left,
          code: error instanceof Error ? error.name : "unknown_error",
        });
      }
    }
    return { sent };
  }

  /**
   * Кому пора сказать.
   *
   * Дни считает PostgreSQL, а не код: «осталось три дня» — это разница
   * дат в часовом поясе человека, и считать её на стороне приложения
   * значит завести второе мнение о том, когда кончается подписка.
   */
  private async candidates(limit: number): Promise<ExpiryCandidate[]> {
    const { rows } = await this.options.db.withSystemScope(
      "subscriptions.expiry.candidates",
      async () => await this.options.db.query<ExpiryCandidate>(
        `
          -- tenant: system — выборка по всем подписчикам; сообщение готовится уже по одному человеку
          SELECT s.id::text AS subscription_id,
                 u.id::text AS user_id,
                 u.telegram_id::text AS telegram_id,
                 COALESCE(t.chat_id, u.telegram_id)::text AS chat_id,
                 s.plan,
                 GREATEST(0, (s.current_period_end::date - (now() AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date))::integer AS days_left
            FROM subscriptions s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN LATERAL (
              SELECT chat_id FROM telegram_updates
               WHERE user_id = u.id AND chat_id IS NOT NULL
               ORDER BY received_at DESC LIMIT 1
            ) t ON true
           WHERE s.status IN ('trialing', 'active')
             AND s.current_period_end IS NOT NULL
             AND u.state = 'active'
             AND NOT u.is_blocked
             -- Бесплатному тарифу кончаться нечему: предупреждать не о чем.
             AND s.plan <> 'free'
             AND (s.current_period_end::date - (now() AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date)
                 = ANY($1::integer[])
             AND NOT (COALESCE(s.meta -> 'expiry_notices', '[]'::jsonb)
                      @> to_jsonb(ARRAY[(s.current_period_end::date - (now() AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date)]))
           ORDER BY s.current_period_end
           LIMIT $2`,
        [[...EXPIRY_NOTICE_DAYS], limit],
      ),
    );
    return rows;
  }

  /**
   * Записать, что предупреждение отправлено.
   *
   * Возвращает false, если отметка уже стояла: значит, кто-то опередил, и
   * второе сообщение человеку не уйдёт. Условие в самом UPDATE, а не
   * проверкой перед ним: между проверкой и записью помещается второй
   * проход.
   */
  private async mark(subscriptionId: string, daysLeft: number): Promise<boolean> {
    const { rowCount } = await this.options.db.withSystemScope(
      "subscriptions.expiry.mark",
      async () => await this.options.db.query(
        `
          -- tenant: system — служебная отметка подписки, владелец назван строкой
          UPDATE subscriptions
             SET meta = jsonb_set(
                   COALESCE(meta, '{}'::jsonb), '{expiry_notices}',
                   COALESCE(meta -> 'expiry_notices', '[]'::jsonb) || to_jsonb(ARRAY[$2::integer]))
           WHERE id = $1::bigint
             AND NOT (COALESCE(meta -> 'expiry_notices', '[]'::jsonb) @> to_jsonb(ARRAY[$2::integer]))`,
        [subscriptionId, daysLeft],
      ),
    );
    return (rowCount ?? 0) > 0;
  }
}
