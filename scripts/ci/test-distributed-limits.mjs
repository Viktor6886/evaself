import assert from "node:assert/strict";
import { Redis } from "../../eva-agent-service/node_modules/ioredis/built/index.js";

import { TelegramDeliveryLimiter } from "../../eva-agent-service/dist/delivery/telegram-limits.js";
import { ValkeyRouterLimits } from "../../eva-agent-service/dist/router/limits.js";

const redis = new Redis(process.env.VALKEY_TEST_URL ?? "redis://127.0.0.1:6379/15", {
  maxRetriesPerRequest: 1,
});

try {
  // GitHub creates a dedicated empty service for this job and database 15 is
  // reserved for this probe; clearing it makes reruns deterministic.
  await redis.flushdb();

  const first = new ValkeyRouterLimits(redis);
  const second = new ValkeyRouterLimits(redis);
  const base = {
    providerId: "ci-provider",
    model: "ci-model",
    route: "chat",
    limits: { max_rpm: null, max_tpm: null, max_concurrency: 1 },
    estimatedTokens: 100,
    reservationTtlMs: 1_000,
  };
  const held = await first.reserve({ ...base, reservationId: "held" });
  assert.equal(held.allowed, true);
  assert.deepEqual(
    await second.reserve({ ...base, reservationId: "blocked" }),
    { allowed: false, reason: "concurrency" },
  );

  // No release: emulate a killed worker. Lua must prune the expired lease.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const recovered = await second.reserve({ ...base, reservationId: "recovered" });
  assert.equal(recovered.allowed, true);
  if (recovered.allowed) {
    await recovered.reservation.settle(50);
    await recovered.reservation.release();
  }

  const telegramA = new TelegramDeliveryLimiter(redis, {
    globalPerSecond: 2, globalBurst: 2, chatPerSecond: 1, chatBurst: 1,
  });
  const telegramB = new TelegramDeliveryLimiter(redis, {
    globalPerSecond: 2, globalBurst: 2, chatPerSecond: 1, chatBurst: 1,
  });
  assert.equal(await telegramA.reserve(10), 0);
  assert.ok(await telegramB.reserve(10) > 0);
  assert.equal(await telegramB.reserve(20), 0);

  process.stdout.write("distributed limits: actual Valkey Lua passed\n");
} finally {
  await redis.quit();
}
