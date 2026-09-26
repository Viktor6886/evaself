/**
 * Манифесты OpenAI-совместимых провайдеров: новый совместимый провайдер
 * подключается данными, а поведение существующих не меняется.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { openAiAdapter } from "../dist/router/adapters/openai.js";
import {
  PROVIDER_MANIFESTS,
  openAiCompatHeaders,
  publicManifests,
  resolveOpenAiCompat,
  validateOpenAiCompat,
} from "../dist/router/provider-manifests.js";

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1", name: "primary", protocol: "openai-compatible", base_url: "https://example.test/v1", model: "model-a",
    api_key: "sk-test", connect_timeout_ms: 1_000, request_timeout_ms: 5_000, max_retries: 0, max_concurrency: 1,
    max_rpm: null, max_tpm: null, context_window: 131_072, max_output_tokens: 4_096, max_latency_ms: null,
    supports_tools: true, supports_json: true, supports_vision: false, supports_streaming: true, quality_tier: 2,
    sensitive_data_allowed: true, price_in_micro: 0, price_out_micro: 0, daily_budget_micro: null,
    monthly_budget_micro: null, generation_defaults: {}, additional_parameters: {}, ...overrides,
  };
}

const REQUEST = {
  messages: [{ role: "user", content: "Привет" }], system_prompt: "", tools: [], temperature: 0.2, max_tokens: 256,
  stream: false, response_format: null,
  metadata: { request_id: "r1", user_id: null, agent_id: null, route: "chat", sensitive: false },
};

async function send(overrides: Record<string, unknown>) {
  const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
  };
  await openAiAdapter.complete(provider({ ...overrides, fetcher }) as never, REQUEST as never, new AbortController().signal);
  return seen[0]!;
}

test("манифест узнаётся по адресу или явно; без манифеста — Bearer, как было", () => {
  const generic = resolveOpenAiCompat("https://llm.internal.example/v1", {});
  assert.equal(generic.manifestId, null);
  assert.deepEqual(openAiCompatHeaders(generic, "k"), { authorization: "Bearer k" });

  const router = resolveOpenAiCompat("https://openrouter.ai/api/v1", {});
  assert.equal(router.manifestId, "openrouter");
  assert.deepEqual(openAiCompatHeaders(router, "k"), { "X-Title": "Evaself", authorization: "Bearer k" });

  const explicit = resolveOpenAiCompat("https://proxy.example/v1", { provider_manifest: "deepseek" });
  assert.equal(explicit.manifestId, "deepseek");
  assert.ok(PROVIDER_MANIFESTS.every((manifest) => manifest.protocol === "openai-compatible"));
  assert.ok(publicManifests().every((item) => !("auth" in item) && !("headers" in item)), "панели — без внутренних подробностей");
});

test("новый совместимый провайдер подключается настройкой: свой заголовок ключа и заголовки", () => {
  const resolved = resolveOpenAiCompat("https://llm.vendor.example/v1", {
    openai_compat: {
      auth_header: "X-Vendor-Auth", auth_scheme: "none", budget_field: "max_completion_tokens",
      headers: { "X-Client": "evaself", Authorization: "Bearer leaked", "X-Api-Key": "leaked", Cookie: "a=b", "Bad Name": "x" },
    },
  });
  assert.deepEqual(openAiCompatHeaders(resolved, "secret"), { "X-Client": "evaself", "x-vendor-auth": "secret" });
  assert.equal(resolved.budgetField, "max_completion_tokens");
});

test("переопределения проверяются при сохранении: секрет в постоянном заголовке не пройдёт", () => {
  assert.equal(validateOpenAiCompat({}), null);
  assert.equal(validateOpenAiCompat({ provider_manifest: "openrouter", openai_compat: { headers: { "HTTP-Referer": "https://eva.example" } } }), null);
  assert.match(validateOpenAiCompat({ provider_manifest: "nope" })!, /неизвестный манифест/);
  assert.match(validateOpenAiCompat({ openai_compat: { headers: { Authorization: "Bearer x" } } })!, /нельзя задать/);
  assert.match(validateOpenAiCompat({ openai_compat: { headers: { "X-Api-Key": "x" } } })!, /нельзя задать/);
  assert.match(validateOpenAiCompat({ openai_compat: { headers: { "X-A": "line\nbreak" } } })!, /без перевода строки/);
  assert.match(validateOpenAiCompat({ openai_compat: { headers: ["x"] } })!, /объект/);
  assert.match(validateOpenAiCompat({ openai_compat: { auth_scheme: "Basic" } })!, /Bearer или none/);
  assert.match(validateOpenAiCompat({ openai_compat: { budget_field: "tokens" } })!, /max_tokens/);
  assert.match(validateOpenAiCompat({ openai_compat: { extra: 1 } })!, /неизвестное поле/);
});

test("адаптер: заголовки и бюджет — из манифеста, настройки манифеста в тело не идут", async () => {
  const plain = await send({});
  assert.equal(plain.headers.authorization, "Bearer sk-test");
  assert.equal(plain.body.max_tokens, 256);
  assert.equal(plain.body.max_completion_tokens, undefined);

  const custom = await send({
    base_url: "https://llm.vendor.example/v1",
    additional_parameters: { provider_manifest: "openrouter", openai_compat: { auth_header: "api-key", auth_scheme: "none", budget_field: "max_completion_tokens" } },
  });
  assert.equal(custom.headers["api-key"], "sk-test");
  assert.equal(custom.headers.authorization, undefined);
  assert.equal(custom.headers["X-Title"], "Evaself");
  assert.equal(custom.headers["content-type"], "application/json");
  assert.equal(custom.body.max_completion_tokens, 256);
  assert.equal(custom.body.provider_manifest, undefined);
  assert.equal(custom.body.openai_compat, undefined);

  // Явный параметр провайдера главнее манифеста.
  const explicit = await send({ additional_parameters: { max_tokens: 1, openai_compat: { budget_field: "max_completion_tokens" } } });
  assert.equal(explicit.body.max_tokens, 256);
  assert.equal(explicit.body.max_completion_tokens, undefined);
});
