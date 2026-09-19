import assert from "node:assert/strict";
import test from "node:test";

import type { Database } from "../src/db.js";
import { recordMessageUsage } from "../src/subscriptions/usage-ledger.js";

test("message usage is idempotent by stable event key", async () => {
  const seen = new Set<string>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      const key = String(values[5]);
      const recorded = !seen.has(key);
      seen.add(key);
      return { rows: [{ recorded }], rowCount: 1 };
    },
  } as unknown as Database;

  const input = {
    userId: 42,
    metric: "messages" as const,
    source: "telegram_user",
    idempotencyKey: "telegram:update:1001:message",
    correlationId: "telegram-update:1001",
  };
  assert.equal(await recordMessageUsage(db, input), true);
  assert.equal(await recordMessageUsage(db, input), false);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.sql, /INSERT INTO usage_events/);
  assert.match(calls[0]!.sql, /INSERT INTO usage_counters/);
  assert.match(calls[0]!.sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
});

test("outbound automatic messages use the same accounting path", async () => {
  let captured: unknown[] = [];
  const db = {
    async query(_sql: string, values: unknown[]) {
      captured = values;
      return { rows: [{ recorded: true }], rowCount: 1 };
    },
  } as unknown as Database;

  const recorded = await recordMessageUsage(db, {
    userId: 7,
    metric: "messages_out",
    source: "scheduled_task",
    idempotencyKey: "task:9:1720000000000:result:usage",
    correlationId: "task:9:1720000000000",
    metadata: { slot: "result" },
  });

  assert.equal(recorded, true);
  assert.equal(captured[1], "messages_out");
  assert.equal(captured[2], "scheduled_task");
  assert.equal(captured[5], "task:9:1720000000000:result:usage");
});

test("invalid usage amount is rejected before SQL", async () => {
  const db = { async query() { throw new Error("must not query"); } } as unknown as Database;
  await assert.rejects(
    recordMessageUsage(db, {
      userId: 1,
      metric: "messages",
      source: "telegram_user",
      idempotencyKey: "bad",
      amount: 0,
    }),
    /amount/,
  );
});
