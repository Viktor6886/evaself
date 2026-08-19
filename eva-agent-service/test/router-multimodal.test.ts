import assert from "node:assert/strict";
import test from "node:test";

import { anthropicAdapter } from "../dist/router/adapters/anthropic.js";
import { openAiAdapter } from "../dist/router/adapters/openai.js";
import { containsImage, parseContent } from "../dist/router/content.js";
import { resolveRoute } from "../dist/router/routes.js";
import { createRouterServer, fromOpenAi } from "../dist/router/server.js";
import { buildChain } from "../dist/router/chain.js";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const DATA_URI = `data:image/png;base64,${PIXEL}`;

const PROVIDER = {
  id: "p1", name: "primary", protocol: "openai-compatible",
  base_url: "https://provider.invalid/v1", model: "vision-model", api_key: "k",
  connect_timeout_ms: 1_000, request_timeout_ms: 5_000, max_retries: 0, max_concurrency: 4,
  max_rpm: null, max_tpm: null, context_window: 128_000, max_output_tokens: 4_096,
  max_latency_ms: null, supports_tools: true, supports_json: true, supports_vision: true,
  supports_streaming: true, quality_tier: 3, sensitive_data_allowed: true,
  price_in_micro: 0, price_out_micro: 0, daily_budget_micro: null, monthly_budget_micro: null,
  generation_defaults: {}, additional_parameters: {},
};

/** Подменённый fetch: наружу ничего не уходит, тело запроса видно тесту. */
function captureFetch(payload: unknown, status = 200) {
  const sent: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    sent.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const IMAGE_REQUEST = {
  model: "eva/chat",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "что на фотографии?" },
      { type: "image_url", image_url: { url: DATA_URI } },
    ],
  }],
};

test("изображение переживает разбор запроса, а не превращается в пустоту", () => {
  const parsed = parseContent(IMAGE_REQUEST.messages[0]!.content);
  assert.equal(parsed.text, "что на фотографии?");
  assert.deepEqual(parsed.parts, [
    { type: "text", text: "что на фотографии?" },
    { type: "image_url", url: DATA_URI },
  ]);

  const request = fromOpenAi(IMAGE_REQUEST);
  assert.equal(request.messages[0]?.content, "что на фотографии?");
  assert.equal(containsImage(request.messages), true);
  // Изображение в запросе — технический факт, и он сам просит маршрут
  // зрения, не дожидаясь пометки от вызывающего.
  assert.equal(request.metadata.has_image, true);
  const route = resolveRoute(request, { mode: "adaptive" } as never);
  assert.equal(route.effectiveRoute, "vision");
  assert.deepEqual(route.reasons, ["image_in_request"]);
});

test("картинка доходит до OpenAI-совместимого провайдера целиком", async () => {
  const capture = captureFetch({
    choices: [{ message: { content: "на фотографии кот" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  try {
    const request = fromOpenAi(IMAGE_REQUEST);
    const response = await openAiAdapter.complete(PROVIDER as never, request, AbortSignal.timeout(5_000));
    assert.equal(response.content, "на фотографии кот");
  } finally {
    capture.restore();
  }

  const body = capture.sent[0] as { messages: Array<{ content: unknown }> };
  assert.deepEqual(body.messages[0]?.content, [
    { type: "text", text: "что на фотографии?" },
    { type: "image_url", image_url: { url: DATA_URI } },
  ]);
});

test("картинка доходит до Anthropic-совместимого провайдера блоком base64", async () => {
  const capture = captureFetch({
    content: [{ type: "text", text: "на фотографии кот" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  try {
    const request = fromOpenAi(IMAGE_REQUEST);
    await anthropicAdapter.complete(
      { ...PROVIDER, protocol: "anthropic-compatible" } as never,
      request,
      AbortSignal.timeout(5_000),
    );
  } finally {
    capture.restore();
  }

  const body = capture.sent[0] as { messages: Array<{ content: unknown[] }> };
  assert.deepEqual(body.messages[0]?.content, [
    { type: "text", text: "что на фотографии?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
  ]);
});

test("маршрут зрения не берёт провайдера без зрения", () => {
  const route = {
    code: "vision", title: "Зрение", requires_tools: false, requires_json: false,
    requires_vision: true, sensitive_data_allowed: true, min_quality_tier: 1,
  };
  const chain = buildChain({
    route: route as never,
    request: fromOpenAi(IMAGE_REQUEST),
    providerIds: ["blind", "seeing"],
    providers: new Map([
      ["blind", { ...PROVIDER, id: "blind", name: "blind", supports_vision: false }],
      ["seeing", { ...PROVIDER, id: "seeing", name: "seeing", supports_vision: true }],
    ]) as never,
    breakers: new Map(),
    now: new Date(),
  });
  assert.deepEqual(chain.usable.map((entry) => entry.provider.name), ["seeing"]);
  assert.equal(chain.rejected[0]?.provider.name, "blind");
});

/**
 * Служебные поля reasoning-модели переживают цикл инструмента.
 *
 * Провайдер требует вернуть `reasoning_details` без изменений вместе с
 * результатом инструмента. Проверка идёт через настоящую поверхность
 * роутера: HTTP-запрос, настоящие `fromOpenAi`/`toOpenAi` и настоящий
 * адаптер провайдера.
 */
test("reasoning_details проходят роутер туда и обратно через цикл инструмента", async () => {
  const REASONING = [{ type: "reasoning.encrypted", data: "opaque-blob", format: "openai-responses-v1" }];
  const seen: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  let step = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    seen.push(body);
    step += 1;
    const payload = step === 1
      ? {
        choices: [{
          message: {
            content: null,
            reasoning_details: REASONING,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }
      : {
        choices: [{ message: { content: "в Перми +18" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      };
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const app = createRouterServer({
    apiKey: "test-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    store: {
      routes: async () => new Map([["chat", { code: "chat" }]]),
      providers: async () => [{ id: "p1" }],
      breakers: async () => new Map(),
    } as never,
    router: {
      complete: async (request: never) => ({
        response: await openAiAdapter.complete(PROVIDER as never, request, AbortSignal.timeout(5_000)),
        request_id: "r1", provider_name: "primary", switches: 0,
      }),
      stream: async function* () { throw new Error("не используется"); },
    } as never,
  });
  await app.ready();

  try {
    const first = await app.inject({
      method: "POST", url: "/chat/completions",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      payload: {
        model: "eva/chat",
        messages: [{ role: "user", content: "какая погода в Перми?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      },
    });
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body) as {
      choices: Array<{ message: { reasoning_details?: unknown; tool_calls?: unknown[] } }>;
    };
    // Роутер отдал служебные поля вызывающему: без них он не сможет
    // вернуть их провайдеру на следующем шаге.
    assert.deepEqual(firstBody.choices[0]?.message.reasoning_details, REASONING);

    const second = await app.inject({
      method: "POST", url: "/chat/completions",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      payload: {
        model: "eva/chat",
        messages: [
          { role: "user", content: "какая погода в Перми?" },
          {
            role: "assistant",
            content: null,
            reasoning_details: REASONING,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call-1", content: "{\"c\":18}" },
        ],
      },
    });
    assert.equal(second.statusCode, 200);
    assert.match(JSON.parse(second.body).choices[0].message.content, /\+18/);
  } finally {
    await app.close();
    globalThis.fetch = original;
  }

  // Провайдер получил свои поля обратно без изменений.
  const forwarded = (seen[1] as { messages: Array<Record<string, unknown>> }).messages[1];
  assert.deepEqual(forwarded?.reasoning_details, REASONING);
  assert.equal(forwarded?.role, "assistant");
});

test("служебные поля провайдера не подмешиваются в видимый текст", async () => {
  const capture = captureFetch({
    choices: [{
      message: { content: "ответ", reasoning: "внутренний ход мыслей", reasoning_details: [{ data: "x" }] },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  try {
    const request = fromOpenAi({ model: "eva/chat", messages: [{ role: "user", content: "привет" }] });
    const response = await openAiAdapter.complete(PROVIDER as never, request, AbortSignal.timeout(5_000));
    assert.equal(response.content, "ответ", "рассуждение попало в видимый ответ");
    assert.deepEqual(response.provider_state?.reasoning_details, [{ data: "x" }]);
  } finally {
    capture.restore();
  }
});
