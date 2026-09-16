import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresTelegramInbox } from "../dist/delivery/inbox.js";
import { isProviderCircuitOpen, toEvaError } from "../dist/errors.js";
import { buildChain } from "../dist/router/chain.js";
import { isBreakerHealthFailure, RouterStore } from "../dist/router/store.js";
import { breakerKey } from "../dist/router/types.js";

function encryptionKey() {
  return Buffer.alloc(32, 7).toString("base64");
}

test("legacy half-open без probe_after снова можно захватить для контрольной пробы", async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new RouterStore(pool, encryptionKey());

  assert.equal(await store.claimProbe("polza", "model-a", 60_000), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /probe_after IS NULL OR probe_after <= now\(\)/);
});

test("breaker считает только отказы здоровья провайдера", () => {
  for (const reason of ["server_error", "connection_failed", "timeout", "invalid_response"]) {
    assert.equal(isBreakerHealthFailure(reason), true, reason);
  }
  for (const reason of [
    "rate_limited",
    "quota_exhausted",
    "model_error",
    "empty_response",
    "json_contract_failed",
    "tool_calls_failed",
    "breaker_open",
  ]) {
    assert.equal(isBreakerHealthFailure(reason), false, reason);
  }
});

test("429 не накапливает ошибки breaker и не открывает провайдера", async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new RouterStore(pool, encryptionKey());

  await store.recordFailure("polza", "model-a", "rate_limited", 3, 300_000, 30_000);

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].text, /consecutive_errors \+ 1/);
  assert.doesNotMatch(calls[0].text, /SET state = 'open'/);
  assert.deepEqual(calls[0].values, ["polza", "model-a", "rate_limited"]);
});

test("реальный 5xx по-прежнему накапливает ошибки и может открыть breaker", async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new RouterStore(pool, encryptionKey());

  await store.recordFailure("polza", "model-a", "server_error", 3, 300_000, 30_000);

  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /consecutive_errors \+ 1/);
  assert.match(calls[1].text, /SET state = 'open'/);
});

function provider() {
  return {
    id: "polza",
    name: "PolzaAi",
    protocol: "openai-compatible",
    base_url: "https://example.test/v1",
    model: "model-a",
    api_key: "k",
    connect_timeout_ms: 1_000,
    request_timeout_ms: 10_000,
    max_retries: 0,
    max_concurrency: 1,
    max_rpm: null,
    max_tpm: null,
    context_window: 128_000,
    max_output_tokens: 4_096,
    max_latency_ms: null,
    supports_tools: true,
    supports_json: true,
    supports_vision: false,
    supports_streaming: true,
    quality_tier: 1,
    sensitive_data_allowed: true,
    price_in_micro: 0,
    price_out_micro: 0,
    daily_budget_micro: null,
    monthly_budget_micro: null,
    generation_defaults: {},
    additional_parameters: {},
  };
}

function request() {
  return {
    system_prompt: "",
    messages: [{ role: "user", content: "привет" }],
    tools: [],
    response_format: null,
    temperature: null,
    max_tokens: 256,
    stream: false,
    metadata: {
      route: "chat",
      request_id: "regression",
      user_id: null,
      agent_id: null,
      sensitive: false,
      has_image: false,
    },
  };
}

test("legacy open без probe_after считается готовым к пробе, а не вечным", () => {
  const p = provider();
  const chain = buildChain({
    route: {
      code: "chat",
      title: "chat",
      requires_tools: false,
      requires_json: false,
      requires_vision: false,
      requires_streaming: false,
      min_context_window: 1,
      max_quality_tier: 5,
      allows_sensitive: true,
      rotation_enabled: true,
    },
    request: request(),
    providerIds: [p.id],
    providers: new Map([[p.id, p]]),
    breakers: new Map([[breakerKey(p.id, p.model), {
      provider_id: p.id,
      model: p.model,
      state: "open",
      consecutive_errors: 3,
      first_error_at: null,
      opened_at: null,
      probe_after: null,
      last_error_code: "server_error",
      last_success_at: null,
      pinned_out: false,
    }]]),
    now: new Date(),
  });

  assert.equal(chain.usable.length, 1);
  assert.equal(chain.rejected.length, 0);
});

test("вложенный 503 breaker превращается в короткую retryable ошибку", () => {
  const raw = new Error(
    '503: {\\"message\\":\\"PolzaAi: circuit breaker открыт\\",\\"type\\":\\"service_unavailable\\"}',
  );
  const error = toEvaError(raw, "running a turn");

  assert.equal(error.code, "app_server_unavailable");
  assert.equal(error.retryable, true);
  assert.equal(isProviderCircuitOpen(error), true);
  assert.match(error.message, /провайдер LLM временно недоступен/);
  assert.doesNotMatch(error.message, /service_unavailable/);
});

test("ожидание открытого breaker не расходует попытку durable inbox", async () => {
  const calls = [];
  const db = {
    async withSystemScope(_label, work) { return await work(); },
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  const inbox = new PostgresTelegramInbox(db);
  const error = toEvaError(
    new Error('503: {\\"message\\":\\"PolzaAi: circuit breaker открыт\\"}'),
    "running a turn",
  );

  const outcome = await inbox.fail(42, error, 3, 3);

  assert.equal(outcome.dead, false, "ожидание пробы не должно убивать сообщение");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values[1], "retry");
  assert.equal(calls[0].values[2], 10);
  assert.equal(calls[0].values[4], true);
  assert.match(calls[0].text, /attempts = CASE/);
  assert.match(calls[0].text, /GREATEST\(0, attempts - 1\)/);
});
