import assert from "node:assert/strict";
import test from "node:test";

import { PersonaSync, canonicalMemoryVersion } from "../dist/letta/persona-sync.js";

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

test("pre-turn timeout does not leave mutation running beside the turn", async () => {
  let finish!: () => void;
  let mutating = false;
  const mutation = new Promise<void>((resolve) => { finish = resolve; });
  const service = new PersonaSync(
    db(), logger,
    {
      updateAgentSystemPrompt: async () => {
        mutating = true;
        await mutation;
        mutating = false;
        return true;
      },
      updateAgentPersona: async () => true,
    },
  );
  const sync = service.syncAgent(
    { agentId: "agent-1", userId: 1, conversationId: "conv-1", storedVersion: null },
    "persona", { timeoutMs: 1 }, "system",
  );
  await new Promise((resolve) => setTimeout(resolve, 275));
  let returned = false;
  void sync.then(() => { returned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false, "turn was released while canonical mutation was running");
  assert.equal(mutating, true);
  finish();
  assert.equal(await sync, "updated");
  assert.equal(mutating, false);
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
