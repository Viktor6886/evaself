import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentToolFactory, toolRisk } from "../dist/agent-tools.js";
import { grantPaidAccess } from "../dist/payments/grant.js";
import { SubscriptionExpiryNotifier } from "../dist/subscriptions/expiry-notifier.js";
import { SubscriptionStatusService } from "../dist/subscriptions/status-service.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test("Plus → Max складывает срок и взвешивает суточную квоту", async () => {
  const end = new Date(Date.now() + 10 * 86_400_000);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-1" }] };
      if (sql.includes("FROM subscriptions")) {
        return { rows: [{ id: "sub-old", plan: "plus", status: "active", current_period_end: end }] };
      }
      if (sql.includes("COALESCE(sq.limit_value")) {
        return { rows: [{ metric: "messages", period: "day", limit_value: "100" }] };
      }
      if (sql.includes("FROM quotas WHERE plan")) {
        return { rows: [{ metric: "messages", period: "day", limit_value: "200" }] };
      }
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-new" }] };
      return { rows: [] };
    },
  };

  const outcome = await grantPaidAccess(client as never, {
    userId: "7",
    provider: "telegram_stars",
    paymentId: "charge-upgrade",
    contractId: "intent-1",
    intentId: "intent-1",
    raw: {},
  }, {
    plan: "max", amountMinor: 700, durationDays: 30, currency: "XTR",
  }, { subscriptionLifecycleEnabled: true });

  assert.equal(outcome, "applied");
  const inserted = calls.find((call) => call.sql.includes("INSERT INTO subscriptions"));
  assert.equal(inserted?.values[1], "max");
  assert.equal(inserted?.values[3], 30);
  assert.equal(inserted?.values[4], end.toISOString(), "новые 30 дней считаются от старого конца");
  const snapshot = calls.find((call) => call.sql.includes("INSERT INTO subscription_quota_limits"));
  assert.equal(snapshot?.values[2], "messages");
  assert.ok(Number(snapshot?.values[4]) >= 175 && Number(snapshot?.values[4]) <= 176);
  const intentUpdate = calls.find((call) => call.sql.includes("UPDATE payment_intents SET status"));
  assert.equal(intentUpdate?.values[3], "intent-1", "закрывается только оплаченный intent");
});

test("fail-safe понижения сохраняет и имя, и квоты высокого тарифа", async () => {
  const end = new Date(Date.now() + 10 * 86_400_000);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-2" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-max", plan: "max", status: "active", current_period_end: end,
      }] };
      if (sql.includes("FROM quotas")) return { rows: [{
        metric: "messages", period: "day", limit_value: "200",
      }] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-safe" }] };
      return { rows: [] };
    },
  };
  await grantPaidAccess(client as never, {
    userId: "7", provider: "lava", paymentId: "paid-lower", raw: {},
  }, {
    plan: "plus", amountMinor: 100, durationDays: 30, currency: "RUB",
  }, { subscriptionLifecycleEnabled: true });

  const inserted = calls.find((call) => call.sql.includes("INSERT INTO subscriptions"));
  assert.equal(inserted?.values[1], "max");
  const targetQuota = calls.find((call) => call.sql.includes("FROM quotas WHERE plan"));
  assert.equal(targetQuota?.values[0], "max", "новые дни не получают пониженную квоту Plus");
  const snapshot = calls.find((call) => call.sql.includes("INSERT INTO subscription_quota_limits"));
  assert.equal(snapshot?.values[4], 200);
});

test("безлимит Max начинается после оплаченных конечных дней Plus", async () => {
  const end = new Date(Date.now() + 10 * 86_400_000);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-unlimited" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-plus", plan: "plus", status: "active", current_period_end: end,
      }] };
      if (sql.includes("COALESCE(sq.limit_value")) return { rows: [{
        metric: "messages", period: "day", limit_value: "200",
      }] };
      if (sql.includes("FROM quotas WHERE plan")) return { rows: [{
        metric: "messages", period: "day", limit_value: "-1",
      }] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-max" }] };
      return { rows: [] };
    },
  };
  await grantPaidAccess(client as never, {
    userId: "7", provider: "telegram_stars", paymentId: "upgrade-unlimited", raw: {},
  }, {
    plan: "max", amountMinor: 700, durationDays: 7, currency: "XTR",
  }, { subscriptionLifecycleEnabled: true });

  const snapshot = calls.find((call) => call.sql.includes("INSERT INTO subscription_quota_limits"));
  assert.equal(snapshot?.values[4], 200, "старые дни Plus остаются конечными");
  assert.equal(snapshot?.values[5], end.toISOString(), "безлимит включается с начала купленных дней Max");
});

test("повторный платёж не отодвигает уже купленную дату безлимита", async () => {
  const unlimitedFrom = new Date(Date.now() + 5 * 86_400_000);
  const currentEnd = new Date(Date.now() + 12 * 86_400_000);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-repeat" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-mixed", plan: "max", status: "active", current_period_end: currentEnd,
      }] };
      if (sql.includes("COALESCE(sq.limit_value")) return { rows: [{
        metric: "messages", period: "day", limit_value: "200", unlimited_from: unlimitedFrom,
      }] };
      if (sql.includes("FROM quotas WHERE plan")) return { rows: [{
        metric: "messages", period: "day", limit_value: "-1",
      }] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-extended" }] };
      return { rows: [] };
    },
  };
  await grantPaidAccess(client as never, {
    userId: "7", provider: "lava", paymentId: "repeat-unlimited", raw: {},
  }, {
    plan: "max", amountMinor: 700, durationDays: 7, currency: "RUB",
  }, { subscriptionLifecycleEnabled: true });

  const snapshot = calls.find((call) => call.sql.includes("INSERT INTO subscription_quota_limits"));
  assert.equal(snapshot?.values[5], unlimitedFrom.toISOString());
});

test("статус подписки возвращает только read-only снимок текущего пользователя", async () => {
  const values: unknown[][] = [];
  const db = {
    withUserScope: async (scope: unknown, work: () => Promise<unknown>) => {
      assert.deepEqual(scope, { userId: 7, label: "subscriptions.status" });
      return await work();
    },
    async query(sql: string, params: unknown[]) {
      values.push(params);
      if (sql.includes("FROM subscriptions")) return { rows: [{
        plan: "max", status: "active", source: "payment", provider: "telegram_stars",
        current_period_start: new Date("2026-08-01T00:00:00Z"),
        current_period_end: new Date(Date.now() + 3 * 86_400_000),
      }] };
      if (sql.includes("FROM v_quota_status")) return { rows: [{
        metric: "messages", period: "day", limit_value: "200", used: "25", remaining: "175",
      }] };
      return { rows: [{ period: "day", limit_value: "20", used: "20", remaining: "0" }] };
    },
  };
  const status = await new SubscriptionStatusService(db as never).get(7);
  assert.equal(status.read_only, true);
  assert.equal(status.subscription?.plan, "max");
  assert.equal(status.subscription?.days_remaining, 3);
  assert.equal(status.quotas[0]?.remaining, 175);
  assert.equal(status.free_messages?.remaining, 0);
  assert.deepEqual(values, [[7], [7], [7]], "все чтения привязаны к владельцу conversation");
  assert.equal("update" in status, false);
});

test("инструмент статуса не принимает владельца от модели и считается чтением", async () => {
  const queried: unknown[][] = [];
  const db = {
    getAgentRuntimeContext: async () => ({
      userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-status",
      purpose: "chat", timezone: "UTC", responseMode: "text", useEmoji: true,
    }),
    withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work(),
    async query(sql: string, params: unknown[]) {
      queried.push(params);
      if (sql.includes("FROM subscriptions")) return { rows: [] };
      if (sql.includes("FROM v_quota_status")) return { rows: [] };
      return { rows: [] };
    },
  };
  const factory = new AgentToolFactory(
    { vectorGoalsEnabled: false, subscriptionLifecycleEnabled: true } as never,
    db as never,
    {} as never,
    silentLogger,
  );
  const tool = factory.forConversation("conv-status")
    .find((candidate) => candidate.name === "get_subscription_status");
  assert.ok(tool);
  const result = await tool.execute("call-status", { user_id: 999 });
  assert.equal((result.details as { read_only?: boolean }).read_only, true);
  assert.deepEqual(queried, [[7], [7], [7]]);
  assert.equal(toolRisk("get_subscription_status"), "read");
});

test("уведомление за сутки идёт через durable outbox с одним ключом", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let selectionSql = "";
  const end = new Date("2026-08-30T12:00:00Z");
  const notifier = new SubscriptionExpiryNotifier(
    {
      withSystemScope: async (_label: string, work: () => Promise<unknown>, options: unknown) => {
        assert.deepEqual(options, { crossUser: true });
        return await work();
      },
      query: async (sql: string) => {
        selectionSql = sql;
        return { rows: [{
        subscription_id: "55", user_id: "7", chat_id: "42", plan: "max",
        current_period_end: end, timezone: "UTC", language_mode: "fixed",
        preferred_language: "ru", last_message_language: null, language_code: "ru",
        }] };
      },
    } as never,
    { send: async (envelope: Record<string, unknown>) => { sent.push(envelope); } } as never,
    silentLogger,
  );

  await notifier.tick();
  await notifier.tick();
  assert.equal(sent.length, 2, "повторы допустимы на входе: дедупликацию гарантирует outbox");
  assert.equal(sent[0]?.idempotencyKey, `subscription-expiry:55:${end.toISOString()}`);
  assert.equal(sent[1]?.idempotencyKey, `subscription-expiry:55:${end.toISOString()}`);
  assert.match(String((sent[0]?.payload as { text: string }).text), /закончится/iu);
  assert.match(selectionSql, /u\.telegram_id::text AS chat_id/u);
  assert.doesNotMatch(selectionSql, /FROM telegram_updates/u);
});

test("уведомитель проходит дальше первых ста подписок", async () => {
  const end = new Date("2026-08-30T12:00:00Z");
  let page = 0;
  let delivered = 0;
  const row = (id: number) => ({
    subscription_id: String(id), user_id: String(id), chat_id: String(id), plan: "plus",
    current_period_end: end, timezone: "UTC", language_mode: "fixed",
    preferred_language: "ru", last_message_language: null, language_code: "ru",
  });
  const notifier = new SubscriptionExpiryNotifier(
    {
      withSystemScope: async (_label: string, work: () => Promise<unknown>) => await work(),
      query: async (_sql: string, values: unknown[]) => {
        page += 1;
        if (page === 1) {
          assert.deepEqual(values, [null, null]);
          return { rows: Array.from({ length: 100 }, (_, index) => row(index + 1)) };
        }
        assert.deepEqual(values, [end.toISOString(), "100"]);
        return { rows: [row(101)] };
      },
    } as never,
    { send: async () => { delivered += 1; } } as never,
    silentLogger,
  );
  await notifier.tick();
  assert.equal(page, 2);
  assert.equal(delivered, 101);
});
