import type { Database } from "../db.js";
import type { OutboxDelivery } from "../delivery/outbox.js";
import { preferredResponseLanguage, t } from "../i18n/index.js";
import type { Logger } from "../logger.js";

interface ExhaustedMessageQuota {
  user_id: string;
  chat_id: string;
  period: "day" | "week" | "month";
  period_start: string;
  language_mode: string;
  preferred_language: string | null;
  last_message_language: string | null;
  language_code: string | null;
}

/**
 * Сообщает о переходе конечной квоты сообщений в ноль.
 *
 * Вызывается только после успешного расхода сообщения. До расхода общий
 * quota gate уже доказал, что каждый период был положительным, поэтому
 * найденный здесь ноль — именно что закончившаяся квота. Durable key
 * дополнительно защищает от повтора хода и повторного вызова notifier.
 */
export class QuotaExhaustionNotifier {
  constructor(
    private readonly db: Database,
    private readonly outbox: OutboxDelivery,
    private readonly logger: Logger,
  ) {}

  async notifyMessages(telegramId: number): Promise<void> {
    try {
      const { rows } = await this.db.withUserScope(
        { telegramId, label: "subscriptions.quota_exhaustion", inherit: true },
        async () => await this.db.query<ExhaustedMessageQuota>(
          `SELECT u.id::text AS user_id, u.telegram_id::text AS chat_id,
                  q.period,
                  (CASE q.period
                    WHEN 'day' THEN (now() AT TIME ZONE 'UTC')::date
                    WHEN 'week' THEN date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date
                    WHEN 'month' THEN date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date
                  END)::text AS period_start,
                  u.language_mode, u.preferred_language,
                  u.last_message_language, u.language_code
             FROM users u
             JOIN v_quota_status q ON q.user_id = u.id
            WHERE u.telegram_id = $1
              AND q.metric = 'messages'
              AND q.period IN ('day', 'week', 'month')
              AND q.limit_value >= 0
              AND q.remaining <= 0
              AND u.state = 'active' AND NOT u.is_blocked
            ORDER BY CASE q.period WHEN 'day' THEN 1 WHEN 'week' THEN 2 ELSE 3 END`,
          [telegramId],
        ),
      );
      if (rows.length === 0) return;

      const user = rows[0]!;
      const language = preferredResponseLanguage(user);
      const identities = rows.map((row) => `${row.period}:${row.period_start}`);
      await this.outbox.send({
        method: "sendMessage",
        chatId: Number(user.chat_id),
        userId: Number(user.user_id),
        priority: "reminder",
        idempotencyKey: `quota-exhausted:${user.user_id}:messages:${identities.join("+")}`,
        payload: {
          chat_id: Number(user.chat_id),
          text: t(language, "messageQuotaExhaustedNotice", {
            periods: rows.map((row) => periodLabel(row.period, language)).join(", "),
          }),
        },
      });
    } catch (error) {
      // Уведомление не является частью права доступа: его отказ не должен
      // откатывать уже доставленный ответ или повторно списывать сообщение.
      this.logger.warn("Не удалось отправить уведомление об исчерпании квоты", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}

function periodLabel(period: ExhaustedMessageQuota["period"], language: "ru" | "en"): string {
  if (language === "en") {
    return period === "day" ? "daily" : period === "week" ? "weekly" : "monthly";
  }
  return period === "day" ? "за сутки" : period === "week" ? "за неделю" : "за месяц";
}
