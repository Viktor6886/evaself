import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyDeterministically } from "../dist/router/classifier.js";
import { appendRoutingMarker, extractRoutingMarker } from "../dist/router/routing-marker.js";
import { LlmRouter, NoProviderAvailable } from "../dist/router/router.js";
import { breakerKey, ProviderError } from "../dist/router/types.js";
import { fromOpenAi } from "../dist/router/server.js";
import { RouterStore } from "../dist/router/store.js";
import { TaskEventService } from "../dist/tasks/task-event-service.js";

const settings = {
  mode: "adaptive" as const,
  single_provider_id: null,
  single_failover_enabled: false,
  auto_routing_enabled: true,
  llm_classifier_enabled: true,
  fast_max_score: 0,
  deep_min_score: 5,
  classifier_confidence_threshold: 0.75,
  classifier_timeout_ms: 5000,
  classifier_max_input_chars: 4000,
  uncertain_policy: "upgrade" as const,
  economy_score_shift: -1,
  quality_score_shift: 1,
};

function request(text: string, metadata = {}) {
  return {
    messages: [{ role: "user" as const, content: text }],
    system_prompt: "", tools: [], temperature: 0.7, max_tokens: 1000,
    stream: false, response_format: null,
    metadata: {
      request_id: "", user_id: "1", agent_id: "a", route: "chat",
      sensitive: true, purpose: "chat", ...metadata,
    },
  };
}

test("single mode bypasses score and classifier", () => {
  const result = classifyDeterministically(
    request("Проведи очень глубокий анализ сложного решения"),
    { ...settings, mode: "single", single_provider_id: "provider" },
  );
  assert.equal(result.result.effectiveRoute, "single");
  assert.equal(result.result.source, "disabled_single_mode");
  assert.equal(result.ambiguous, false);
});

test("scheduler and high-risk requests use hard routes", () => {
  assert.equal(
    classifyDeterministically(request("напомни", { purpose: "scheduler" }), settings).result.effectiveRoute,
    "fast",
  );
  assert.equal(
    classifyDeterministically(request("привет", { crisis_level: "critical" }), settings).result.effectiveRoute,
    "safety",
  );
});

test("tools, JSON and vision hard rules bypass scoring", () => {
  assert.equal(classifyDeterministically(request("Напомни завтра позвонить"), settings).result.effectiveRoute, "tools");
  assert.equal(classifyDeterministically({ ...request("Верни объект"), response_format: { type: "json_object" as const } }, settings).result.effectiveRoute, "json");
  assert.equal(classifyDeterministically(request("Что на картинке?", { has_image: true }), settings).result.effectiveRoute, "vision");
});

test("user quality modes shift only adaptive scoring", () => {
  const text = "Проведи глубокий анализ";
  const economy = classifyDeterministically(request(text, { user_mode: "economy" }), settings).result;
  const quality = classifyDeterministically(request(text, { user_mode: "quality" }), settings).result;
  assert.ok(economy.score < quality.score);
  const single = classifyDeterministically(request(text, { user_mode: "quality" }), {
    ...settings, mode: "single", single_provider_id: "provider",
  }).result;
  assert.equal(single.score, 0);
  assert.equal(single.effectiveRoute, "single");
});

test("important short decisions are deep while greetings are fast", () => {
  assert.equal(classifyDeterministically(request("Стоит ли мне увольняться?"), settings).result.effectiveRoute, "deep");
  assert.equal(classifyDeterministically(request("Привет!"), settings).result.effectiveRoute, "fast");
});

test("routing marker is signed, verified and stripped", () => {
  const signed = appendRoutingMarker("hello", { purpose: "scheduler", message_source: "voice" }, "secret");
  const valid = extractRoutingMarker(signed, "secret");
  assert.equal(valid.text, "hello");
  assert.equal(valid.claims?.purpose, "scheduler");
  assert.equal(valid.claims?.message_source, "voice");

  const forged = extractRoutingMarker(signed.replace("scheduler", "research"), "wrong-secret");
  assert.equal(forged.claims, null);
  assert.doesNotMatch(forged.text, /EVA_ROUTING/);
});

test("OpenAI facade trusts only a valid server marker and strips it", () => {
  const marked = appendRoutingMarker("hello", {
    purpose: "scheduler", message_source: "voice", correlation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }, "secret");
  const parsed = fromOpenAi({ model: "eva/chat", messages: [{ role: "user", content: marked }] }, "secret");
  assert.equal(parsed.metadata.purpose, "scheduler");
  assert.equal(parsed.metadata.has_voice, true);
  assert.equal(parsed.metadata.request_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(parsed.messages[0]?.content, "hello");

  const forged = fromOpenAi({ model: "eva/chat", messages: [{ role: "user", content: marked }] }, "other");
  assert.equal(forged.metadata.purpose, "chat");
  assert.equal(forged.messages[0]?.content, "hello");
});

test("task event reads and mutations are scoped to the runtime user", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: sql.includes("UPDATE tasks") ? [{ id: 9, status: "done" }] : [], rowCount: 1 };
  } };
  const events = new TaskEventService(db as never);
  await events.recent(7, 3);
  await events.recentOpenReminderTasks(7, 3);
  await events.complete(7, 9);
  assert.ok(calls.every((call) => call.sql.includes("$1") || call.sql.includes("user_id")));
  assert.equal(calls[0]?.values[0], 7);
  assert.deepEqual(calls.find((call) => call.sql.includes("UPDATE tasks"))?.values, [9, 7]);
});

function provider(id: string) {
  return {
    id, name: id, protocol: "openai-compatible" as const,
    base_url: "https://example.test/v1", model: id, api_key: "secret",
    connect_timeout_ms: 1000, request_timeout_ms: 1000, max_retries: 0,
    max_concurrency: 8, max_rpm: null, max_tpm: null,
    context_window: 32000, max_output_tokens: 4000, max_latency_ms: null,
    supports_tools: true, supports_json: true, supports_vision: true,
    supports_streaming: true, quality_tier: 1, sensitive_data_allowed: true,
    price_in_micro: 0, price_out_micro: 0, daily_budget_micro: null,
    monthly_budget_micro: null, generation_defaults: {}, additional_parameters: {},
  };
}

function singleHarness(failover: boolean, selectedBreakerOpen = false) {
  const calls: string[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  const p1 = provider("chat-primary");
  const p2 = provider("single-selected");
  const route = (code: string, rotation_enabled: boolean) => ({
    code, title: code, requires_tools: false, requires_json: false,
    requires_vision: false, requires_streaming: false, min_context_window: 1024,
    max_quality_tier: 5, allows_sensitive: true, rotation_enabled,
  });
  const store = {
    routingSettings: async () => ({
      ...settings, mode: "single" as const, single_provider_id: p2.id,
      single_failover_enabled: failover,
    }),
    providers: async () => [p1, p2],
    routes: async () => new Map([["chat", route("chat", true)], ["single", route("single", false)]]),
    chains: async () => new Map([["chat", [p1.id]]]),
    breakers: async () => selectedBreakerOpen ? new Map([[breakerKey(p2.id, p2.model), {
      provider_id: p2.id, model: p2.model, state: "open", consecutive_errors: 3,
      first_error_at: new Date(), opened_at: new Date(), probe_after: new Date(Date.now() + 60_000),
      last_error_code: "timeout", last_success_at: null, pinned_out: false,
    }]]) : new Map(), spend: async () => ({ day: 0, month: 0 }),
    claimProbe: async () => false, recordSuccess: async () => {},
    recordFailure: async () => {}, addSpend: async () => {},
    recordAttempt: async (value: Record<string, unknown>) => { attempts.push(value); },
  };
  const adapters = (p: { id: string }) => ({
    protocol: "openai-compatible" as const,
    complete: async () => {
      calls.push(p.id);
      if (p.id === p2.id) throw new ProviderError("timeout", "timeout", { retryable: true });
      return { content: "ok", tool_calls: [], finish_reason: "stop" as const,
        usage: { tokens_in: 1, tokens_out: 1 }, model: p.model };
    },
    async *stream() { throw new Error("unused"); },
  });
  const router = new LlmRouter(store as never, { debug() {}, info() {}, warn() {}, error() {} }, undefined, async () => {}, adapters as never);
  return { router, calls, attempts };
}

test("single uses only the selected provider when emergency failover is off", async () => {
  const { router, calls } = singleHarness(false);
  await assert.rejects(router.complete(request("hello")), NoProviderAvailable);
  assert.deepEqual(calls, ["single-selected"]);
});

test("single emergency failover uses chat only after a technical failure", async () => {
  const { router, calls, attempts } = singleHarness(true);
  const result = await router.complete(request("hello"));
  assert.equal(result.provider_id, "chat-primary");
  assert.deepEqual(calls, ["single-selected", "chat-primary"]);
  assert.equal(attempts.at(-1)?.single_failover_used, true);
});

test("single emergency failover is recorded when the selected breaker is already open", async () => {
  const { router, calls, attempts } = singleHarness(true, true);
  const result = await router.complete(request("hello"));
  assert.equal(result.provider_id, "chat-primary");
  assert.deepEqual(calls, ["chat-primary"]);
  assert.equal(attempts.at(-1)?.single_failover_used, true);
});

test("routing settings cache invalidates by notification and survives a transient DB error", async () => {
  let reads = 0;
  let fail = false;
  let notification: ((message: { channel: string }) => void) | null = null;
  const client = {
    query: async () => ({ rows: [] }),
    on: (event: string, handler: (message: { channel: string }) => void) => {
      if (event === "notification") notification = handler;
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async () => {
      reads += 1;
      if (fail) throw new Error("db unavailable");
      return { rows: [{ ...settings, mode: reads === 1 ? "adaptive" : "single", single_provider_id: "provider" }] };
    },
  };
  const store = new RouterStore(pool as never, "a".repeat(32));
  assert.equal((await store.routingSettings()).mode, "adaptive");
  assert.equal((await store.routingSettings()).mode, "adaptive");
  assert.equal(reads, 1);
  notification?.({ channel: "llm_routing_settings_changed" });
  assert.equal((await store.routingSettings()).mode, "single");
  (store as unknown as { settingsCache: { at: number } }).settingsCache.at = 0;
  fail = true;
  assert.equal((await store.routingSettings()).mode, "single");
  await store.close();
});

function adaptiveClassifierHarness(classifierReply: string | null, options: {
  timeout?: boolean; sensitiveAllowed?: boolean; confidenceThreshold?: number;
} = {}) {
  const calls: string[] = [];
  const classifier = { ...provider("classifier"), sensitive_data_allowed: options.sensitiveAllowed !== false };
  const chat = provider("chat");
  const deep = provider("deep");
  const route = (code: string, json = false) => ({
    code, title: code, requires_tools: false, requires_json: json,
    requires_vision: false, requires_streaming: false, min_context_window: 1024,
    max_quality_tier: 5, allows_sensitive: true, rotation_enabled: true,
  });
  const store = {
    routingSettings: async () => ({
      ...settings,
      classifier_timeout_ms: options.timeout ? 5 : 5000,
      classifier_confidence_threshold: options.confidenceThreshold ?? 0.75,
    }),
    providers: async () => [classifier, chat, deep],
    routes: async () => new Map([
      ["classifier", route("classifier", true)], ["chat", route("chat")], ["deep", route("deep")],
    ]),
    chains: async () => new Map([
      ["classifier", [classifier.id]], ["chat", [chat.id]], ["deep", [deep.id]],
    ]),
    breakers: async () => new Map(), spend: async () => ({ day: 0, month: 0 }),
    claimProbe: async () => false, recordSuccess: async () => {}, recordFailure: async () => {},
    addSpend: async () => {}, recordAttempt: async () => {},
  };
  const adapters = (p: { id: string; model: string }) => ({
    protocol: "openai-compatible" as const,
    complete: async () => {
      calls.push(p.id);
      if (p.id === classifier.id && options.timeout) return await new Promise<never>(() => {});
      return { content: p.id === classifier.id ? classifierReply ?? "" : "ok", tool_calls: [],
        finish_reason: "stop" as const, usage: { tokens_in: 1, tokens_out: 1 }, model: p.model };
    },
    async *stream() { throw new Error("unused"); },
  });
  return {
    calls,
    router: new LlmRouter(store as never, { debug() {}, info() {}, warn() {}, error() {} }, undefined, async () => {}, adapters as never),
  };
}

test("classifier runs only for ambiguity and cannot recurse", async () => {
  const { router, calls } = adaptiveClassifierHarness('{"route":"chat","confidence":0.9,"reasons":["ambiguous_context"]}');
  const result = await router.complete(request("Проанализируй глубоко"));
  assert.equal(result.provider_id, "chat");
  assert.deepEqual(calls, ["classifier", "chat"]);
});

test("invalid, slow and low-confidence classifier results safely upgrade", async () => {
  for (const [reply, options] of [
    ["not-json", {}],
    ['{"route":"fast","confidence":0.2}', {}],
    [null, { timeout: true }],
  ] as const) {
    const { router, calls } = adaptiveClassifierHarness(reply, options);
    const result = await router.complete(request("Проанализируй глубоко"));
    assert.equal(result.provider_id, "deep");
    assert.equal(calls.at(-1), "deep");
  }
});

test("sensitive text never reaches a classifier provider without permission", async () => {
  const { router, calls } = adaptiveClassifierHarness('{"route":"chat","confidence":0.9}', { sensitiveAllowed: false });
  const result = await router.complete(request("Проанализируй глубоко"));
  assert.equal(result.provider_id, "deep");
  assert.deepEqual(calls, ["deep"]);
});
