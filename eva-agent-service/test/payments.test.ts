/**
 * The Lava webhook is the only path in Evaself that grants paid access, so
 * the interesting cases are the ones where it must NOT grant it: a replayed
 * payment, an amount that does not match the configured plan, a product the
 * installation does not sell.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LavaPayments } from "../dist/payments.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const PLANS = {
  "prod-plus": { plan: "plus", durationDays: 30, amountMinor: 49900, currency: "RUB" },
};

interface FakeOptions {
  /** null means "no user matches the webhook" */
  user?: { id: string; telegram_id: string } | null;
  /** false means the payment insert hit the idempotency conflict */
  paymentInserted?: boolean;
  previousPeriodEnd?: Date | null;
}

function harness(options: FakeOptions = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const sent: Array<{ chatId: number; text: string }> = [];

  const client = {
    query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, telegram_id FROM users")) {
        const user = options.user === undefined
          ? { id: "3", telegram_id: "42" }
          : options.user;
        return Promise.resolve({ rows: user ? [user] : [] });
      }
      if (normalized.startsWith("INSERT INTO payments")) {
        return Promise.resolve({
          rows: options.paymentInserted === false ? [] : [{ id: "9" }],
        });
      }
      if (normalized.startsWith("SELECT current_period_end")) {
        return Promise.resolve({
          rows: options.previousPeriodEnd === undefined
            ? []
            : [{ current_period_end: options.previousPeriodEnd }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };

  const db = {
    transaction<T>(work: (c: typeof client) => Promise<T>) {
      return work(client);
    },
  };
  const telegram = {
    // The confirmation is sent inside a delivery context so the outbox can
    // deduplicate it; the fake just runs the callback.
    withDeliveryContext: <T,>(_key: string, work: () => Promise<T>) => work(),
    sendMessage(chatId: number, text: string) {
      sent.push({ chatId, text });
      return Promise.resolve([]);
    },
  };
  const payments = new LavaPayments(
    { lavaWebhookUser: "eva", lavaWebhookPassword: "s3cret", lavaPlans: PLANS } as never,
    db as never,
    telegram as never,
    silentLogger,
  );
  return { payments, statements, sent };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "payment.success",
    paymentId: "pay-1",
    contractId: "contract-1",
    status: "completed",
    currency: "RUB",
    amount: 499,
    product: { id: "prod-plus" },
    buyer: { email: "user@example.test" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------
test("basic auth accepts only the configured credentials", () => {
  const { payments } = harness();
  const header = (raw: string) => `Basic ${Buffer.from(raw).toString("base64")}`;
  assert.equal(payments.authorized(header("eva:s3cret")), true);
  assert.equal(payments.authorized(header("eva:wrong")), false);
  assert.equal(payments.authorized(header("mallory:s3cret")), false);
  assert.equal(payments.authorized(header("eva:s3cret ")), false);
  assert.equal(payments.authorized("Bearer s3cret"), false);
  assert.equal(payments.authorized(undefined), false);
});

test("authorization fails closed when Lava is not configured", () => {
  const payments = new LavaPayments(
    { lavaWebhookUser: "", lavaWebhookPassword: "", lavaPlans: {} } as never,
    {} as never,
    {} as never,
    silentLogger,
  );
  const header = `Basic ${Buffer.from(":").toString("base64")}`;
  assert.equal(payments.authorized(header), false);
});

// ---------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------
test("a matching payment activates the subscription and confirms it", async () => {
  const { payments, statements, sent } = harness();
  const result = await payments.handle(event());

  assert.deepEqual(result, { ok: true, result: "applied" });
  const sql = statements.map((s) => s.sql.replace(/\s+/g, " ").trim());
  assert.ok(sql.some((s) => s.startsWith("INSERT INTO payments")));
  assert.ok(sql.some((s) => s.startsWith("UPDATE subscriptions SET status = 'expired'")));
  assert.ok(sql.some((s) => s.startsWith("INSERT INTO subscriptions")));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /plus/);
});

test("remaining time on the previous subscription is carried over", async () => {
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const { payments, statements } = harness({ previousPeriodEnd: future });
  await payments.handle(event());
  const insert = statements.find((s) => s.sql.includes("INSERT INTO subscriptions"));
  assert.ok(insert);
  // The new period starts from GREATEST(now(), previous end), so the value
  // has to reach the statement rather than being silently dropped.
  assert.equal(insert.values[4], future.toISOString());
});

// ---------------------------------------------------------------------
// everything that must not grant access
// ---------------------------------------------------------------------
test("a replayed payment id is ignored, not applied twice", async () => {
  const { payments, statements, sent } = harness({ paymentInserted: false });
  const result = await payments.handle(event());

  assert.deepEqual(result, { ok: true, result: "duplicate" });
  const sql = statements.map((s) => s.sql.replace(/\s+/g, " ").trim());
  assert.ok(
    !sql.some((s) => s.startsWith("INSERT INTO subscriptions")),
    "a duplicate webhook must not create a second subscription",
  );
  assert.equal(sent.length, 0);
});

test("an amount that does not match the plan is refused", async () => {
  const { payments, statements } = harness();
  const result = await payments.handle(event({ amount: 1 }));
  assert.deepEqual(result, { ok: true, ignored: "amount_or_currency_mismatch" });
  assert.equal(statements.length, 0);
});

test("a currency that does not match the plan is refused", async () => {
  const { payments } = harness();
  const result = await payments.handle(event({ currency: "USD" }));
  assert.deepEqual(result, { ok: true, ignored: "amount_or_currency_mismatch" });
});

test("an unknown product is refused", async () => {
  const { payments } = harness();
  assert.deepEqual(
    await payments.handle(event({ product: { id: "prod-unknown" } })),
    { ok: true, ignored: "unknown_product" },
  );
});

test("a non-success event type or status is refused", async () => {
  const { payments } = harness();
  assert.deepEqual(
    await payments.handle(event({ eventType: "payment.failed" })),
    { ok: true, ignored: "event_type" },
  );
  assert.deepEqual(
    await payments.handle(event({ status: "pending" })),
    { ok: true, ignored: "payment_status" },
  );
});

test("a webhook without a payment id is refused", async () => {
  const { payments } = harness();
  assert.deepEqual(
    await payments.handle({ eventType: "payment.success", product: { id: "prod-plus" } }),
    { ok: true, ignored: "missing_payment_id" },
  );
});

test("a payment for an unknown user grants nothing", async () => {
  const { payments, statements, sent } = harness({ user: null });
  assert.deepEqual(await payments.handle(event()), { ok: true, result: "user_not_found" });
  const sql = statements.map((s) => s.sql.replace(/\s+/g, " ").trim());
  assert.ok(!sql.some((s) => s.startsWith("INSERT INTO subscriptions")));
  assert.equal(sent.length, 0);
});

test("a malformed plan configuration is refused rather than guessed at", async () => {
  const payments = new LavaPayments(
    {
      lavaWebhookUser: "eva",
      lavaWebhookPassword: "s3cret",
      lavaPlans: { "prod-plus": { plan: "plus", durationDays: 0, amountMinor: 49900, currency: "RUB" } },
    } as never,
    {} as never,
    {} as never,
    silentLogger,
  );
  assert.deepEqual(
    await payments.handle(event()),
    { ok: true, ignored: "invalid_plan_configuration" },
  );
});

test("a webhook body that is not an object is rejected", async () => {
  const { payments } = harness();
  await assert.rejects(() => payments.handle("nope"));
  await assert.rejects(() => payments.handle([1, 2, 3]));
});

test("a failure to confirm over Telegram does not undo the subscription", async () => {
  const { payments } = harness();
  // Replace the client with one that always fails after the fact.
  const broken = new LavaPayments(
    { lavaWebhookUser: "eva", lavaWebhookPassword: "s3cret", lavaPlans: PLANS } as never,
    { transaction: <T,>(work: (c: unknown) => Promise<T>) => work({
      query(sql: string) {
        if (sql.replace(/\s+/g, " ").includes("SELECT id, telegram_id FROM users")) {
          return Promise.resolve({ rows: [{ id: "3", telegram_id: "42" }] });
        }
        if (sql.includes("INSERT INTO payments")) return Promise.resolve({ rows: [{ id: "9" }] });
        return Promise.resolve({ rows: [] });
      },
    }) } as never,
    {
      withDeliveryContext: <T,>(_key: string, work: () => Promise<T>) => work(),
      sendMessage: () => Promise.reject(new Error("telegram is down")),
    } as never,
    silentLogger,
  );
  assert.deepEqual(await broken.handle(event()), { ok: true, result: "applied" });
  assert.ok(payments);
});
