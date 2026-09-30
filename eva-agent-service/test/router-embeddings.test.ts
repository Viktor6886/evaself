/**
 * Эмбеддинги через LLM Router: цель по провайдеру и модели, версии базы
 * знаний с запасным провайдером, проверка модели и маршруты роутера.
 *
 * Главное здесь — то, что не видно по зелёному ответу: вектор другой
 * длины или неполный ответ не записывается, текст ответа провайдера (эхо
 * документов человека) не уходит в сообщение об ошибке, а проверка модели
 * считает вектор своей строки, а не чужого текста.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EmbeddingService, PROBE_TEXT } from "../dist/router/embedding-service.js";
import { EmbeddingVersionStore, embeddingVersionOf } from "../dist/router/embedding-versions.js";
import { EmbeddingError, RouterEmbeddings } from "../dist/router/embeddings.js";
import { createRouterServer } from "../dist/router/server.js";

const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `provider-${id}`,
  protocol: "openai-compatible",
  base_url: `https://${id}.example/v1`,
  model: "chat-model",
  api_key: `key-${id}`,
  request_timeout_ms: 5_000,
  generation_defaults: {},
  additional_parameters: {},
  ...extra,
});

interface Sent { url: string; body: any; headers: Record<string, string> }

function upstream(respond: (sent: Sent) => Response | Error | Promise<Response>) {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    sent.push(call);
    const result = await respond(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { sent, fetcher };
}

const vectors = (count: number, dimension: number, value = 0.5) => ({
  data: Array.from({ length: count }, (_, index) => ({ index, embedding: new Array(dimension).fill(value + index / 100) })),
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function embeddings(fetcher: typeof fetch, providers = [provider("a"), provider("b")], timeoutMs?: number) {
  return new RouterEmbeddings({ providers: async () => providers as never }, {
    model: "text-embedding-3-small",
    dimension: 1536,
    fetch: fetcher,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

function versionStore(rows: Record<number, Record<string, unknown>>) {
  let queries = 0;
  const store = new EmbeddingVersionStore({
    query: (async (_sql: string, params: unknown[]) => {
      queries += 1;
      const row = rows[Number(params[0])];
      return { rows: row ? [row] : [] };
    }) as never,
  });
  return { store, queries: () => queries };
}

const VERSION_ROW = {
  version: 2,
  provider_id: "a",
  model: "bge-m3",
  dimension: 4,
  request_dimensions: false,
  fallback_provider_id: "b",
  fallback_model: "baai/bge-m3",
  status: "active",
};

test("имя модели роутера: версия базы знаний или прежняя цель", () => {
  assert.equal(embeddingVersionOf("eva/embeddings@v3"), 3);
  assert.equal(embeddingVersionOf("eva/embeddings"), null);
  assert.equal(embeddingVersionOf("eva/embeddings@v0"), null);
  assert.equal(embeddingVersionOf("eva/embeddings@v3; drop"), null);
  assert.equal(embeddingVersionOf(undefined), null);
});

test("цель: провайдер по id, модель и dimensions — только когда версия их просит", async () => {
  const { sent, fetcher } = upstream(() => ok(vectors(2, 4)));
  const result = await embeddings(fetcher).embedWith({ providerId: "b", model: "m", dimension: 4 }, ["один", "два"]);
  assert.equal(result.length, 2);
  assert.equal(sent[0]!.url, "https://b.example/v1/embeddings");
  assert.deepEqual(sent[0]!.body, { model: "m", input: ["один", "два"] });
  assert.match(String(sent[0]!.headers.authorization ?? sent[0]!.headers.Authorization), /key-b/);

  await embeddings(fetcher).embedWith({ providerId: "a", model: "m", dimension: 4, requestDimensions: true }, ["x"]).catch(() => undefined);
  assert.equal(sent[1]!.body.dimensions, 4);
});

test("порядок векторов — по index ответа, а не по порядку строк", async () => {
  const { fetcher } = upstream(() => ok({ data: [
    { index: 1, embedding: [2, 2, 2, 2] },
    { index: 0, embedding: [1, 1, 1, 1] },
  ] }));
  const result = await embeddings(fetcher).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["первый", "второй"]);
  assert.deepEqual(result.map((vector) => vector[0]), [1, 2]);
});

test("неполный ответ и чужая размерность — отказ, а не запись", async () => {
  const short = upstream(() => ok(vectors(1, 4)));
  await assert.rejects(
    () => embeddings(short.fetcher).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["a", "b"]),
    (error: EmbeddingError) => error.code === "embedding_incomplete",
  );
  const wide = upstream(() => ok(vectors(1, 8)));
  await assert.rejects(
    () => embeddings(wide.fetcher).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["a"]),
    (error: EmbeddingError) => error.code === "embedding_dimension_mismatch",
  );
  const broken = upstream(() => ok({ data: [{ index: 0, embedding: [1, "x", 1, 1] }] }));
  await assert.rejects(
    () => embeddings(broken.fetcher).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["a"]),
    (error: EmbeddingError) => error.code === "embedding_incomplete",
  );
});

test("отказ провайдера — код, без текста его ответа", async () => {
  const cases: Array<[number, string]> = [
    [401, "embedding_auth"], [404, "embedding_not_found"], [400, "embedding_bad_request"],
    [429, "embedding_rate_limited"], [503, "embedding_unavailable"],
  ];
  for (const [status, code] of cases) {
    const { fetcher } = upstream(() => new Response(JSON.stringify({ error: { message: "echo: секретный договор Иванова" } }), { status }));
    await assert.rejects(
      () => embeddings(fetcher).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["секретный договор"]),
      (error: EmbeddingError) => error.code === code && !/Иванова|секретный/u.test(error.message),
    );
  }
  const down = upstream(() => new TypeError("fetch failed: https://a.example key-a"));
  await assert.rejects(
    () => embeddings(down.fetcher).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["x"]),
    (error: EmbeddingError) => error.code === "embedding_unavailable" && !error.message.includes("key-a"),
  );
});

test("провайдер не найден или не OpenAI-совместимый — отдельные коды", async () => {
  const { fetcher, sent } = upstream(() => ok(vectors(1, 4)));
  await assert.rejects(
    () => embeddings(fetcher).embedWith({ providerId: "missing", model: "m", dimension: 4 }, ["x"]),
    (error: EmbeddingError) => error.code === "embedding_provider_missing",
  );
  await assert.rejects(
    () => embeddings(fetcher, [provider("a", { protocol: "anthropic-compatible" })]).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["x"]),
    (error: EmbeddingError) => error.code === "embedding_protocol_unsupported",
  );
  assert.equal(sent.length, 0);
});

test("таймаут провайдера — embedding_timeout", async () => {
  const fetcher = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  await assert.rejects(
    () => embeddings(fetcher, [provider("a")], 20).embedWith({ providerId: "a", model: "m", dimension: 4 }, ["x"]),
    (error: EmbeddingError) => error.code === "embedding_timeout",
  );
});

test("прежняя цель по-прежнему: модель из окружения, 1536", async () => {
  const { fetcher, sent } = upstream(() => ok(vectors(1, 1536)));
  const service = new EmbeddingService(embeddings(fetcher), versionStore({}).store);
  const result = await service.embed("eva/embeddings", ["x"]);
  assert.equal(result.dimension, 1536);
  assert.equal(result.model, "eva/embeddings");
  assert.equal(sent[0]!.body.model, "text-embedding-3-small");
});

test("версия: основной провайдер, при отказе — запасной с той же размерностью", async () => {
  const { fetcher, sent } = upstream((call) => call.url.startsWith("https://a.")
    ? new Response("down", { status: 503 })
    : ok(vectors(2, 4)));
  const { store } = versionStore({ 2: VERSION_ROW });
  const result = await new EmbeddingService(embeddings(fetcher), store).embed("eva/embeddings@v2", ["a", "b"]);
  assert.equal(result.fallback, true);
  assert.equal(result.model, "eva/embeddings@v2");
  assert.deepEqual(sent.map((call) => [new URL(call.url).host, call.body.model]), [["a.example", "bge-m3"], ["b.example", "baai/bge-m3"]]);
});

test("версия без запасного: отказ основного — отказ; выведенная и неизвестная — отказ до провайдера", async () => {
  const { fetcher, sent } = upstream(() => new Response("down", { status: 503 }));
  const { store } = versionStore({
    2: { ...VERSION_ROW, fallback_provider_id: null, fallback_model: null },
    3: { ...VERSION_ROW, version: 3, status: "retired" },
  });
  const service = new EmbeddingService(embeddings(fetcher), store);
  await assert.rejects(() => service.embed("eva/embeddings@v2", ["a"]), (error: EmbeddingError) => error.code === "embedding_unavailable");
  const before = sent.length;
  await assert.rejects(() => service.embed("eva/embeddings@v3", ["a"]), /выведена/u);
  await assert.rejects(() => service.embed("eva/embeddings@v9", ["a"]), /нет/u);
  assert.equal(sent.length, before);
});

test("версии кэшируются: пачки индексации не ходят в PostgreSQL на каждый запрос", async () => {
  const { fetcher } = upstream(() => ok(vectors(1, 4)));
  const counter = versionStore({ 2: VERSION_ROW });
  const service = new EmbeddingService(embeddings(fetcher), counter.store);
  await service.embed("eva/embeddings@v2", ["a"]);
  await service.embed("eva/embeddings@v2", ["b"]);
  assert.equal(counter.queries(), 1);
});

test("проверка модели: своя строка, размерность из ответа, задержка", async () => {
  let clock = 1_000;
  const { fetcher, sent } = upstream(() => { clock += 120; return ok(vectors(1, 1024)); });
  const result = await new EmbeddingService(embeddings(fetcher), versionStore({}).store, () => clock)
    .probe({ providerId: "a", model: "bge-m3" });
  assert.deepEqual(result, { ok: true, dimension: 1024, latency_ms: 120 });
  assert.deepEqual(sent[0]!.body.input, [PROBE_TEXT]);
});

test("проверка запасного: то же пространство — сходство около единицы, другое — нет", async () => {
  const same = upstream(() => ok({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
  const sameResult = await new EmbeddingService(embeddings(same.fetcher), versionStore({}).store)
    .probe({ providerId: "a", model: "bge-m3", compare: { providerId: "b", model: "baai/bge-m3" } });
  assert.equal(sameResult.ok && sameResult.compare?.ok && sameResult.compare.same_space, true);

  const different = upstream((call) => ok({ data: [{ index: 0, embedding: call.url.startsWith("https://a.") ? [1, 0, 0, 0] : [0, 1, 0, 0] }] }));
  const differentResult = await new EmbeddingService(embeddings(different.fetcher), versionStore({}).store)
    .probe({ providerId: "a", model: "bge-m3", compare: { providerId: "b", model: "other" } });
  assert.ok(differentResult.ok && differentResult.compare?.ok);
  assert.equal(differentResult.ok && differentResult.compare?.ok && differentResult.compare.same_space, false);
});

test("проверка: отказ провайдера — ответ проверки с кодом, а не исключение", async () => {
  const { fetcher } = upstream(() => new Response("nope", { status: 401 }));
  const result = await new EmbeddingService(embeddings(fetcher), versionStore({}).store).probe({ providerId: "a", model: "m" });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error_code, "embedding_auth");
});

function routerApp(service: EmbeddingService) {
  return createRouterServer({
    apiKey: "router-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
    store: { providers: async () => [], breakers: async () => new Map(), routes: async () => new Map(), chains: async () => new Map() } as never,
    router: {} as never,
    embeddings: service,
  });
}

test("маршрут /embeddings: версия, размерность и признак запасного в ответе; 502 с кодом при отказе", async () => {
  const { fetcher } = upstream((call) => call.url.startsWith("https://a.") ? ok(vectors(1, 4)) : ok(vectors(1, 4)));
  const app = routerApp(new EmbeddingService(embeddings(fetcher), versionStore({ 2: VERSION_ROW }).store));
  const headers = { authorization: "Bearer router-key" };
  const good = await app.inject({ method: "POST", url: "/embeddings", headers, payload: { model: "eva/embeddings@v2", input: ["a"] } });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().model, "eva/embeddings@v2");
  assert.equal(good.json().dimension, 4);
  assert.equal(good.json().fallback, false);

  assert.equal((await app.inject({ method: "POST", url: "/embeddings", payload: { input: ["a"] } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/embeddings", headers, payload: { input: new Array(65).fill("a") } })).statusCode, 400);
  const unknown = await app.inject({ method: "POST", url: "/embeddings", headers, payload: { model: "eva/embeddings@v9", input: ["a"] } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.type, "embedding_version_unknown");

  const failing = routerApp(new EmbeddingService(
    embeddings(upstream(() => new Response("echo текста", { status: 401 })).fetcher),
    versionStore({ 2: { ...VERSION_ROW, fallback_provider_id: null, fallback_model: null } }).store,
  ));
  const refused = await failing.inject({ method: "POST", url: "/embeddings", headers, payload: { model: "eva/embeddings@v2", input: ["a"] } });
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json().error.type, "embedding_auth");
  assert.doesNotMatch(refused.body, /echo текста/u);
});

test("маршрут /embeddings/probe: неверный запрос — 400 без вызова провайдера", async () => {
  const { fetcher, sent } = upstream(() => ok(vectors(1, 4)));
  const app = routerApp(new EmbeddingService(embeddings(fetcher), versionStore({}).store));
  const headers = { authorization: "Bearer router-key" };
  for (const payload of [{ model: "m" }, { provider_id: "a" }, { provider_id: "a", model: "m", dimension: 3 }, { provider_id: "a", model: "m", compare: { provider_id: "b" } }]) {
    assert.equal((await app.inject({ method: "POST", url: "/embeddings/probe", headers, payload })).statusCode, 400);
  }
  assert.equal(sent.length, 0);
  const done = await app.inject({ method: "POST", url: "/embeddings/probe", headers, payload: { provider_id: "a", model: "m" } });
  assert.equal(done.json().ok, true);
  assert.equal(done.json().dimension, 4);
});

test("отсутствие версии не кэшируется: заведённая только что версия видна сразу", async () => {
  const { fetcher } = upstream(() => ok(vectors(1, 4)));
  const rows: Record<number, Record<string, unknown>> = {};
  const counter = versionStore(rows);
  const service = new EmbeddingService(embeddings(fetcher), counter.store);
  await assert.rejects(() => service.embed("eva/embeddings@v2", ["a"]), /нет/u);
  rows[2] = VERSION_ROW;
  const result = await service.embed("eva/embeddings@v2", ["a"]);
  assert.equal(result.model, "eva/embeddings@v2");
});

test("неизвестное имя модели — отказ, а не прежняя цель: опечатка в версии не даёт чужих векторов", async () => {
  const { fetcher, sent } = upstream(() => ok(vectors(1, 1536)));
  const service = new EmbeddingService(embeddings(fetcher), versionStore({}).store);
  for (const model of ["eva/embeddings@v0", "eva/embeddings@v3; drop", "text-embedding-3-small", "", 42]) {
    await assert.rejects(() => service.embed(model, ["a"]), (error: Error & { code?: string }) => error.code === "embedding_model_unknown");
  }
  assert.equal(sent.length, 0);
  // Прежние вызовы: точное имя и запрос без поля model.
  assert.equal((await service.embed("eva/embeddings", ["a"])).dimension, 1536);
  assert.equal((await service.embed(undefined, ["a"])).dimension, 1536);

  const app = routerApp(service);
  const response = await app.inject({
    method: "POST", url: "/embeddings", headers: { authorization: "Bearer router-key" },
    payload: { model: "eva/embeddings@v0", input: ["a"] },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.type, "embedding_model_unknown");
});
