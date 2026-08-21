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
  const service = new PersonaSync(
    db(),
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
