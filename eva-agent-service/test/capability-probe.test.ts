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
type Handler = (body: Record<string, unknown>) => Response;

function provider(overrides: {
  completion?: Handler;
  streaming?: Handler;
  toolCall?: Handler;
  toolLoop?: Handler;
  jsonObject?: Handler;
  jsonSchema?: Handler;
  vision?: Handler;
} = {}) {
  const seen: Array<Record<string, unknown>> = [];
  const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push(body);
    const messages = (body.messages ?? []) as Array<{ role: string; content?: unknown }>;
    if (body.stream === true) return (overrides.streaming ?? SSE)(body);
    if (messages.some((message) => message.role === "tool")) {
      return (overrides.toolLoop ?? (() => json(CHAT("Готово."))))(body);
    }
    if (body.tools) return (overrides.toolCall ?? (() => json(TOOL_CALL('{"value":"ok"}'))))(body);
    if (body.response_format) {
      const format = body.response_format as { type?: string };
      return format.type === "json_schema"
        ? (overrides.jsonSchema ?? (() => json(CHAT('{"ok":true}'))))(body)
        : (overrides.jsonObject ?? (() => json(CHAT('{"ok":true}'))))(body);
    }
    if (Array.isArray(messages[0]?.content)) return (overrides.vision ?? (() => json(CHAT("ready"))))(body);
    return (overrides.completion ?? (() => json(CHAT("ready"))))(body);
  };
  return { fetcher: fetcher as unknown as typeof fetch, seen };
}

/** Сообщение assistant, которое проба вернула провайдеру вместе с результатом. */
function echoedAssistant(body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
  const index = messages.findIndex((message) => message.role === "tool");
  return messages[index - 1] ?? {};
}

function statusOf(result: { checks: Array<{ name: string; status: string }> }, name: string): string {
  return result.checks.find((entry) => entry.name === name)?.status ?? "missing";
}

test("совместимая модель проходит все заявленные пробы", async () => {
  const { fetcher, seen } = provider();
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(result.ok, true, result.message);
  for (const name of ["completion", "streaming", "tool_call", "tool_result_loop", "json_object", "json_schema"]) {
    assert.equal(statusOf(result, name), "ok", name);
  }
  // Не заявлено — не проверяется: лишних запросов к провайдеру нет.
  assert.equal(statusOf(result, "vision"), "skipped");
  // Модель без служебных полей размышления шлёт роутеру ровно то же, что
  // и проба: сравнивать нечего.

  // Проба дешёвая и без данных пользователя.
  assert.ok(seen.length <= 6, `запросов к провайдеру: ${seen.length}`);
  assert.equal(result.warnings, "");
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

/**
 * Reasoning-модель: провайдер отдаёт вместе с вызовом непрозрачный блок
 * размышления и требует вернуть его без изменений.
 */
const REASONING_DETAILS = [
  { type: "reasoning.encrypted", data: "opaque-blob", format: "openai-responses-v1", index: 0 },
];
const REASONING_TOOL_CALL = (): Response => json({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      reasoning: "",
      reasoning_details: REASONING_DETAILS,
      tool_calls: [{
        id: "call-luna-1",
        type: "function",
        function: { name: "evaself_capability_probe", arguments: '{"value":"ok"}' },
      }],
    },
    finish_reason: "tool_calls",
  }],
});

function loopBodies(seen: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return seen.filter((body) => ((body.messages ?? []) as Array<{ role: string }>)
    .some((message) => message.role === "tool"));
}

test("reasoning-модель: служебные поля возвращаются провайдеру без изменений", async () => {
  // Провайдер отвечает пустотой, если reasoning_details не вернулись
  // вместе с результатом инструмента — так OpenRouter и ведёт себя с
  // reasoning-моделями. Проба, пересобиравшая assistant-сообщение из
  // одних tool_calls, объявляла рабочую модель несовместимой.
  const { fetcher, seen } = provider({
    toolCall: REASONING_TOOL_CALL,
    toolLoop: (body) => {
      const assistant = echoedAssistant(body);
      return JSON.stringify(assistant.reasoning_details) === JSON.stringify(REASONING_DETAILS)
        ? json(CHAT("Готово."))
        : json(CHAT(""));
    },
  });

  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, true, result.message);
  assert.equal(statusOf(result, "tool_result_loop"), "ok");

  const assistant = echoedAssistant(loopBodies(seen)[0] ?? {});
  assert.deepEqual(assistant.reasoning_details, REASONING_DETAILS);
  assert.equal(assistant.reasoning, "");
  assert.equal(assistant.role, "assistant");
  // Идентификатор вызова и аргументы — модели, а не выдуманные пробой.
  const call0 = (assistant.tool_calls as Array<{ id: string; function: { arguments: string } }>)[0];
  assert.equal(call0.id, "call-luna-1");
  assert.equal(call0.function.arguments, '{"value":"ok"}');
  // Содержимое размышлений остаётся между пробой и провайдером: в
  // результат, а значит и в базу с журналом, оно не попадает.
  assert.doesNotMatch(JSON.stringify(result), /opaque-blob/);

  // Probe и production теперь проходят один и тот же canonical adapter,
  // поэтому отдельного предупреждения о расхождении больше нет.
  assert.equal(result.warnings, "");
});

test("OpenRouter reasoning+tools: length на 1024 не является несовместимостью", async () => {
  const { fetcher, seen } = provider({
    toolCall: REASONING_TOOL_CALL,
    toolLoop: (body) => Number(body.max_tokens) <= 1_024
      ? json({
          choices: [{
            message: { content: "", reasoning: "opaque-progress" },
            finish_reason: "length",
          }],
        })
      : json(CHAT("FINAL_OK")),
  });

  const result = await probeModelCapabilities({ ...INPUT, maxOutputTokens: 4_096 }, fetcher);
  assert.equal(result.ok, true, result.message);
  assert.equal(statusOf(result, "tool_result_loop"), "ok");
  const loops = loopBodies(seen);
  assert.ok(loops.some((body) => body.max_tokens === 1_024), "регрессия воспроизведена на старой границе");
  assert.ok(loops.some((body) => Number(body.max_tokens) > 1_024), "probe использовал допустимый бюджет модели");
  const finalMessages = loops.at(-1)?.messages as Array<{ role?: string; content?: string }>;
  assert.match(finalMessages.at(-1)?.content ?? "", /FINAL_OK/, "final answer требуется явно");
});

test("модель, которой служебные поля не нужны, не получает предупреждения", async () => {
  // Та же reasoning-модель, но провайдер завершает цикл в любой форме:
  // ограничения роутера её не касаются, и выдумывать его не нужно.
  const { fetcher } = provider({ toolCall: REASONING_TOOL_CALL });
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(result.ok, true, result.message);
  assert.equal(statusOf(result, "tool_result_loop"), "ok");
  assert.equal(result.warnings, "");
});

test("reasoning-модель без завершения цикла всё равно отказ", async () => {
  // Сохранение служебных полей не должно превращаться в поблажку:
  // модель, которая после результата молчит, остаётся несовместимой.
  const { fetcher } = provider({ toolCall: REASONING_TOOL_CALL, toolLoop: () => json(CHAT("")) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.equal(statusOf(result, "tool_result_loop"), "failed");
  assert.match(result.message, /tool_result_loop: пустой ответ модели/);
});

test("провайдер, не принявший обязательное opaque state, отклоняется с точной причиной", async () => {
  const { fetcher, seen } = provider({
    toolCall: REASONING_TOOL_CALL,
    toolLoop: (body) => ("reasoning_details" in echoedAssistant(body)
      ? json({ error: { message: "Unrecognized key: reasoning_details" } }, 400)
      : json(CHAT("Готово."))),
  });

  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.match(result.message, /Unrecognized key: reasoning_details/);
  assert.equal(loopBodies(seen).length, 1, "opaque state нельзя молча удалить как fallback");
});

test("проба идёт в конфигурации провайдера, но без секретов и маршрутизации", async () => {
  const { fetcher, seen } = provider();
  const result = await probeModelCapabilities({
    ...INPUT,
    additionalParameters: {
      reasoning: { effort: "high" },
      chat_template_kwargs: { enable_thinking: false },
      // Маршрутизация, учёт и учётные данные в техническую пробу не идут.
      provider: { order: ["openai"] },
      transforms: ["middle-out"],
      user: "tenant-42",
      api_key: "sk-should-not-leak",
      // Полями самой пробы настройка не распоряжается.
      temperature: 0.9,
      max_tokens: 4096,
      stream: true,
    },
  }, fetcher);

  assert.equal(result.ok, true, result.message);
  assert.equal(statusOf(result, "streaming"), "ok", "stream остаётся за пробой");
  for (const body of seen) {
    assert.deepEqual(body.reasoning, { effort: "high" }, "режим размышления тот же, что в продакшне");
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.provider, undefined);
    assert.equal(body.transforms, undefined);
    assert.equal(body.user, undefined);
    assert.equal(body.api_key, undefined);
    assert.equal(body.temperature, 0, "проба остаётся детерминированной");
    assert.ok(Number(body.max_tokens) <= 64, "проба остаётся дешёвой");
  }
  assert.doesNotMatch(JSON.stringify(seen), /sk-should-not-leak/);
});

test("отсутствие строгого JSON не снимает модель с активации", async () => {
  // Агентный ход Letta идёт инструментами: строгую форму задаёт схема
  // инструмента, а не response_format. Отказ в нём — ограничение
  // продуктовых маршрутов, а не несовместимость с разговором.
  const unsupported = (): Response => json({ error: { message: "response_format is not supported" } }, 400);
  const { fetcher } = provider({ jsonObject: unsupported, jsonSchema: unsupported });
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(result.ok, true, result.message);
  assert.equal(result.message, "");
  assert.equal(statusOf(result, "json_object"), "failed");
  assert.equal(statusOf(result, "json_schema"), "failed");
  assert.match(result.warnings, /json_object/);
  assert.match(result.warnings, /json_schema/);
  assert.match(result.warnings, /response_format is not supported/);
});

test("Structured Outputs классифицируются отдельно от свободного JSON", async () => {
  const { fetcher, seen } = provider({
    jsonObject: () => json({ error: { message: "json_object unsupported" } }, 400),
  });
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(statusOf(result, "json_object"), "failed");
  assert.equal(statusOf(result, "json_schema"), "ok");
  const schemaBody = seen.find((body) => (body.response_format as { type?: string })?.type === "json_schema");
  const format = schemaBody?.response_format as { json_schema?: { strict?: boolean; schema?: unknown } };
  assert.equal(format?.json_schema?.strict, true, "схема проверяется строгим контрактом");
});

test("ответ, не соответствующий схеме, — отказ в Structured Outputs", async () => {
  const { fetcher } = provider({ jsonSchema: () => json(CHAT('{"answer":"ready"}')) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(statusOf(result, "json_schema"), "failed");
  assert.match(result.warnings, /не соответствует переданной схеме/);
});

test("поток, пришедший не событиями SSE, не проходит", async () => {
  const { fetcher } = provider({ streaming: () => json(CHAT("ready")) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.equal(statusOf(result, "streaming"), "failed");
  assert.match(result.message, /поток закончился без содержимого/);
});

test("отказ провайдера называет причину, а не «что-то пошло не так»", async () => {
  const { fetcher } = provider({ completion: () => json({ error: "boom" }, 502) });
  const result = await probeModelCapabilities(INPUT, fetcher);
  assert.equal(result.ok, false);
  assert.match(result.message, /completion: HTTP 502/);
});

test("agent tools проверяются фактически даже при ошибочном false в настройке", async () => {
  const { fetcher, seen } = provider();
  const result = await probeModelCapabilities(
    { ...INPUT, claims: { tools: false, json: false, streaming: false, vision: false } },
    fetcher,
  );
  assert.equal(result.ok, true);
  assert.equal(statusOf(result, "streaming"), "skipped");
  assert.equal(statusOf(result, "tool_call"), "ok");
  assert.equal(statusOf(result, "tool_result_loop"), "ok");
  assert.equal(statusOf(result, "json_object"), "skipped");
  assert.equal(statusOf(result, "vision"), "skipped");
  assert.equal(seen.length, 3, "completion и полный agent tool loop");
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
      probeCapabilities: async () => ({
        ok: capabilities.ok, checks: [], message: capabilities.message, warnings: "",
      }),
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

/**
 * Размышление тратит тот же бюджет, что и ответ.
 *
 * С тридцатью двумя токенами reasoning-модель успевает только подумать
 * и возвращает пустое сообщение. Проба, читающая пустоту как «не
 * умеет», объявляла несовместимой исправную модель — ту, которая на
 * деле и инструменты вызывает, и картинки смотрит.
 */
const EMPTY_BY_BUDGET = () => json({
  choices: [{ message: { content: "", reasoning: "…" }, finish_reason: "length" }],
});

test("модели, которой не хватило бюджета на ответ, даётся бюджет побольше", async () => {
  const short: string[] = [];
  const { fetcher, seen } = provider({
    toolLoop: (body) => {
      const budget = Number(body.max_tokens);
      if (budget < 1_024) {
        short.push("короткий");
        return EMPTY_BY_BUDGET();
      }
      return json(CHAT("Готово."));
    },
  });
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(statusOf(result, "tool_result_loop"), "ok", result.message);
  assert.equal(result.ok, true, result.message);
  assert.equal(short.length > 0, true, "короткая попытка должна была случиться первой");
  // Повтор идёт с тем же ходом, только с большим бюджетом: иначе
  // проверялось бы что-то другое.
  const retry = seen.find((body) => Number(body.max_tokens) >= 1_024);
  assert.ok(retry, "повтор с увеличенным бюджетом не состоялся");
  assert.ok(
    (retry!.messages as Array<{ role: string }>).some((message) => message.role === "tool"),
    "повторяется тот же цикл с результатом инструмента",
  );
  const detail = result.checks.find((entry) => entry.name === "tool_result_loop")?.detail ?? "";
  assert.match(detail, /1024/, "оператору видно, что ответ пришёл только с большим бюджетом");
});

test("молчание и при большом бюджете остаётся отказом", async () => {
  const { fetcher } = provider({ toolLoop: EMPTY_BY_BUDGET });
  const result = await probeModelCapabilities(INPUT, fetcher);

  assert.equal(statusOf(result, "tool_result_loop"), "failed");
  assert.equal(result.ok, false);
  // Отказ называет проверенную границу, а не просто «не ответила»:
  // иначе непонятно, тесно модели или она действительно молчит.
  assert.match(result.message, /допустимый output budget=8192/);
});

test("пустой ответ на изображение перепроверяется большим бюджетом", async () => {
  const { fetcher } = provider({
    vision: (body) => Number(body.max_tokens) < 1_024 ? EMPTY_BY_BUDGET() : json(CHAT("ready")),
  });
  const result = await probeModelCapabilities(
    { ...INPUT, claims: { ...INPUT.claims, vision: true } },
    fetcher,
  );
  assert.equal(statusOf(result, "vision"), "ok", result.message);
});
