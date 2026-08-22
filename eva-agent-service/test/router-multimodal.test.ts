import assert from "node:assert/strict";
import test from "node:test";

import { anthropicAdapter } from "../dist/router/adapters/anthropic.js";
import { openAiAdapter } from "../dist/router/adapters/openai.js";
import { containsImage, parseContent } from "../dist/router/content.js";
import { resolveRoute } from "../dist/router/routes.js";
import { NoProviderAvailable } from "../dist/router/router.js";
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

/**
 * Отказ основной модели зрения не теряет картинку.
 *
 * Резерв получает тот же запрос, и в нём то же изображение: если бы
 * роутер собирал тело запроса один раз и правил его на месте, вторая
 * попытка ушла бы без картинки — и «не вижу изображения» пришло бы уже
 * от резерва, при исправном основном пути.
 */
test("резерв маршрута зрения получает изображение целиком", async () => {
  const { LlmRouter } = await import("../dist/router/router.js");
  const { ProviderError, breakerKey } = await import("../dist/router/types.js");

  const primary = { ...PROVIDER, id: "p-blind", name: "primary-vision" };
  const backup = { ...PROVIDER, id: "p-backup", name: "backup-vision" };
  const bodies: Array<{ provider: string; content: unknown }> = [];
  const store = {
    routingSettings: async () => ({
      mode: "adaptive" as const, single_provider_id: null, single_failover_enabled: false,
    }),
    providers: async () => [primary, backup],
    routes: async () => new Map([["vision", {
      code: "vision", title: "vision", requires_tools: false, requires_json: false,
      requires_vision: true, requires_streaming: false, min_context_window: 1024,
      max_quality_tier: 5, allows_sensitive: true, rotation_enabled: true,
    }]]),
    chains: async () => new Map([["vision", [primary.id, backup.id]]]),
    breakers: async () => new Map(),
    spend: async () => ({ day: 0, month: 0 }),
    claimProbe: async () => false,
    recordSuccess: async () => {}, recordFailure: async () => {},
    addSpend: async () => {}, recordAttempt: async () => {},
  };
  const adapters = (provider: { id: string; model: string }) => ({
    protocol: "openai-compatible" as const,
    complete: async (_p: unknown, request: { messages: Array<{ parts?: unknown }> }) => {
      bodies.push({ provider: provider.id, content: request.messages[0]?.parts });
      if (provider.id === primary.id) {
        throw new ProviderError("timeout", "timeout", { retryable: true });
      }
      return {
        content: "зелёный", tool_calls: [], finish_reason: "stop" as const,
        usage: { tokens_in: 1, tokens_out: 1 }, model: provider.model,
      };
    },
    async *stream() { throw new Error("не используется"); },
  });

  const router = new LlmRouter(
    store as never,
    { debug() {}, info() {}, warn() {}, error() {} },
    undefined,
    async () => {},
    adapters as never,
  );
  const result = await router.complete(fromOpenAi(IMAGE_REQUEST) as never);

  assert.equal(result.provider_name, "backup-vision");
  assert.equal(result.route, "vision");
  assert.equal(result.switches, 1);
  assert.deepEqual(bodies.map((item) => item.provider), [primary.id, backup.id]);
  // Главное: у резерва картинка та же, а не потерянная по дороге.
  for (const body of bodies) {
    assert.deepEqual(body.content, [
      { type: "text", text: "что на фотографии?" },
      { type: "image_url", url: DATA_URI },
    ]);
  }
  assert.ok(breakerKey(primary.id, primary.model));
});

test("single text model gets final answer after configured vision preprocessing", async () => {
  const { LlmRouter } = await import("../dist/router/router.js");
  const text = { ...PROVIDER, id: "text", name: "selected-text", supports_vision: false };
  const vision = { ...PROVIDER, id: "vision", name: "technical-vision", supports_vision: true };
  const calls: Array<{ provider: string; request: ReturnType<typeof fromOpenAi> }> = [];
  const route = (code: string, requiresVision: boolean) => ({
    code, title: code, requires_tools: false, requires_json: false,
    requires_vision: requiresVision, requires_streaming: false, min_context_window: 1,
    max_quality_tier: 5, allows_sensitive: true, rotation_enabled: true,
  });
  const store = {
    routingSettings: async () => ({
      mode: "single" as const, single_provider_id: text.id, single_failover_enabled: false,
    }),
    providers: async () => [text, vision],
    routes: async () => new Map([["single", route("single", false)], ["vision", route("vision", true)]]),
    chains: async () => new Map([["single", [text.id]], ["vision", [vision.id]]]),
    breakers: async () => new Map(), spend: async () => ({ day: 0, month: 0 }),
    claimProbe: async () => false, recordSuccess: async () => {}, recordFailure: async () => {},
    addSpend: async () => {}, recordAttempt: async () => {},
  };
  const router = new LlmRouter(
    store as never,
    { debug() {}, info() {}, warn() {}, error() {} },
    undefined,
    async () => {},
    ((provider: typeof text) => ({
      protocol: "openai-compatible" as const,
      complete: async (_profile: unknown, request: ReturnType<typeof fromOpenAi>) => {
        calls.push({ provider: provider.id, request });
        return {
          content: provider.id === vision.id ? "На изображении зелёный квадрат." : "Финальный ответ выбранной модели.",
          tool_calls: [], finish_reason: "stop" as const,
          usage: { tokens_in: 1, tokens_out: 1 }, model: provider.model,
        };
      },
      async *stream(_profile: unknown, request: ReturnType<typeof fromOpenAi>) {
        calls.push({ provider: provider.id, request });
        const response = {
          content: "Финальный поток выбранной модели.", tool_calls: [], finish_reason: "stop" as const,
          usage: { tokens_in: 1, tokens_out: 1 }, model: provider.model,
        };
        yield { type: "text" as const, delta: response.content };
        yield { type: "done" as const, response };
      },
    })) as never,
  );

  const requestWithToolHistory = {
    ...IMAGE_REQUEST,
    messages: [
      {
        role: "assistant", content: "",
        tool_calls: [{
          id: "prior-call", type: "function",
          function: { name: "remember", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "prior-call", content: "saved" },
      ...IMAGE_REQUEST.messages,
    ],
  };
  const result = await router.complete(fromOpenAi(requestWithToolHistory) as never);
  assert.equal(result.provider_id, text.id);
  assert.deepEqual(calls.map((entry) => entry.provider), [vision.id, text.id]);
  assert.equal(containsImage(calls[0]!.request.messages), true);
  assert.deepEqual(calls[0]!.request.messages.map((message) => message.role), ["user"]);
  assert.equal(containsImage(calls[1]!.request.messages), false);
  assert.match(calls[1]!.request.messages.at(-1)!.content, /зелёный квадрат/);
  assert.equal(calls[1]!.request.metadata.vision_preprocessed, true);

  calls.length = 0;
  const streamed: string[] = [];
  for await (const chunk of router.stream(fromOpenAi({ ...requestWithToolHistory, stream: true }) as never)) {
    if (chunk.type === "text") streamed.push(chunk.delta);
  }
  assert.deepEqual(calls.map((entry) => entry.provider), [vision.id, text.id]);
  assert.equal(containsImage(calls[0]!.request.messages), true);
  assert.equal(containsImage(calls[1]!.request.messages), false);
  assert.deepEqual(streamed, ["Финальный поток выбранной модели."]);
});

/**
 * Маршрут зрения без своей цепочки не роняет фотографию.
 *
 * Так и было в production: провайдер, добавленный через панель, попадает
 * только в ту цепочку, куда его поставили руками. Маршрут `vision`
 * выбирается самим содержимым хода, назначить ему цепочку никто не
 * догадался — и каждая фотография упиралась в «для маршрута vision не
 * назначен ни один провайдер», хотя зрячая модель в установке была. PDF
 * при этом читался: документ превращается в текст.
 */
test("технический маршрут без цепочки идёт общей, но зрение всё так же обязательно", async () => {
  const { LlmRouter, NoProviderAvailable } = await import("../dist/router/router.js");

  const seeing = { ...PROVIDER, id: "p-see", name: "seeing", supports_vision: true };
  const blind = { ...PROVIDER, id: "p-blind", name: "blind", supports_vision: false };
  const route = (code: string, requiresVision: boolean) => ({
    code, title: code, requires_tools: false, requires_json: false,
    requires_vision: requiresVision, requires_streaming: false, min_context_window: 1024,
    max_quality_tier: 5, allows_sensitive: true, rotation_enabled: true,
  });
  const store = (chatChain: string[]) => ({
    routingSettings: async () => ({
      mode: "adaptive" as const, single_provider_id: null, single_failover_enabled: false,
    }),
    providers: async () => [seeing, blind],
    routes: async () => new Map([["chat", route("chat", false)], ["vision", route("vision", true)]]),
    // Цепочка есть только у чата: ровно та конфигурация, что в production.
    chains: async () => new Map([["chat", chatChain]]),
    breakers: async () => new Map(),
    spend: async () => ({ day: 0, month: 0 }),
    claimProbe: async () => false,
    recordSuccess: async () => {}, recordFailure: async () => {},
    addSpend: async () => {}, recordAttempt: async () => {},
  });
  const adapters = (provider: { id: string; model: string }) => ({
    protocol: "openai-compatible" as const,
    complete: async () => ({
      content: "на фотографии кот", tool_calls: [], finish_reason: "stop" as const,
      usage: { tokens_in: 1, tokens_out: 1 }, model: provider.model,
    }),
    async *stream() { throw new Error("не используется"); },
  });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };

  // Зрячая модель стоит только в цепочке чата — фотография доходит.
  const router = new LlmRouter(
    store([blind.id, seeing.id]) as never, logger, undefined, async () => {}, adapters as never,
  );
  const result = await router.complete(fromOpenAi(IMAGE_REQUEST) as never);
  assert.equal(result.route, "vision", "ход обязан остаться на маршруте зрения");
  assert.equal(result.provider_name, "seeing", "слепая модель не должна получить картинку");

  // Зрячей модели нет вовсе — отказ остаётся, и он про возможности.
  const blindOnly = new LlmRouter(
    store([blind.id]) as never, logger, undefined, async () => {}, adapters as never,
  );
  await assert.rejects(
    () => blindOnly.complete(fromOpenAi(IMAGE_REQUEST) as never),
    (error: unknown) => error instanceof NoProviderAvailable
      && /зображени|vision/i.test(String((error as Error).message)),
  );
});

/**
 * Ход с картинкой не должен умирать оттого, что посмотреть её некому.
 *
 * Пока изображение терялось по дороге, отказ был незаметен: модель
 * отвечала вслепую. Как только картинка стала доезжать, ненастроенный
 * маршрут зрения начал ронять ход целиком — человек присылал фотографию
 * с вопросом и получал «не получилось обработать сообщение» после
 * нескольких попыток вместо ответа.
 */
test("нечем посмотреть картинку — явный отказ без слепого повтора", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const app = createRouterServer({
    apiKey: "test-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    store: {
      routes: async () => new Map([["chat", { code: "chat" }]]),
      providers: async () => [{ id: "p1" }],
      breakers: async () => new Map(),
      chains: async () => new Map(),
    } as never,
    router: {
      complete: async (request: { messages: Array<Record<string, unknown>>; metadata: { has_image?: boolean } }) => {
        seen.push(request as never);
        // Маршрут выбирается по содержимому: пока в ходе есть картинка,
        // он уходит на зрение, а обслужить его некому. Повтор помогает
        // ровно потому, что изображения в нём больше нет.
        if (request.metadata.has_image) {
          throw new NoProviderAvailable("для маршрута «vision» не назначен ни один провайдер");
        }
        return {
          response: {
            content: "Картинку посмотреть не смогла.",
            tool_calls: [], finish_reason: "stop",
            usage: { tokens_in: 3, tokens_out: 3 }, model: "eva/chat",
          },
          request_id: "r1", provider_name: "backup", switches: 0,
        };
      },
      stream: async function* () { throw new Error("не используется"); },
    } as never,
  });
  await app.ready();

  try {
    const response = await app.inject({
      method: "POST", url: "/chat/completions",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      payload: {
        model: "eva/chat",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "что на фото?" },
            { type: "image_url", image_url: { url: DATA_URI } },
          ],
        }],
      },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(seen.length, 1, "слепого повтора без изображения быть не должно");
    assert.equal((seen[0] as { metadata: { has_image?: boolean } }).metadata.has_image, true);
  } finally {
    await app.close();
  }
});

test("обычный отказ картинкой не прикрывается", async () => {
  let calls = 0;
  const app = createRouterServer({
    apiKey: "test-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    store: {
      routes: async () => new Map([["chat", { code: "chat" }]]),
      providers: async () => [{ id: "p1" }],
      breakers: async () => new Map(),
      chains: async () => new Map(),
    } as never,
    router: {
      complete: async () => {
        calls += 1;
        // Не исчерпание маршрута, а поломка: повтор её не лечит и
        // прятать её за «отвечу без картинки» нельзя.
        throw new Error("провайдер вернул мусор");
      },
      stream: async function* () { throw new Error("не используется"); },
    } as never,
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST", url: "/chat/completions",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      payload: {
        model: "eva/chat",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "что на фото?" },
            { type: "image_url", image_url: { url: DATA_URI } },
          ],
        }],
      },
    });
    assert.equal(calls, 1, "повтора без картинки быть не должно");
    assert.equal(response.statusCode, 500);
  } finally {
    await app.close();
  }
});
