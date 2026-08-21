/**
 * Состояние канонического контекста считается из базы, а не из памяти.
 *
 * Снимок в процессе отвечает только на вопрос «что делал этот процесс»:
 * после рестарта он пуст, и установка, где половина агентов осталась со
 * старым текстом, показывала `never` — то есть выглядела так же, как
 * чистая. Именно на это опирались `doctor`, `make update` и `rollback`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalContextHealth,
  canonicalStatusFrom,
} from "../dist/letta/canonical-health.js";

const counts = (overrides: Record<string, number> = {}) => ({
  version: "v1",
  total: 3,
  upToDate: 3,
  stale: 0,
  failed: 0,
  deferred: 0,
  unsupported: 0,
  never: 0,
  lastSyncAt: "2026-08-21T10:00:00.000Z",
  ...overrides,
});

test("health reports up-to-date only when every agent carries the current version", async () => {
  const health = await canonicalContextHealth(
    { canonicalContextHealth: async (version) => counts({ version } as never) },
    "v1",
  );
  assert.equal(health.status, "ok");
  assert.equal(health.version, "v1");
  assert.equal(health.agents.upToDate, 3);
  assert.equal(health.lastSyncAt, "2026-08-21T10:00:00.000Z");
});

test("an agent left on an older canonical version is stale, not ok", async () => {
  const health = await canonicalContextHealth(
    { canonicalContextHealth: async () => counts({ upToDate: 2, stale: 1, never: 1 }) },
    "v2",
  );
  assert.equal(health.status, "degraded");
  assert.equal(health.agents.stale, 1);
  assert.equal(health.agents.never, 1);
});

test("statuses distinguish stale, deferred, failed and unsupported", () => {
  assert.equal(canonicalStatusFrom({ total: 0, stale: 0, failed: 0, deferred: 0, unsupported: 0 }), "ok");
  assert.equal(canonicalStatusFrom({ total: 2, stale: 0, failed: 0, deferred: 0, unsupported: 0 }), "ok");
  assert.equal(canonicalStatusFrom({ total: 2, stale: 1, failed: 0, deferred: 0, unsupported: 0 }), "degraded");
  assert.equal(canonicalStatusFrom({ total: 2, stale: 0, failed: 0, deferred: 1, unsupported: 0 }), "degraded");
  assert.equal(canonicalStatusFrom({ total: 2, stale: 1, failed: 1, deferred: 0, unsupported: 0 }), "degraded");
  // Все агенты провалились: это не «частично деградировано», а отказ.
  assert.equal(canonicalStatusFrom({ total: 2, stale: 2, failed: 2, deferred: 0, unsupported: 0 }), "failed");
  assert.equal(canonicalStatusFrom({ total: 2, stale: 0, failed: 0, deferred: 0, unsupported: 1 }), "unsupported");
});

test("the process snapshot stays visible as diagnostics, not as the verdict", async () => {
  const health = await canonicalContextHealth(
    { canonicalContextHealth: async () => counts({ upToDate: 0, stale: 3, failed: 3 }) },
    "v3",
  );
  // Снимок процесса может утверждать что угодно: решает база.
  assert.equal(health.status, "failed");
  assert.equal(typeof health.process.status, "string");
  assert.equal(health.agents.failed, 3);
});
