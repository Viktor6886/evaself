import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveRoute } from "../dist/router/routes.js";
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

test("режим одной модели ведёт всё в техническую цепочку single", () => {
  const result = resolveRoute(
    request("Проведи очень глубокий анализ сложного решения"),
    { ...settings, mode: "single", single_provider_id: "provider" },
  );
  assert.equal(result.effectiveRoute, "single");
  assert.equal(result.source, "single_mode");
});

test("назначение conversation выбирает цепочку, а не смысл сообщения", () => {
  assert.equal(resolveRoute(request("напомни", { purpose: "scheduler" }), settings).effectiveRoute, "fast");
  assert.equal(resolveRoute(request("что там", { purpose: "goal_review" }), settings).effectiveRoute, "deep");
  assert.equal(resolveRoute(request("посмотри", { purpose: "research" }), settings).effectiveRoute, "research");
});

test("технические требования запроса: изображение и строгий JSON", () => {
  assert.equal(resolveRoute(request("Что на картинке?", { has_image: true }), settings).effectiveRoute, "vision");
  assert.equal(
    resolveRoute({ ...request("Верни объект"), response_format: { type: "json_object" as const } }, settings).effectiveRoute,
    "json",
  );
  assert.equal(
    resolveRoute({
      ...request("Верни объект по схеме"),
      response_format: { type: "json_schema" as const, json_schema: { schema: { type: "object" } } },
    }, settings).effectiveRoute,
    "json",
  );
});

test("явно запрошенный маршрут продуктовой операции сохраняется", () => {
  const result = resolveRoute(request("описание изображения", { route: "deep", requested_route: "deep" }), settings);
  assert.equal(result.effectiveRoute, "deep");
  assert.equal(result.source, "requested");
});

test("содержание сообщения на выбор модели больше не влияет", () => {
  // Раньше это были разные маршруты: «увольняться» набирало балл на
  // deep, приветствие уходило в fast. Глубину разбора решает Letta.
  const heavy = resolveRoute(request("Стоит ли мне увольняться? Мы снова поругались с женой."), settings);
  const light = resolveRoute(request("Привет!"), settings);
  assert.equal(heavy.effectiveRoute, "chat");
  assert.equal(light.effectiveRoute, "chat");
  assert.equal(heavy.source, "default");
});

test("личный выбор качества — единственное, что меняет цепочку разговора", () => {
  // Это явный выбор человека через update_llm_quality_mode, а не вывод
  // о его сообщении.
  const text = "Что мне делать дальше?";
  assert.equal(resolveRoute(request(text, { user_mode: "economy" }), settings).effectiveRoute, "fast");
  assert.equal(resolveRoute(request(text, { user_mode: "quality" }), settings).effectiveRoute, "deep");
  assert.equal(resolveRoute(request(text, { user_mode: "auto" }), settings).effectiveRoute, "chat");
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

test("обычный ход не делает второго вызова модели ради выбора маршрута", async () => {
  // Отдельного LLM-классификатора больше нет: один ход — один вызов
  // выбранной conversational-модели, каким бы «сложным» ни выглядело
  // сообщение.
  const calls: string[] = [];
  const chat = provider("chat");
  const deep = provider("deep");
  const route = (code: string) => ({
    code, title: code, requires_tools: false, requires_json: false,
    requires_vision: false, requires_streaming: false, min_context_window: 1024,
    max_quality_tier: 5, allows_sensitive: true, rotation_enabled: true,
  });
  const store = {
    routingSettings: async () => settings,
    providers: async () => [chat, deep],
    routes: async () => new Map([["chat", route("chat")], ["deep", route("deep")]]),
    chains: async () => new Map([["chat", [chat.id]], ["deep", [deep.id]]]),
    breakers: async () => new Map(), spend: async () => ({ day: 0, month: 0 }),
    claimProbe: async () => false, recordSuccess: async () => {}, recordFailure: async () => {},
    addSpend: async () => {}, recordAttempt: async () => {},
  };
  const adapters = (p: { id: string; model: string }) => ({
    protocol: "openai-compatible" as const,
    complete: async () => {
      calls.push(p.id);
      return { content: "ok", tool_calls: [], finish_reason: "stop" as const,
        usage: { tokens_in: 1, tokens_out: 1 }, model: p.model };
    },
    async *stream() { throw new Error("unused"); },
  });
  const router = new LlmRouter(
    store as never, { debug() {}, info() {}, warn() {}, error() {} },
    undefined, async () => {}, adapters as never,
  );

  const result = await router.complete(request("Стоит ли мне увольняться? Мы снова поругались."));
  assert.equal(result.provider_id, "chat");
  assert.deepEqual(calls, ["chat"]);
});
