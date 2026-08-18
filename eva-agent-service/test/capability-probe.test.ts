import assert from "node:assert/strict";
import test from "node:test";

import { probeModelCapabilities } from "../dist/llm/capability-probe.js";
import { LlmManager, SecretBox } from "../dist/llm.js";

const INPUT = {
  baseUrl: "https://provider.invalid/v1",
  apiKey: "probe-key",
  model: "test/model",
  timeoutMs: 1_000,
  claims: { tools: true, json: true, streaming: true, vision: false },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHAT = (content: unknown) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
const TOOL_CALL = (args: string, name = "evaself_capability_probe") => ({
  choices: [{
    message: { content: null, tool_calls: [{ id: "call-1", function: { name, arguments: args } }] },
    finish_reason: "tool_calls",
  }],
});
const SSE = () => new Response(
  'data: {"choices":[{"delta":{"content":"re"}}]}\n\n'
  + 'data: {"choices":[{"delta":{"content":"ady"}}]}\n\n'
  + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

/**
 * Провайдер-фикстура: отвечает по форме запроса, а не по счётчику
 * вызовов. Так тест не ломается от перестановки проб.
 */
function provider(overrides: {
  completion?: () => Response;
  streaming?: () => Response;
  toolCall?: () => Response;
  toolLoop?: () => Response;
  jsonObject?: () => Response;
  vision?: () => Response;
} = {}) {
  const seen: Array<Record<string, unknown>> = [];
  const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push(body);
    const messages = (body.messages ?? []) as Array<{ role: string; content?: unknown }>;
    if (body.stream === true) return (overrides.streaming ?? SSE)();
    if (messages.some((message) => message.role === "tool")) {
      return (overrides.toolLoop ?? (() => json(CHAT("Готово."))))();
    }
    if (body.tools) return (overrides.toolCall ?? (() => json(TOOL_CALL('{"value":"ok"}'))))();
    if (body.response_format) return (overrides.jsonObject ?? (() => json(CHAT('{"ok":true}'))))();
    if (Array.isArray(messages[0]?.content)) return (overrides.vision ?? (() => json(CHAT("ready"))))();
    return (overrides.completion ?? (() => json(CHAT("ready"))))();
  };
  return { fetcher: fetcher as unknown as typeof fetch, seen };
}

function statusOf(result: { checks: Array<{ name: string; status: string }> }, name: string): string {
  return result.checks.find((entry) => entry.name === name)?.status ?? "missing";
}

test("совместимая модель проходит все заявленные пробы", async () => {
  const { fetcher, seen } = provider();
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(result.ok, true, result.message);
  for (const name of ["completion", "streaming", "tool_call", "tool_result_loop", "json_object"]) {
    assert.equal(statusOf(result, name), "ok", name);
  }
  // Не заявлено — не проверяется: лишних запросов к провайдеру нет.
  assert.equal(statusOf(result, "vision"), "skipped");

  // Проба дешёвая и без данных пользователя.
  assert.ok(seen.length <= 6, `запросов к провайдеру: ${seen.length}`);
  for (const body of seen) {
    assert.equal(body.temperature, 0, "проба должна быть детерминированной");
    assert.ok(Number(body.max_tokens) <= 64, "проба должна быть дешёвой");
  }
  assert.doesNotMatch(JSON.stringify(seen), /Сергей|Бореалис|EVA_RUNTIME_CONTEXT|USER_MESSAGE/);
});

test("модель без вызова инструментов не становится основной", async () => {
  // Ровно тот случай, ради которого проба и заведена: провайдер
  // отвечает, /models работает, supports_tools=true — а инструмент не
  // вызывается никогда.
  const { fetcher } = provider({ toolCall: () => json(CHAT("Конечно, вызываю инструмент!")) });
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(result.ok, false);
  assert.equal(statusOf(result, "tool_call"), "failed");
  assert.equal(statusOf(result, "tool_result_loop"), "failed");
  assert.match(result.message, /не вызвала инструмент/);
});

test("аргументы не по схеме — это отказ, а не мелочь", async () => {
  const broken = provider({ toolCall: () => json(TOOL_CALL('{"value":"maybe"}')) });
  const brokenResult = await probeModelCapabilities(INPUT, broken.fetcher);
  assert.equal(brokenResult.ok, false);
  assert.match(brokenResult.message, /не соответствуют заданной схеме/);

  const invalid = provider({ toolCall: () => json(TOOL_CALL("{value: ok}")) });
  const invalidResult = await probeModelCapabilities(INPUT, invalid.fetcher);
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.message, /не разбираются как JSON/);
});

test("цикл, который не завершается ответом, не проходит", async () => {
  const { fetcher } = provider({ toolLoop: () => json(TOOL_CALL('{"value":"ok"}')) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.equal(statusOf(result, "tool_call"), "ok");
  assert.equal(statusOf(result, "tool_result_loop"), "failed");
  assert.match(result.message, /снова требует инструмент/);
});

test("поток, пришедший не событиями SSE, не проходит", async () => {
  const { fetcher } = provider({ streaming: () => json(CHAT("ready")) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.equal(statusOf(result, "streaming"), "failed");
  assert.match(result.message, /не событиями SSE/);
});

test("отказ провайдера называет причину, а не «что-то пошло не так»", async () => {
  const { fetcher } = provider({ completion: () => json({ error: "boom" }, 502) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.match(result.message, /completion: HTTP 502/);
});

test("незаявленные возможности не проверяются и не отказывают", async () => {
  const { fetcher, seen } = provider();
  const result = await probeModelCapabilities(
    { ...INPUT, claims: { tools: false, json: false, streaming: false, vision: false } },
    fetcher,
  );
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1, "остаётся только обычный ответ");
  for (const name of ["streaming", "tool_call", "tool_result_loop", "json_object", "vision"]) {
    assert.equal(statusOf(result, name), "skipped", name);
  }
});

test("провал зрения не блокирует разговорную модель", async () => {
  const { fetcher } = provider({ vision: () => json({ error: "no vision" }, 400) });
  const result = await probeModelCapabilities(
    { ...INPUT, claims: { ...INPUT.claims, vision: true } },
    fetcher,
  );
  assert.equal(statusOf(result, "vision"), "failed");
  assert.equal(result.ok, true, "разговаривать модель умеет и без зрения");
});

/**
 * Активация: несовместимая модель не должна становиться основной.
 */
function activationHarness(capabilities: { ok: boolean; message: string }) {
  const row = {
    id: "candidate", name: "Кандидат", protocol: "openai-compatible" as const,
    base_url: "https://provider.invalid/v1", model: "test/model", context_window: 32_768,
    additional_parameters: {},
    api_key_encrypted: new SecretBox("0".repeat(32)).encrypt("provider-key"),
    is_active: false,
    last_checked_at: null, last_check_ok: null, last_check_message: null, last_models: null,
    created_at: new Date(), updated_at: new Date(),
  };
  const checks: Array<{ ok: boolean; message: string }> = [];
  let activated = false;
  const db = {
    getLlmProvider: async () => row,
    getActiveLlmProvider: async () => null,
    recordLlmCheck: async (_id: string, check: { ok: boolean; message: string }) => { checks.push(check); },
    activateLlmProvider: async () => { activated = true; return { ...row, is_active: true }; },
    setAgentModels: async () => undefined,
  };
  const letta = {
    listAllModelMappings: async () => [],
    closeAllSessions: () => {},
    waitForModel: async () => undefined,
    applyModelToMappings: async () => undefined,
    setDefaultModel: () => {},
  };
  const llm = new LlmManager(
    { llmProbeTimeoutMs: 1_000, llmEncryptionKey: "0".repeat(32), routerApiKey: "router" } as never,
    db as never,
    letta as never,
    { debug() {}, info() {}, warn() {}, error() {} },
    {
      configureProvider: async () => undefined,
      restartAppServer: async () => undefined,
      probeProvider: async () => ({
        ok: true, models_supported: true, models: [{ id: "test/model" }],
        message: "Подключение работает.", status_code: 200,
      }),
      probeCapabilities: async () => ({ ok: capabilities.ok, checks: [], message: capabilities.message }),
    },
  );
  return { llm, checks, isActivated: () => activated };
}

test("несовместимая модель не активируется, и причина названа", async () => {
  const { llm, checks, isActivated } = activationHarness({
    ok: false,
    message: "tool_call: модель не вызвала инструмент и ответила текстом",
  });
  await assert.rejects(
    () => llm.activate("candidate"),
    /не вызвала инструмент/,
  );
  assert.equal(isActivated(), false, "активация должна быть заблокирована");
  assert.equal(checks.at(-1)?.ok, false);
});

test("совместимая модель активируется", async () => {
  const { llm, isActivated } = activationHarness({ ok: true, message: "" });
  const active = await llm.activate("candidate");
  assert.equal(active.is_active, true);
  assert.equal(isActivated(), true);
});
