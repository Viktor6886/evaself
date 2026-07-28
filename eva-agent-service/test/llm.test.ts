import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LlmManager,
  SecretBox,
  modelHandle,
  probeOpenAiProvider,
} from "../dist/llm.js";

test("API key encrypts with authenticated random ciphertext", () => {
  const box = new SecretBox("x".repeat(64));
  const first = box.encrypt("sk-very-secret");
  const second = box.encrypt("sk-very-secret");

  assert.notEqual(first, second);
  assert.ok(!first.includes("sk-very-secret"));
  assert.equal(box.decrypt(first), "sk-very-secret");
  assert.throws(() => box.decrypt(`${first.slice(0, -2)}aa`));
});

test("modelHandle adds the local OpenAI provider only when needed", () => {
  assert.equal(modelHandle("gpt-compatible"), "openai/gpt-compatible");
  assert.equal(modelHandle("openai/already-qualified"), "openai/already-qualified");
});

test("provider probe reads an OpenAI-compatible /models response", async () => {
  let authorization = "";
  const result = await probeOpenAiProvider(
    { baseUrl: "https://llm.example/v1/", apiKey: "hidden", timeoutMs: 1000 },
    (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://llm.example/v1/models");
      authorization = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  );

  assert.equal(authorization, "Bearer hidden");
  assert.equal(result.ok, true);
  assert.equal(result.models_supported, true);
  assert.deepEqual(result.models.map((item) => item.id), ["model-a", "model-b"]);
});

test("provider probe allows manual model entry when /models is unsupported", async () => {
  const result = await probeOpenAiProvider(
    { baseUrl: "https://llm.example/v1", apiKey: "hidden", timeoutMs: 1000 },
    (async () => new Response("", { status: 404 })) as typeof fetch,
  );
  assert.equal(result.ok, true);
  assert.equal(result.models_supported, false);
});

test("public provider responses never expose ciphertext or API key", async () => {
  const box = new SecretBox("k".repeat(64));
  const row = providerRow("candidate", false, box.encrypt("sk-browser-must-not-see"));
  const db = {
    createLlmProvider: async () => row,
  };
  const manager = new LlmManager(
    config("k".repeat(64)),
    db as never,
    {} as never,
    logger() as never,
  );

  const result = await manager.create({
    name: "candidate",
    base_url: "https://llm.example/v1",
    api_key: "sk-browser-must-not-see",
    model: "model-a",
    context_window: 32768,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("sk-browser-must-not-see"));
  assert.ok(!serialized.includes("api_key_encrypted"));
  assert.equal(result.api_key_configured, true);
});

test("failed model switch restores the previous provider and mappings", async () => {
  const master = "z".repeat(64);
  const box = new SecretBox(master);
  const previous = providerRow("previous", true, box.encrypt("old-key"));
  const candidate = providerRow("candidate", false, box.encrypt("new-key"));
  let active = previous;
  const configured: string[] = [];
  const applied: string[] = [];

  const db = {
    getLlmProvider: async (id: string) => (id === candidate.id ? candidate : previous),
    getActiveLlmProvider: async () => active,
    recordLlmCheck: async () => candidate,
    setAgentModels: async () => undefined,
    activateLlmProvider: async (id: string) => {
      active = id === previous.id ? previous : candidate;
      return active;
    },
  };
  const letta = {
    closeAllSessions: () => undefined,
    setDefaultModel: () => undefined,
    listAllModelMappings: async () => [{ agentId: "agent-1", conversationIds: ["conv-1"] }],
    applyModelToMappings: async (_mappings: unknown, model: string) => {
      applied.push(model);
      if (model === "openai/candidate-model") throw new Error("synthetic SDK failure");
    },
  };
  const manager = new LlmManager(
    config(master),
    db as never,
    letta as never,
    logger() as never,
    {
      configureProvider: async (provider) => {
        configured.push(provider.name);
      },
      restartAppServer: async () => undefined,
      probeProvider: async () => ({
        ok: true,
        models_supported: true,
        models: [{ id: "candidate-model" }],
        message: "ok",
        status_code: 200,
      }),
    },
  );

  await assert.rejects(() => manager.activate(candidate.id), /предыдущая конфигурация сохранена/i);
  assert.deepEqual(configured, ["candidate", "previous"]);
  assert.deepEqual(applied, ["openai/candidate-model", "openai/previous-model"]);
  assert.equal(active.id, previous.id);
});

function providerRow(name: string, isActive: boolean, encrypted: string) {
  const now = new Date("2026-07-28T00:00:00Z");
  return {
    id: `${name}-id`,
    name,
    protocol: "openai-compatible" as const,
    base_url: "https://llm.example/v1",
    model: `${name}-model`,
    context_window: 32768,
    additional_parameters: {},
    api_key_encrypted: encrypted,
    is_active: isActive,
    last_checked_at: null,
    last_check_ok: null,
    last_check_message: null,
    last_models: null,
    created_at: now,
    updated_at: now,
  };
}

function config(master: string) {
  return {
    llmEncryptionKey: master,
    llmProbeTimeoutMs: 1000,
    lettaCliPath: "letta",
    llmProviderConfigDir: "/tmp/providers",
    llmControlFile: "/tmp/restart",
  } as never;
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
