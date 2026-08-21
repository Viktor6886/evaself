import assert from "node:assert/strict";
import test from "node:test";

import { PersonaSync, canonicalMemoryVersion, personaSyncState } from "../dist/letta/persona-sync.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function db(overrides: Record<string, unknown> = {}) {
  return {
    listAgentsForPersonaSync: async () => [{
      agentId: "agent-1", userId: 1, conversationId: "conv-1", personaVersion: null,
    }],
    recordMemoryReconciled: async (...args: unknown[]) => { (overrides.recorded as unknown[] | undefined)?.push(args); },
    recordCanonicalContextSyncState: async () => {},
    ...overrides,
  };
}

test("system prompt and persona are applied through the SDK runtime", async () => {
  const calls: string[] = [];
  const service = new PersonaSync(
    db({ recorded: [] }) as never,
    logger,
    {
      updateAgentSystemPrompt: async () => { calls.push("system"); return true; },
      updateAgentPersona: async () => { calls.push("persona"); return true; },
    },
  );
  const result = await service.sync("canonical persona", "canonical system");
  assert.equal(result.updated, 1);
  assert.deepEqual(calls, ["system", "persona"]);
  assert.equal(result.version, canonicalMemoryVersion("canonical persona", "canonical system"));
});

test("sync failure is reported without preventing the turn", async () => {
  const recorded: unknown[] = [];
  const service = new PersonaSync(
    db({ recorded }),
    logger,
    {
      updateAgentSystemPrompt: async () => { throw new Error("control plane unavailable"); },
      updateAgentPersona: async () => false,
    },
  );
  assert.equal(await service.syncAgent(
    { agentId: "agent-1", userId: 1, conversationId: "conv-1", storedVersion: null },
    "persona",
    { timeoutMs: 50 },
    "system",
  ), "failed");
  assert.equal(recorded.length, 0, "failed reconciliation recorded a successful version");
});

test("pre-turn timeout actually bounds the delay of the turn", async () => {
  let finish!: () => void;
  let recorded = false;
  const mutation = new Promise<void>((resolve) => { finish = resolve; });
  const service = new PersonaSync(
    db({ recordMemoryReconciled: async () => { recorded = true; } }), logger,
    {
      updateAgentSystemPrompt: async () => { await mutation; return true; },
      updateAgentPersona: async () => true,
    },
  );
  // Срок обслуживания заведомо не держит event loop (`unref`), чтобы не
  // задерживать остановку сервиса. В тесте кроме него ждать нечего,
  // поэтому цикл удерживается явно — иначе проверялась бы не граница
  // срока, а поведение раннера на пустом цикле.
  const keepAlive = setInterval(() => {}, 20);
  try {
    const startedAt = Date.now();
    const outcome = await service.syncAgent(
      { agentId: "agent-1", userId: 1, conversationId: "conv-1", storedVersion: null },
      "persona", { timeoutMs: 250 }, "system",
    );
    const elapsed = Date.now() - startedAt;
    // Прежняя версия после срока дожидалась работы целиком: срок ничего
    // не ограничивал, и медленный App Server задерживал ответ человеку.
    assert.equal(outcome, "deferred");
    assert.ok(elapsed < 2_000, `pre-turn sync blocked the turn for ${elapsed} ms`);
    assert.equal(recorded, false, "deferred sync claimed a delivered version");
    finish();
    // Работа доводится сама и уже вне хода отмечает доставку.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(recorded, true, "deferred reconciliation was abandoned instead of finishing");
  } finally {
    clearInterval(keepAlive);
  }
});

test("concurrent reconciliation for one agent is coalesced", async () => {
  let systemWrites = 0;
  let personaWrites = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new PersonaSync(
    db(), logger,
    {
      updateAgentSystemPrompt: async () => { systemWrites += 1; await gate; return true; },
      updateAgentPersona: async () => { personaWrites += 1; return true; },
    },
  );
  const input = { agentId: "agent-1", userId: 1, conversationId: "conv-1" };
  const first = service.reconcileAgent(input, "persona", "system");
  const second = service.reconcileAgent(input, "persona", "system");
  release();
  assert.deepEqual(await Promise.all([first, second]), ["updated", "updated"]);
  assert.equal(systemWrites, 1);
  assert.equal(personaWrites, 1);
});

test("successful canonical change invalidates every pooled session of the agent", async () => {
  const invalidated: string[] = [];
  const service = new PersonaSync(
    db(), logger,
    {
      updateAgentSystemPrompt: async () => true,
      updateAgentPersona: async () => true,
      invalidateAgentSessions: (agentId) => { invalidated.push(agentId); },
    },
  );
  assert.equal(await service.reconcileAgent(
    { agentId: "agent-1", userId: 1, conversationId: "conv-1" },
    "persona", "system",
  ), "updated");
  assert.deepEqual(invalidated, ["agent-1"]);
});

test("same canonical version is idempotent", async () => {
  let writes = 0;
  const service = new PersonaSync(
    db(),
    logger,
    {
      updateAgentSystemPrompt: async () => { writes += 1; return true; },
      updateAgentPersona: async () => { writes += 1; return true; },
    },
  );
  const version = canonicalMemoryVersion("persona", "system");
  assert.equal(await service.syncAgent(
    { agentId: "agent-1", userId: 1, conversationId: "conv-1", storedVersion: version },
    "persona", {}, "system",
  ), "up_to_date");
  assert.equal(writes, 0);
});

test("one agent failure does not stop other agents", async () => {
  const agents = [
    { agentId: "agent-1", userId: 1, conversationId: "conv-1", personaVersion: null },
    { agentId: "agent-2", userId: 2, conversationId: "conv-2", personaVersion: null },
  ];
  const calls: string[] = [];
  const service = new PersonaSync(
    db({ listAgentsForPersonaSync: async () => agents }),
    logger,
    {
      updateAgentSystemPrompt: async (id) => { calls.push(id); if (id === "agent-1") throw new Error("failed"); return true; },
      updateAgentPersona: async () => true,
    },
  );
  const result = await service.sync("persona", "system");
  assert.equal(result.failed, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(calls.sort(), ["agent-1", "agent-2"]);
});

test("reconciliation pages past the first batch instead of stopping at it", async () => {
  // 1 200 агентов: прежняя выборка сводила первые 500 и объявляла успех.
  const total = 1_200;
  const pages: Array<{ limit: number; offset: number }> = [];
  const synced = new Set<string>();
  const service = new PersonaSync(
    db({
      listAgentsForPersonaSync: async (limit: number, offset = 0) => {
        pages.push({ limit, offset });
        return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
          agentId: `agent-${offset + index}`,
          userId: offset + index + 1,
          conversationId: `conv-${offset + index}`,
          personaVersion: null,
        }));
      },
    }),
    logger,
    {
      updateAgentSystemPrompt: async (agentId) => { synced.add(agentId); return true; },
      updateAgentPersona: async () => true,
    },
  );
  const result = await service.sync("persona", "system");
  assert.equal(result.checked, total);
  assert.equal(result.updated, total);
  assert.equal(synced.size, total);
  assert.ok(pages.length >= 3, `pagination stopped after ${pages.length} page(s)`);
  assert.deepEqual(pages.map((page) => page.offset).slice(0, 3), [0, 500, 1_000]);
  assert.ok(synced.has("agent-1199"), "agents past the first batch were left stale");
});

test("startup reconciliation waits for the App Server instead of giving up", async () => {
  const delays: number[] = [];
  let pings = 0;
  const service = new PersonaSync(
    db() as never, logger,
    {
      ping: async () => {
        pings += 1;
        return pings < 3
          ? { ok: false as const, error: "connect ECONNREFUSED" }
          : { ok: true as const, models: 1 };
      },
      updateAgentSystemPrompt: async () => true,
      updateAgentPersona: async () => true,
    },
  );
  const result = await service.reconcileAtStartup("persona", "system", {
    attempts: 5,
    initialDelayMs: 10,
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(pings, 3, "startup stopped probing the App Server too early");
  assert.deepEqual(delays, [10, 20], "retry did not back off between attempts");
  assert.equal(result.updated, 1);
});

test("startup reconciliation retries agents left stale by the first pass", async () => {
  let attempt = 0;
  const service = new PersonaSync(
    db(), logger,
    {
      updateAgentSystemPrompt: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("app server restarting");
        return true;
      },
      updateAgentPersona: async () => true,
    },
  );
  const result = await service.reconcileAtStartup("persona", "system", {
    attempts: 3,
    initialDelayMs: 1,
    sleep: async () => {},
  });
  assert.equal(result.failed, 0, "a stale agent was never retried");
  assert.equal(result.updated, 1);
});

test("a mid-turn agent is deferred without recording a delivered version", async () => {
  const recorded: unknown[] = [];
  const states: unknown[] = [];
  const service = new PersonaSync(
    db({
      recordMemoryReconciled: async (...args: unknown[]) => { recorded.push(args); },
      recordCanonicalContextSyncState: async (...args: unknown[]) => { states.push(args); },
    }),
    logger,
    {
      // Барьер сообщает «занято»: ход не отпустил агента, и правка не
      // начиналась вовсе.
      runAgentMaintenance: async () => ({ status: "busy" as const }),
      updateAgentSystemPrompt: async () => { throw new Error("must not run"); },
      updateAgentPersona: async () => { throw new Error("must not run"); },
    },
  );
  assert.equal(await service.reconcileAgent(
    { agentId: "agent-1", userId: 1, conversationId: "conv-1" },
    "persona", "system",
  ), "deferred");
  assert.equal(recorded.length, 0, "deferred agent was marked as up to date");
  assert.deepEqual(states, [["agent-1", 1, "deferred"]]);
  assert.equal(personaSyncState().version, canonicalMemoryVersion("persona", "system"));
});

test("maintenance runs under the agent barrier, not beside it", async () => {
  const order: string[] = [];
  const service = new PersonaSync(
    db(), logger,
    {
      runAgentMaintenance: async (agentId, work, options) => {
        order.push(`barrier:${agentId}:${options.conversationIds?.join(",") ?? ""}`);
        return { status: "done" as const, value: await work() };
      },
      updateAgentSystemPrompt: async () => { order.push("system"); return true; },
      updateAgentPersona: async () => { order.push("persona"); return true; },
    },
  );
  assert.equal(await service.reconcileAgent(
    { agentId: "agent-1", userId: 1, conversationId: "conv-1" },
    "persona", "system",
  ), "updated");
  assert.deepEqual(order, ["barrier:agent-1:conv-1", "system", "persona"]);
});
