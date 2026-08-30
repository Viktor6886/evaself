import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { AgentToolFactory, toolRisk } from "../dist/agent-tools.js";
import { Database } from "../dist/db.js";
import { grantPaidAccess } from "../dist/payments/grant.js";
import { SubscriptionExpiryNotifier } from "../dist/subscriptions/expiry-notifier.js";
import { QuotaExhaustionNotifier } from "../dist/subscriptions/quota-exhaustion-notifier.js";
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
        return { rows: [{
          id: "sub-old", plan: "plus", status: "active", source: "payment",
          current_period_end: end,
        }] };
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

  assert.deepEqual(outcome, { state: "applied", effectivePlan: "max" });
  const inserted = calls.find((call) => call.sql.includes("INSERT INTO subscriptions"));
  assert.equal(inserted?.values[1], "max");
  assert.equal(inserted?.values[3], 30);
  assert.equal(inserted?.values[4], end.toISOString(), "новые 30 дней считаются от старого конца");
  const snapshot = calls.find((call) => call.sql.includes("INSERT INTO subscription_quota_limits"));
  assert.equal(snapshot?.values[2], "messages");
  assert.ok(Number(snapshot?.values[4]) >= 175 && Number(snapshot?.values[4]) <= 176);
  const intentUpdate = calls.find((call) => call.sql.includes("UPDATE payment_intents SET status"));
  assert.equal(intentUpdate?.values[3], "intent-1", "закрывается только оплаченный intent");
  assert.equal(
    calls.some((call) => call.sql.includes("DELETE FROM usage_counters")),
    false,
    "платный апгрейд сохраняет уже учтённый расход",
  );
});

test("первая платная подписка начинает квоту заново", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-first" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-first" }] };
      return { rows: [] };
    },
  };

  const outcome = await grantPaidAccess(client as never, {
    userId: "7", provider: "telegram_stars", paymentId: "first-paid", raw: {},
  }, {
    plan: "plus", amountMinor: 1, durationDays: 7, currency: "XTR",
  }, { subscriptionLifecycleEnabled: true });

  assert.deepEqual(outcome, { state: "applied", effectivePlan: "plus" });
  const reset = calls.find((call) => call.sql.includes("DELETE FROM usage_counters"));
  assert.deepEqual(reset?.values, ["7"]);
});

test("fail-safe понижения сохраняет и имя, и квоты высокого тарифа", async () => {
  const end = new Date(Date.now() + 10 * 86_400_000);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-2" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-max", plan: "max", status: "active", source: "payment",
        current_period_end: end,
      }] };
      if (sql.includes("FROM quotas")) return { rows: [{
        metric: "messages", period: "day", limit_value: "200",
      }] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-safe" }] };
      return { rows: [] };
    },
  };
  await grantPaidAccess(client as never, {
    userId: "7", provider: "telegram_stars", paymentId: "paid-lower", raw: {},
  }, {
    plan: "plus", amountMinor: 100, durationDays: 30, currency: "XTR",
  }, { subscriptionLifecycleEnabled: true });

  const inserted = calls.find((call) => call.sql.includes("INSERT INTO subscriptions"));
  assert.equal(inserted?.values[1], "max");
  const targetQuota = calls.find((call) => call.sql.includes("FROM quotas WHERE plan"));
  assert.equal(targetQuota?.values[0], "max", "новые дни не получают пониженную квоту Plus");
  const snapshot = calls.find((call) => call.sql.includes("INSERT INTO subscription_quota_limits"));
  assert.equal(snapshot?.values[4], 200);
});

test("платный апгрейд не превращает прежний бессрочный тариф в новый бессрочный", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-indefinite" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-plus-forever", plan: "plus", status: "active", source: "payment",
        current_period_end: null,
      }] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-preserved" }] };
      return { rows: [] };
    },
  };

  const outcome = await grantPaidAccess(client as never, {
    userId: "7", provider: "telegram_stars", paymentId: "paid-max-month", raw: {},
  }, {
    plan: "max", amountMinor: 700, durationDays: 30, currency: "XTR",
  }, { subscriptionLifecycleEnabled: true });

  const inserted = calls.find((call) => call.sql.includes("INSERT INTO subscriptions"));
  assert.equal(inserted?.values[1], "plus", "старый бессрочный тариф сохраняется");
  assert.equal(inserted?.values[6], true, "срок остаётся бессрочным только у старого тарифа");
  assert.deepEqual(outcome, { state: "applied", effectivePlan: "plus" });
});

test("бессрочный fail-safe действует и при выключенном rollout-флаге", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-rollback" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-plus-forever", plan: "plus", status: "active", source: "payment",
        current_period_end: null,
      }] };
      if (sql.includes("INSERT INTO subscriptions")) return { rows: [{ id: "sub-rollback" }] };
      return { rows: [] };
    },
  };

  const outcome = await grantPaidAccess(client as never, {
    userId: "7", provider: "telegram_stars", paymentId: "rollback-paid-max", raw: {},
  }, {
    plan: "max", amountMinor: 700, durationDays: 30, currency: "XTR",
  }, { subscriptionLifecycleEnabled: false });

  const inserted = calls.find((call) => call.sql.includes("INSERT INTO subscriptions"));
  assert.equal(inserted?.values[1], "plus");
  assert.deepEqual(outcome, { state: "applied", effectivePlan: "plus" });
});

test("безлимит Max начинается после оплаченных конечных дней Plus", async () => {
  const end = new Date(Date.now() + 10 * 86_400_000);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO payments")) return { rows: [{ id: "pay-unlimited" }] };
      if (sql.includes("FROM subscriptions")) return { rows: [{
        id: "sub-plus", plan: "plus", status: "active", source: "payment",
        current_period_end: end,
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
        id: "sub-mixed", plan: "max", status: "active", source: "payment",
        current_period_end: currentEnd,
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
    userId: "7", provider: "telegram_stars", paymentId: "repeat-unlimited", raw: {},
  }, {
    plan: "max", amountMinor: 700, durationDays: 7, currency: "XTR",
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

test("инструмент статуса всегда доступен, не принимает владельца от модели и считается чтением", async () => {
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
    { vectorGoalsEnabled: false, subscriptionLifecycleEnabled: false } as never,
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

test("расход суток, недели и месяца пишет единые UTC-границы в одном запросе", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = new Database("postgres://unused");
  Object.assign(db, {
    poolView: {
      async query(sql: string, values: unknown[] = []) {
        statements.push({ sql, values });
        return { rows: [
          { period: "day", used: "1" },
          { period: "week", used: "1" },
          { period: "month", used: "1" },
        ] };
      },
    },
  });

  assert.equal(await db.incrementUsage(42, "messages"), 1);
  assert.equal(statements.length, 1, "три периода должны обновляться атомарно");
  assert.deepEqual(statements[0]?.values, [42, "messages", 1]);
  assert.match(statements[0]?.sql ?? "", /AT TIME ZONE 'UTC'/u);
  assert.match(statements[0]?.sql ?? "", /date_trunc\('month'/u);
  assert.doesNotMatch(statements[0]?.sql ?? "", /\$[456]/u, "локальные JS-даты больше не передаются");
});

const quotaMigration = "../postgres/migrations/075_quota_periods_utc.sql";
test("миграция нормализует поздние записи старого writer до переноса данных", {
  skip: !existsSync(quotaMigration) && "repository migrations are outside the service Docker build context",
}, () => {
  const migration = readFileSync(quotaMigration, "utf8");
  const trigger = migration.indexOf("CREATE TRIGGER normalize_usage_counter_period_start_trigger");
  const repair = migration.indexOf("WITH misplaced AS");
  assert.ok(trigger >= 0 && repair > trigger, "защита от гонки должна включиться до разового переноса");
  assert.match(migration, /BEFORE INSERT OR UPDATE OF period, period_start/u);
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
        warning_days: 1,
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
  assert.match(selectionSql, /min\(configured\.days\)/u);
});

test("трёхдневное предупреждение имеет отдельный durable key", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const end = new Date("2026-09-03T12:00:00Z");
  const notifier = new SubscriptionExpiryNotifier(
    {
      withSystemScope: async (_label: string, work: () => Promise<unknown>) => await work(),
      query: async (_sql: string, values: unknown[]) => {
        assert.deepEqual(values, [null, null, [3, 1]]);
        return { rows: [{
          subscription_id: "56", user_id: "7", chat_id: "42", plan: "plus",
          current_period_end: end, timezone: "UTC", language_mode: "fixed",
          preferred_language: "ru", last_message_language: null, language_code: "ru",
          warning_days: 3,
        }] };
      },
    } as never,
    { send: async (envelope: Record<string, unknown>) => { sent.push(envelope); } } as never,
    silentLogger,
    undefined,
    [3, 1],
  );

  await notifier.tick();
  assert.equal(sent[0]?.idempotencyKey, `subscription-expiry:56:${end.toISOString()}:3d`);
  assert.match(String((sent[0]?.payload as { text: string }).text), /через 3 дня/iu);
});

test("уведомитель проходит дальше первых ста подписок", async () => {
  const end = new Date("2026-08-30T12:00:00Z");
  let page = 0;
  let delivered = 0;
  const row = (id: number) => ({
    subscription_id: String(id), user_id: String(id), chat_id: String(id), plan: "plus",
    current_period_end: end, timezone: "UTC", language_mode: "fixed",
    preferred_language: "ru", last_message_language: null, language_code: "ru",
    warning_days: 1,
  });
  const notifier = new SubscriptionExpiryNotifier(
    {
      withSystemScope: async (_label: string, work: () => Promise<unknown>) => await work(),
      query: async (_sql: string, values: unknown[]) => {
        page += 1;
        if (page === 1) {
          assert.deepEqual(values, [null, null, [3, 1]]);
          return { rows: Array.from({ length: 100 }, (_, index) => row(index + 1)) };
        }
        assert.deepEqual(values, [end.toISOString(), "100", [3, 1]]);
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

test("исчерпанные периоды сообщений объединяются в одно durable-уведомление", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const notifier = new QuotaExhaustionNotifier(
    {
      withUserScope: async (scope: unknown, work: () => Promise<unknown>) => {
        assert.deepEqual(scope, {
          telegramId: 42, label: "subscriptions.quota_exhaustion", inherit: true,
        });
        return await work();
      },
      query: async (sql: string, values: unknown[]) => {
        assert.deepEqual(values, [42]);
        assert.match(sql, /q\.metric = 'messages'/u);
        assert.match(sql, /q\.remaining <= 0/u);
        return { rows: [
          {
            user_id: "7", chat_id: "42", period: "day", period_start: "2026-08-30",
            language_mode: "fixed", preferred_language: "ru",
            last_message_language: null, language_code: "ru",
          },
          {
            user_id: "7", chat_id: "42", period: "week", period_start: "2026-08-24",
            language_mode: "fixed", preferred_language: "ru",
            last_message_language: null, language_code: "ru",
          },
        ] };
      },
    } as never,
    { send: async (envelope: Record<string, unknown>) => { sent.push(envelope); } } as never,
    silentLogger,
  );

  await notifier.notifyMessages(42);
  await notifier.notifyMessages(42);
  assert.equal(sent.length, 2, "outbox принимает повтор и дедуплицирует его по тому же ключу");
  assert.equal(
    sent[0]?.idempotencyKey,
    "quota-exhausted:7:messages:day:2026-08-30+week:2026-08-24",
  );
  assert.equal(sent[0]?.chatId, 42, "уведомление идёт в личный Telegram ID");
  const text = String((sent[0]?.payload as { text: string }).text);
  assert.match(text, /за сутки/iu);
  assert.match(text, /за неделю/iu);
});
