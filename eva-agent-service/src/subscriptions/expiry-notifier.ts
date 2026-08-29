import type { Database } from "../db.js";
import type { OutboxDelivery } from "../delivery/outbox.js";
import { preferredResponseLanguage, t } from "../i18n/index.js";
import type { Logger } from "../logger.js";

interface ExpiringSubscription {
  subscription_id: string;
  user_id: string;
  chat_id: string;
  plan: string;
  current_period_end: Date;
  timezone: string;
  language_mode: string;
  preferred_language: string | null;
  last_message_language: string | null;
  language_code: string | null;
}

/** Durable, model-independent notification one day before access ends. */
export class SubscriptionExpiryNotifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly outbox: OutboxDelivery,
    private readonly logger: Logger,
    private readonly intervalMs = 15 * 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let cursorEnd: string | null = null;
      let cursorId: string | null = null;
      while (true) {
        const { rows } = await this.db.withSystemScope(
          "subscriptions.expiry_notifications",
          async () => await this.db.query<ExpiringSubscription>(
          `-- tenant: system — системное уведомление выбирает истекающие подписки всех пользователей
           SELECT s.id::text AS subscription_id, u.id::text AS user_id,
                  u.telegram_id::text AS chat_id,
                  s.plan, s.current_period_end,
                  COALESCE(u.timezone, 'UTC') AS timezone,
                  u.language_mode, u.preferred_language,
                  u.last_message_language, u.language_code
             FROM subscriptions s
             JOIN users u ON u.id = s.user_id
            WHERE s.status IN ('trialing', 'active', 'past_due')
              AND s.current_period_end > now()
              AND s.current_period_end <= now() + interval '24 hours'
              AND u.state = 'active' AND NOT u.is_blocked
              AND ($1::timestamptz IS NULL
                   OR (s.current_period_end, s.id) > ($1::timestamptz, $2::bigint))
            ORDER BY s.current_period_end, s.id
            LIMIT 100`,
            [cursorEnd, cursorId],
          ),
          { crossUser: true },
        );
        for (const row of rows) {
          const language = preferredResponseLanguage(row);
          const end = asDate(row.current_period_end);
          await this.outbox.send({
            method: "sendMessage",
            chatId: Number(row.chat_id),
            userId: Number(row.user_id),
            priority: "reminder",
            idempotencyKey: `subscription-expiry:${row.subscription_id}:${end.toISOString()}`,
            payload: {
              chat_id: Number(row.chat_id),
              text: t(language, "subscriptionExpiresTomorrow", {
                plan: row.plan,
                date: formatEnd(end, row.timezone, language),
              }),
            },
          });
        }
        if (rows.length < 100) break;
        const last = rows.at(-1)!;
        cursorEnd = asDate(last.current_period_end).toISOString();
        cursorId = last.subscription_id;
      }
    } catch (error) {
      this.logger.error("Не удалось отправить уведомления об окончании подписки", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}

function asDate(value: Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatEnd(value: Date, timezone: string, language: "ru" | "en"): string {
  try {
    return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: timezone,
    }).format(value);
  } catch {
    return value.toISOString();
  }
}
