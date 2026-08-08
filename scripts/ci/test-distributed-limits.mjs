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

  const rpmBase = {
    providerId: "ci-provider-rpm",
    model: "ci-model-rpm",
    route: "fast",
    limits: { max_rpm: 1, max_tpm: null, max_concurrency: 10 },
    estimatedTokens: 10,
    reservationTtlMs: 5_000,
  };
  const rpmHeld = await first.reserve({ ...rpmBase, reservationId: "rpm-held" });
  assert.equal(rpmHeld.allowed, true);
  if (rpmHeld.allowed) await rpmHeld.reservation.release();
  assert.deepEqual(
    await second.reserve({ ...rpmBase, reservationId: "rpm-blocked" }),
    { allowed: false, reason: "rpm" },
  );

  const tpmBase = {
    providerId: "ci-provider-tpm",
    model: "ci-model-tpm",
    route: "deep",
    limits: { max_rpm: null, max_tpm: 150, max_concurrency: 10 },
    estimatedTokens: 100,
    reservationTtlMs: 5_000,
  };
  const tpmHeld = await first.reserve({ ...tpmBase, reservationId: "tpm-held" });
  assert.equal(tpmHeld.allowed, true);
  if (tpmHeld.allowed) {
    await tpmHeld.reservation.settle(120);
    await tpmHeld.reservation.release();
  }
  assert.deepEqual(
    await second.reserve({ ...tpmBase, reservationId: "tpm-blocked", estimatedTokens: 40 }),
    { allowed: false, reason: "tpm" },
  );

  const routeA = new ValkeyRouterLimits(redis, {
    max_rpm: 100, max_tpm: 100_000, max_concurrency: 2,
  });
  const routeB = new ValkeyRouterLimits(redis, {
    max_rpm: 100, max_tpm: 100_000, max_concurrency: 2,
  });
  const routeBase = {
    model: "ci-shared-model",
    route: "ci-route-consistency",
    limits: { max_rpm: 1, max_tpm: 100, max_concurrency: 1 },
    estimatedTokens: 10,
    reservationTtlMs: 5_000,
  };
  const routePrimary = await routeA.reserve({
    ...routeBase, providerId: "ci-route-primary", reservationId: "route-primary",
  });
  const routeFallback = await routeB.reserve({
    ...routeBase, providerId: "ci-route-fallback", reservationId: "route-fallback",
  });
  assert.equal(routePrimary.allowed, true);
  assert.equal(routeFallback.allowed, true);
  assert.deepEqual(
    await routeB.reserve({
      ...routeBase, providerId: "ci-route-third", reservationId: "route-third",
    }),
    { allowed: false, reason: "concurrency" },
  );
  if (routePrimary.allowed) await routePrimary.reservation.release();
  if (routeFallback.allowed) await routeFallback.reservation.release();

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
