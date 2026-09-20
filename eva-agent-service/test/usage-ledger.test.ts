import assert from "node:assert/strict";
import test from "node:test";

import type { Database } from "../dist/db.js";
import {
  recordMessageUsage,
  recordMessageUsageBatch,
} from "../dist/subscriptions/usage-ledger.js";

interface LedgerEvent {
  user_id: number;
  metric: string;
  source: string;
  idempotency_key: string;
  amount: number;
}

function fakeLedgerDb(seen = new Set<string>()) {
  const calls: Array<{ sql: string; values: unknown[]; events: LedgerEvent[] }> = [];
  const scopes: Array<{ userId?: number; label?: string }> = [];
  const db = {
    async withUserScope<T>(
      scope: { userId?: number; label?: string },
      work: () => Promise<T>,
    ): Promise<T> {
      scopes.push(scope);
      return await work();
    },
    async query(sql: string, values: unknown[]) {
      const events = JSON.parse(String(values[0] ?? "[]")) as LedgerEvent[];
      calls.push({ sql, values, events });
      let recorded = 0;
      for (const event of events) {
        if (seen.has(event.idempotency_key)) continue;
        seen.add(event.idempotency_key);
        recorded += 1;
      }
      return { rows: [{ recorded: String(recorded) }], rowCount: 1 };
    },
  } as unknown as Database;
  return { db, calls, scopes };
}

test("message usage is idempotent by stable event key", async () => {
  const { db, calls } = fakeLedgerDb();
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

test("aggregated user messages are written in one atomic batch", async () => {
  const { db, calls } = fakeLedgerDb();
  const recorded = await recordMessageUsageBatch(db, [
    {
      userId: 42,
      metric: "messages",
      source: "telegram_user",
      idempotencyKey: "telegram:update:1001:message-in",
    },
    {
      userId: 42,
      metric: "messages",
      source: "telegram_user",
      idempotencyKey: "telegram:update:1002:message-in",
    },
  ]);

  assert.equal(recorded, 2);
  assert.equal(calls.length, 1, "batch расхода обязан быть одним SQL");
  assert.equal(calls[0]!.events.length, 2);
  assert.deepEqual(
    calls[0]!.events.map((event) => event.idempotency_key),
    ["telegram:update:1001:message-in", "telegram:update:1002:message-in"],
  );
});

test("outbound automatic messages use the same accounting path", async () => {
  const { db, calls, scopes } = fakeLedgerDb();
  const recorded = await recordMessageUsage(db, {
    userId: 7,
    metric: "messages_out",
    source: "scheduled_task",
    idempotencyKey: "task:9:1720000000000:result:usage",
    correlationId: "task:9:1720000000000",
    metadata: { slot: "result" },
  });

  assert.equal(recorded, true);
  const event = calls[0]!.events[0]!;
  assert.equal(event.metric, "messages_out");
  assert.equal(event.source, "scheduled_task");
  assert.equal(event.idempotency_key, "task:9:1720000000000:result:usage");
  assert.deepEqual(scopes, [{
    userId: 7,
    label: "subscriptions.usage_ledger",
  }], "фоновые сообщения обязаны входить в tenant scope владельца");
});

test("one usage batch cannot mix users", async () => {
  const { db } = fakeLedgerDb();
  await assert.rejects(
    recordMessageUsageBatch(db, [
      {
        userId: 1,
        metric: "messages",
        source: "telegram_user",
        idempotencyKey: "a",
      },
      {
        userId: 2,
        metric: "messages",
        source: "telegram_user",
        idempotencyKey: "b",
      },
    ]),
    /разных пользователей/u,
  );
});

test("invalid usage amount is rejected before SQL", async () => {
  const db = {
    async withUserScope<T>(_scope: unknown, work: () => Promise<T>): Promise<T> {
      return await work();
    },
    async query() { throw new Error("must not query"); },
  } as unknown as Database;
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
