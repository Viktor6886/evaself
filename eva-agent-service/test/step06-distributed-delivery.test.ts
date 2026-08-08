import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresTelegramOutbox } from "../dist/delivery/outbox.js";
import { TelegramDeliveryLimiter } from "../dist/delivery/telegram-limits.js";
import { ValkeyRouterLimits } from "../dist/router/limits.js";
import { parseRetryAfter as parseProviderRetryAfter } from "../dist/router/adapters/shared.js";
import { parseRetryAfter as parseTelegramRetryAfter } from "../dist/telegram.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeRouterRedis {
  dimensions = new Map();
  keys = [];

  async eval(script, numberOfKeys, ...args) {
    const keys = args.slice(0, numberOfKeys).map(String);
    const argv = args.slice(numberOfKeys);
    this.keys.push(...keys);
    if (numberOfKeys === 9) {
      const [nowRaw, estimatedRaw, rpmRaw, tpmRaw, concurrencyRaw, reservation, ttlRaw] = argv;
      const now = Number(nowRaw);
      const estimated = Number(estimatedRaw);
      const rpm = Number(rpmRaw);
      const tpm = Number(tpmRaw);
      const concurrency = Number(concurrencyRaw);
      const ttl = Number(ttlRaw);
      const states = [0, 3, 6].map((offset) => {
        const key = keys[offset];
        let state = this.dimensions.get(key);
        if (!state) {
          state = { requests: new Map(), inflight: new Map() };
          this.dimensions.set(key, state);
        }
        for (const [id, row] of state.requests) {
          if (row.at <= now - 60_000) state.requests.delete(id);
        }
        for (const [id, expires] of state.inflight) {
          if (expires <= now) state.inflight.delete(id);
        }
        return state;
      });
      for (const state of states) {
        if (state.inflight.size >= concurrency) return "concurrency";
        if (rpm >= 0 && state.requests.size >= rpm) return "rpm";
        const used = [...state.requests.values()].reduce((sum, row) => sum + row.tokens, 0);
        if (tpm >= 0 && used + estimated > tpm) return "tpm";
      }
      for (const state of states) {
        state.requests.set(String(reservation), { at: now, tokens: estimated });
        state.inflight.set(String(reservation), now + ttl);
      }
      return "ok";
    }
    if (numberOfKeys === 3 && script.includes("ZREM")) {
      for (const key of keys) this.dimensions.get(key.replace(/:inflight$/, ":requests"))
        ?.inflight.delete(String(argv[0]));
      return 1;
    }
    if (numberOfKeys === 6 && script.includes("HSET")) {
      for (let index = 0; index < keys.length; index += 2) {
        const state = this.dimensions.get(keys[index]);
        const row = state?.requests.get(String(argv[0]));
        if (row) row.tokens = Number(argv[1]);
      }
      return 1;
    }
    throw new Error("unexpected script");
  }
}

test("two Router replicas share atomic concurrency and crash TTL", async () => {
  const redis = new FakeRouterRedis();
  const first = new ValkeyRouterLimits(redis);
  const second = new ValkeyRouterLimits(redis);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const input = {
    providerId: "provider-a",
    model: "model-a",
    route: "chat",
    limits: { max_rpm: null, max_tpm: null, max_concurrency: 1 },
    estimatedTokens: 100,
    reservationTtlMs: 5_000,
  };
  try {
    const reserved = await first.reserve({ ...input, reservationId: "replica-1" });
    assert.equal(reserved.allowed, true);
    assert.deepEqual(
      await second.reserve({ ...input, reservationId: "replica-2" }),
      { allowed: false, reason: "concurrency" },
    );
    assert.ok(redis.keys.some((key) => key.includes(":provider:")));
    assert.ok(redis.keys.some((key) => key.includes(":model:")));
    assert.ok(redis.keys.some((key) => key.includes(":route:")));

    // Simulate a crashed worker: it never calls release. The lease expiry
    // alone must make the slot recoverable by another replica.
    now += 5_001;
    const afterCrash = await second.reserve({ ...input, reservationId: "replica-3" });
    assert.equal(afterCrash.allowed, true);
    if (afterCrash.allowed) await afterCrash.reservation.release();
  } finally {
    Date.now = originalNow;
  }
});

test("two Router replicas share RPM and settled TPM across every dimension", async () => {
  const redis = new FakeRouterRedis();
  const first = new ValkeyRouterLimits(redis);
  const second = new ValkeyRouterLimits(redis);
  const rpmInput = {
    providerId: "provider-rpm",
    model: "model-rpm",
    route: "fast",
    limits: { max_rpm: 1, max_tpm: null, max_concurrency: 10 },
    estimatedTokens: 10,
    reservationTtlMs: 5_000,
  };
  const rpmHeld = await first.reserve({ ...rpmInput, reservationId: "rpm-1" });
  assert.equal(rpmHeld.allowed, true);
  if (rpmHeld.allowed) await rpmHeld.reservation.release();
  assert.deepEqual(
    await second.reserve({ ...rpmInput, reservationId: "rpm-2" }),
    { allowed: false, reason: "rpm" },
  );

  const tpmInput = {
    providerId: "provider-tpm",
    model: "model-tpm",
    route: "deep",
    limits: { max_rpm: null, max_tpm: 150, max_concurrency: 10 },
    estimatedTokens: 100,
    reservationTtlMs: 5_000,
  };
  const tpmHeld = await first.reserve({ ...tpmInput, reservationId: "tpm-1" });
  assert.equal(tpmHeld.allowed, true);
  if (tpmHeld.allowed) {
    await tpmHeld.reservation.settle(120);
    await tpmHeld.reservation.release();
  }
  assert.deepEqual(
    await second.reserve({ ...tpmInput, reservationId: "tpm-2", estimatedTokens: 40 }),
    { allowed: false, reason: "tpm" },
  );
});

class FakeTelegramRedis {
  buckets = new Map();
  cooldowns = new Map();

  async eval(_script, numberOfKeys, ...args) {
    assert.equal(numberOfKeys, 4);
    const keys = args.slice(0, 4).map(String);
    const [nowRaw, globalRateRaw, globalBurstRaw, chatRateRaw, chatBurstRaw] = args.slice(4);
    const now = Number(nowRaw);
    const cooldown = Math.max(...keys.slice(2).map((key) => (this.cooldowns.get(key) ?? 0) - now));
    if (cooldown > 0) return cooldown;
    const configs = [[keys[0], Number(globalRateRaw), Number(globalBurstRaw)],
      [keys[1], Number(chatRateRaw), Number(chatBurstRaw)]];
    const states = configs.map(([key, rate, burst]) => {
      const previous = this.buckets.get(key) ?? { tokens: burst, updated: now };
      const tokens = Math.min(burst, previous.tokens + Math.max(0, now - previous.updated) / 1000 * rate);
      return { key, rate, burst, tokens };
    });
    const waits = states.map((state) => state.tokens < 1
      ? Math.ceil((1 - state.tokens) / state.rate * 1000) : 0);
    if (Math.max(...waits) > 0) return Math.max(...waits);
    for (const state of states) this.buckets.set(state.key, { tokens: state.tokens - 1, updated: now });
    return 0;
  }

  async set(key, _value, _px, ttl) {
    this.cooldowns.set(String(key), Date.now() + Number(ttl));
    return "OK";
  }
}

test("Telegram global and per-chat token buckets are shared", async () => {
  const redis = new FakeTelegramRedis();
  const a = new TelegramDeliveryLimiter(redis, {
    globalPerSecond: 2, globalBurst: 2, chatPerSecond: 1, chatBurst: 1,
  });
  const b = new TelegramDeliveryLimiter(redis, {
    globalPerSecond: 2, globalBurst: 2, chatPerSecond: 1, chatBurst: 1,
  });
  const now = 5_000;
  assert.equal(await a.reserve(10, now), 0);
  assert.ok(await b.reserve(10, now) >= 1_000, "same chat exceeded one message/second");
  assert.equal(await b.reserve(20, now), 0, "another chat can use remaining global capacity");
});

test("Retry-After accepts seconds and HTTP-date", () => {
  const now = Date.parse("2026-08-08T10:00:00Z");
  assert.equal(parseProviderRetryAfter("2.5", now), 2_500);
  assert.equal(parseTelegramRetryAfter("2", now), 2_000);
  assert.equal(
    parseProviderRetryAfter("Sat, 08 Aug 2026 10:00:03 GMT", now),
    3_000,
  );
});

test("outbox persists the five required priority groups", async () => {
  const priorities = [];
  let nextId = 0;
  const db = {
    withSystemScope: async (_label, work) => await work(),
    query: async (_sql, values) => {
      priorities.push(Number(values[5]));
      nextId += 1;
      return { rows: [{ id: String(nextId), status: "pending" }] };
    },
  };
  const outbox = new PostgresTelegramOutbox(
    db,
    { deliver: async () => ({ message_id: 1 }) },
    logger,
    { pollMs: 10_000, leaseSeconds: 120, maxAttempts: 8,
      parallel: { concurrency: 1, limits: null } },
  );
  for (const priority of [
    "crisis", "reply", "command", "reminder", "status",
  ]) {
    await outbox.send({
      method: "sendMessage", chatId: 1, payload: {}, priority,
    });
  }
  assert.deepEqual(priorities, [10, 20, 30, 40, 50]);
});
