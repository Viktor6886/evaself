import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { Logger } from "./logger.js";
import type { TelegramClient } from "./telegram.js";

interface LavaEvent {
  eventType: string;
  productId: string;
  paymentId: string;
  contractId: string | null;
  telegramId: number | null;
  email: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  raw: Record<string, unknown>;
}

export class LavaPayments {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly telegram: TelegramClient,
    private readonly logger: Logger,
  ) {}

  authorized(header: unknown): boolean {
    if (!this.config.lavaWebhookUser || !this.config.lavaWebhookPassword) return false;
    if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
      return false;
    }
    return constantEquals(
      decoded,
      `${this.config.lavaWebhookUser}:${this.config.lavaWebhookPassword}`,
    );
  }

  async handle(body: unknown): Promise<Record<string, unknown>> {
    const event = normalizeLavaEvent(body);
    if (event.eventType !== "payment.success") {
      return { ok: true, ignored: "event_type" };
    }
    if (!event.paymentId) return { ok: true, ignored: "missing_payment_id" };
    const plan = this.config.lavaPlans[event.productId];
    if (!plan) return { ok: true, ignored: "unknown_product" };
    if (
      !plan.plan ||
      !Number.isSafeInteger(plan.amountMinor) ||
      plan.amountMinor < 0 ||
      !Number.isSafeInteger(plan.durationDays) ||
      plan.durationDays < 1 ||
      !plan.currency
    ) {
      this.logger.error("Конфигурация тарифа Lava некорректна", {
        productId: event.productId,
      });
      return { ok: true, ignored: "invalid_plan_configuration" };
    }
    if (
      event.amountMinor !== plan.amountMinor ||
      event.currency !== plan.currency.toUpperCase()
    ) {
      this.logger.warn("Lava webhook отклонён: сумма или валюта не совпали", {
        paymentId: event.paymentId,
        productId: event.productId,
      });
      return { ok: true, ignored: "amount_or_currency_mismatch" };
    }
    if (!["completed", "success", "succeeded", "paid"].includes(event.status.toLowerCase())) {
      return { ok: true, ignored: "payment_status" };
    }

    const applied = await this.db.transaction(async (client) => {
      const user = await client.query<{ id: string; telegram_id: string }>(
        `SELECT id, telegram_id FROM users
          WHERE ($1::bigint IS NOT NULL AND telegram_id = $1)
             OR ($2::text IS NOT NULL AND lower(meta->>'email') = lower($2))
             OR id IN (
               SELECT user_id FROM onboarding_fields
                WHERE $2::text IS NOT NULL
                  AND field_key IN ('email', 'user_email')
                  AND lower(field_value) = lower($2)
             )
             OR id = (
               SELECT user_id FROM payment_intents
                WHERE provider = 'lava'
                  AND provider_contract_id = $3
                LIMIT 1
             )
          ORDER BY CASE WHEN telegram_id = $1 THEN 0 ELSE 1 END
          LIMIT 1
          FOR UPDATE`,
        [event.telegramId, event.email, event.contractId],
      );
      const found = user.rows[0];
      if (!found) return { state: "user_not_found" as const };

      const payment = await client.query<{ id: string }>(
        `INSERT INTO payments
           (user_id, provider, provider_payment_id, amount_minor, currency,
            status, description, paid_at, raw)
         VALUES ($1, 'lava', $2, $3, $4, 'succeeded', $5, now(), $6::jsonb)
         ON CONFLICT (provider, provider_payment_id)
           WHERE provider_payment_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          found.id,
          event.paymentId,
          event.amountMinor,
          event.currency,
          `План ${plan.plan}`,
          JSON.stringify(event.raw),
        ],
      );
      if (!payment.rows[0]) return { state: "duplicate" as const, telegramId: Number(found.telegram_id) };

      const previousSubscription = await client.query<{ current_period_end: Date | null }>(
        `SELECT current_period_end
           FROM subscriptions
          WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')
          ORDER BY current_period_end DESC NULLS LAST, created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [found.id],
      );
      await client.query(
        `UPDATE subscriptions SET status = 'expired'
          WHERE user_id = $1 AND status IN ('trialing', 'active', 'past_due')`,
        [found.id],
      );
      await client.query(
        `INSERT INTO subscriptions
           (user_id, plan, status, provider, provider_subscription_id,
            current_period_start, current_period_end)
         VALUES (
           $1, $2, 'active', 'lava', $3, now(),
           GREATEST(now(), COALESCE($5::timestamptz, now())) + make_interval(days => $4)
         )`,
        [
          found.id,
          plan.plan,
          event.contractId ?? event.paymentId,
          plan.durationDays,
          previousSubscription.rows[0]?.current_period_end?.toISOString() ?? null,
        ],
      );
      await client.query(
        `UPDATE payment_intents SET status = 'succeeded'
          WHERE provider = 'lava'
            AND (provider_contract_id = $1 OR user_id = $2)
            AND status = 'pending'`,
        [event.contractId, found.id],
      );
      return { state: "applied" as const, telegramId: Number(found.telegram_id) };
    });

    if (applied.state === "applied") {
      await this.telegram.sendMessage(
        applied.telegramId,
        `Оплата получена. Доступ по плану «${plan.plan}» активирован на ${plan.durationDays} дней.`,
      ).catch((error) => {
        this.logger.warn("Не удалось отправить подтверждение оплаты", {
          paymentId: event.paymentId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { ok: true, result: applied.state };
  }
}

export function normalizeLavaEvent(value: unknown): LavaEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lava webhook: ожидается JSON-объект");
  }
  const raw = value as Record<string, unknown>;
  const product = objectValue(raw.product);
  const buyer = objectValue(raw.buyer);
  const invoice = objectValue(raw.invoice);
  const metadata = objectValue(raw.metadata);
  const eventType = stringValue(raw.eventType ?? raw.event_type ?? raw.type);
  const productId = stringValue(product.id ?? raw.productId ?? raw.product_id);
  const paymentId = stringValue(
    raw.paymentId ??
      raw.payment_id ??
      invoice.id ??
      raw.invoiceId ??
      raw.invoice_id ??
      raw.contractId ??
      raw.contract_id ??
      invoice.contractId ??
      invoice.contract_id,
  );
  const contractId = nullableString(
    raw.contractId ?? raw.contract_id ?? invoice.contractId ?? invoice.contract_id,
  );
  const telegramIdRaw =
    metadata.telegram_id ?? metadata.telegramId ?? raw.telegram_id ?? raw.telegramId;
  const telegramId = telegramIdRaw == null ? null : Number(telegramIdRaw);
  const explicitMinor =
    raw.amountMinor ?? raw.amount_minor ?? invoice.amountMinor ?? invoice.amount_minor;
  const amountMinor = explicitMinor == null
    ? Math.round(Number(raw.amount ?? invoice.amount ?? 0) * 100)
    : Math.round(Number(explicitMinor));
  return {
    eventType,
    productId,
    paymentId,
    contractId,
    telegramId: Number.isSafeInteger(telegramId) ? telegramId : null,
    email: nullableString(buyer.email ?? raw.email),
    amountMinor,
    currency: stringValue(raw.currency ?? invoice.currency).toUpperCase(),
    status: stringValue(raw.status ?? invoice.status),
    raw,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function nullableString(value: unknown): string | null {
  const result = stringValue(value);
  return result || null;
}

function constantEquals(leftRaw: string, rightRaw: string): boolean {
  const left = Buffer.from(leftRaw);
  const right = Buffer.from(rightRaw);
  return left.length === right.length && timingSafeEqual(left, right);
}
