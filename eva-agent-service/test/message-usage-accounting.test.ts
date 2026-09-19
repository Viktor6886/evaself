import assert from "node:assert/strict";
import { test } from "node:test";

import { countInteractiveUserMessages } from "../dist/subscriptions/message-usage.js";
import { TelegramClient } from "../dist/telegram.js";

test("aggregated Telegram turn charges every physical user message once", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("UPDATE telegram_updates")) {
        return { rowCount: 2, rows: [{ update_id: "101" }, { update_id: "102" }] };
      }
      if (sql.includes("INSERT INTO usage_counters")) {
        return {
          rowCount: 3,
          rows: [
            { period: "day", used: "12" },
            { period: "week", used: "20" },
            { period: "month", used: "30" },
          ],
        };
      }
      throw new Error("unexpected query");
    },
  };
  const db = {
    withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work(),
    transaction: async (work: (value: typeof client) => Promise<unknown>) => await work(client),
  };

  const result = await countInteractiveUserMessages(
    db as never,
    7,
    [101, 102, 102],
  );

  assert.deepEqual(result, { charged: 2, dailyUsed: 12 });
  assert.deepEqual(calls[0]?.values, [7, [101, 102]]);
  assert.equal(calls[1]?.values[1], 2);
  assert.match(calls[0]?.sql ?? "", /AND NOT usage_charged/);
});

test("already charged Telegram updates do not consume quota twice", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("UPDATE telegram_updates")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT used")) return { rowCount: 1, rows: [{ used: "9" }] };
      throw new Error("unexpected query");
    },
  };
  const db = {
    withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work(),
    transaction: async (work: (value: typeof client) => Promise<unknown>) => await work(client),
  };

  const result = await countInteractiveUserMessages(db as never, 7, [101]);

  assert.deepEqual(result, { charged: 0, dailyUsed: 9 });
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO usage_counters")), false);
});

test("one logical automatic message is metered once even when Telegram splits it", async () => {
  const envelopes: Array<Record<string, unknown>> = [];
  const telegram = new TelegramClient(
    {
      telegramBotToken: "test-token",
      telegramApiBaseUrl: "https://api.telegram.invalid",
      telegramStickerCatalog: {},
    } as never,
    { debug() {}, info() {}, warn() {}, error() {} } as never,
  );
  telegram.setOutbox({
    send: async (envelope: Record<string, unknown>) => {
      envelopes.push(envelope);
      return { queued: true };
    },
  } as never);

  await telegram.withDeliveryContext(
    "task:42:123:result",
    async () => await telegram.sendMessage(100, "x ".repeat(5000)),
    "reminder",
    { userId: 7, metric: "messages_out" },
  );

  assert.ok(envelopes.length > 1, "длинный текст должен быть разбит на несколько Telegram-сообщений");
  assert.equal(envelopes[0]?.userId, 7);
  assert.equal(envelopes[0]?.usageMetric, "messages_out");
  assert.equal(envelopes[0]?.usageAmount, 1);
  for (const envelope of envelopes.slice(1)) {
    assert.equal(envelope.usageMetric, undefined);
    assert.equal(envelope.usageAmount, undefined);
  }
});
