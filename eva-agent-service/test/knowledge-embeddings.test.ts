/**
 * Версии эмбеддингов в агенте и панели: пакетный клиент роутера, маршрут
 * проверки модели и сервис версий admin-api.
 *
 * Правило, ради которого написаны тесты сервиса: версия заводится только
 * после удачной проверки модели. Размерность берётся из ответа
 * провайдера, запасной провайдер — только с тем же пространством.
 */

import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import Fastify from "fastify";

import { KnowledgeEmbeddingService } from "../dist/admin/knowledge-embedding-service.js";
import { registerKnowledgeRoutes } from "../dist/knowledge/routes.js";
import { knowledgeMetrics, resetKnowledgeMetrics } from "../dist/knowledge/metrics.js";
import { QdrantError } from "../dist/knowledge/qdrant-client.js";
import { assertQueryAllowed, runInScope, systemScope } from "../dist/tenancy/scope.js";
import { LlmRouterClient, LlmRouterError } from "../dist/router/client.js";

beforeEach(() => resetKnowledgeMetrics());

function router(respond: (body: any) => { status?: number; body: unknown }) {
  const calls: any[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const answer = respond(body);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { calls, client: new LlmRouterClient("http://llm-router:8073/", "key", fetcher) };
}

const answer = (texts: string[], dimension: number) => ({
  body: { data: texts.map((_text, index) => ({ index, embedding: new Array(dimension).fill(index) })) },
});

test("embedMany: пачки не больше заданного, имя модели — версия, порядок сохранён", async () => {
  const { calls, client } = router((body) => answer(body.input, 4));
  const texts = Array.from({ length: 7 }, (_, index) => `фрагмент ${index}`);
  const vectors = await client.embedMany(texts, { version: 3, dimension: 4, batchSize: 3 });
  assert.equal(vectors.length, 7);
  assert.deepEqual(calls.map((call) => call.input.length), [3, 3, 1]);
  assert.ok(calls.every((call) => call.model === "eva/embeddings@v3"));
  assert.deepEqual(vectors.map((vector) => vector[0]), [0, 1, 2, 0, 1, 2, 0]);
  const embedding = knowledgeMetrics().stages.find((row) => row.name === "embedding")!;
  assert.equal(embedding.count, 3);
  assert.equal(embedding.errors, 0);
});

test("embedMany: больше 64 за запрос роутер не принимает — пачка обрезается", async () => {
  const { calls, client } = router((body) => answer(body.input, 4));
  await client.embedMany(new Array(70).fill("x"), { version: 1, dimension: 4, batchSize: 500 });
  assert.deepEqual(calls.map((call) => call.input.length), [64, 6]);
});

test("embedMany: вектор чужой длины или неполный ответ — отказ, метрика ошибки", async () => {
  const wide = router((body) => answer(body.input, 8));
  await assert.rejects(() => wide.client.embedMany(["a"], { version: 1, dimension: 4 }), /embedding_dimension_mismatch/u);
  const short = router(() => answer(["a"], 4));
  await assert.rejects(() => short.client.embedMany(["a", "b"], { version: 1, dimension: 4 }), /embedding_incomplete/u);
  assert.equal(knowledgeMetrics().stages.find((row) => row.name === "embedding")!.errors, 2);
  await assert.rejects(() => wide.client.embedMany(["a"], { version: 0, dimension: 4 }), /embedding_version_invalid/u);
});

test("отказ роутера: код из ответа, текст ответа не пересказывается", async () => {
  const { client } = router(() => ({ status: 502, body: { error: { type: "embedding_auth", message: "эхо: договор Иванова" } } }));
  await assert.rejects(
    () => client.embedMany(["договор"], { version: 1, dimension: 4 }),
    (error: LlmRouterError) => error instanceof LlmRouterError && error.code === "embedding_auth" && error.status === 502
      && !/Иванова/u.test(error.message),
  );
  const odd = router(() => ({ status: 500, body: { error: { type: "Что-то <script>" } } }));
  await assert.rejects(() => odd.client.embedMany(["x"], { version: 1, dimension: 4 }), (error: LlmRouterError) => error.code === "router_error");
});

test("маршрут агента: проверка модели уходит в роутер без лишних полей", async () => {
  const seen: unknown[] = [];
  const app = Fastify();
  registerKnowledgeRoutes(app, {
    router: { probeEmbeddings: async (request) => { seen.push(request); return { ok: true, dimension: 1024, latency_ms: 80 }; } },
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/knowledge/embeddings/probe",
    payload: { provider_id: "p1", model: "bge-m3", dimension: 1024, request_dimensions: true, text: "чужой текст", compare: { provider_id: "p2", model: "baai/bge-m3" } },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, dimension: 1024, latency_ms: 80 });
  assert.deepEqual(seen[0], {
    provider_id: "p1", model: "bge-m3", dimension: 1024, request_dimensions: true,
    compare: { provider_id: "p2", model: "baai/bge-m3" },
  });
});

/**
 * Агент для проверки пространства: база с настоящей границей арендатора
 * (фрагменты читаются в системной области с `crossUser`) и индекс Qdrant.
 */
function spaceCheckApp(options: {
  points: Record<"global" | "private", number[] | Error>;
  vectors?: Record<number, number[]>;
  probe: (request: any) => Record<string, unknown>;
}) {
  const seen: any[] = [];
  const scrolls: Array<[string, number]> = [];
  const chunks: Record<string, Record<string, unknown>> = {
    "11": { id: "11", content: "Прокрастинация — избегание", section: "Глава 1", subsection: null, heading: null },
    "21": { id: "21", content: "Личная запись", section: null, subsection: null, heading: null },
    "22": { id: "22", content: "Ещё запись", section: null, subsection: null, heading: null },
  };
  const query = async (sql: string, params: unknown[] = []) => {
    assertQueryAllowed(sql, params);
    if (/FROM knowledge_embedding_versions/u.test(sql)) {
      return { rows: params[0] === 1 ? [{ provider_id: "p1", model: "openai/text-embedding-3-small", dimension: 8, request_dimensions: false }] : [] };
    }
    if (/FROM knowledge_chunks/u.test(sql)) return { rows: (params[0] as string[]).map((id) => chunks[String(id)]).filter(Boolean) };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 40)}`);
  };
  const app = Fastify();
  registerKnowledgeRoutes(app, {
    router: { probeEmbeddings: async (request) => { seen.push(request); return options.probe(request); } },
    db: {
      query,
      withSystemScope: async (reason: string, work: () => Promise<unknown>, scope: { crossUser?: boolean } = {}) => await runInScope(systemScope(reason, scope), work),
    } as never,
    vectors: {
      scrollPoints: async (scope: "global" | "private", _version: number, _offset: unknown, limit: number) => {
        scrolls.push([scope, limit]);
        const found = options.points[scope];
        if (found instanceof Error) throw found;
        return { points: found.slice(0, limit).map((id) => ({ id, payload: {} })), next: null };
      },
      vectorsOf: async (_scope: string, _version: number, ids: number[]) =>
        new Map(ids.map((id) => [id, options.vectors?.[id] ?? new Array(8).fill(id / 100)])),
    } as never,
  });
  return { app, seen, scrolls };
}

const missing = () => new QdrantError("qdrant_not_found", 404, "Not found");

test("проверка пространства: модель сравнивается с векторами индекса — сначала общая база, текста в ответе нет", async () => {
  const { app, seen, scrolls } = spaceCheckApp({
    points: { global: [11], private: [21, 22] },
    vectors: { 22: new Array(16).fill(0.1) },
    probe: () => ({ ok: true, dimension: 8, latency_ms: 1, reference: { ok: true, samples: 2, similarity: 0.9993, same_space: true } }),
  });
  const response = await app.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/1/space-check", payload: { provider_id: "p2", model: "text-embedding-3-small" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, basis: "index", same_space: true, similarity: 0.9993, error_code: null, samples: 2 });
  assert.doesNotMatch(response.body, /Прокрастинация|Личная запись/u);
  assert.deepEqual(scrolls, [["global", 3], ["private", 2]], "личные документы — только добором");
  // Проверяется кандидат в размерности версии; образец — текст с путём
  // заголовков, как его считала индексация; вектор чужой длины не берётся.
  assert.equal(seen[0].provider_id, "p2");
  assert.equal(seen[0].dimension, 8);
  assert.deepEqual(seen[0].reference.map((sample: { text: string }) => sample.text), ["Глава 1\nПрокрастинация — избегание", "Личная запись"]);
  assert.equal(seen[0].reference[0].vector.length, 8);
});

test("проверка пространства: индекс пуст — сравнение с основным; основной не отвечает — код его отказа", async () => {
  const { app, seen } = spaceCheckApp({
    points: { global: missing(), private: [] },
    probe: () => ({ ok: false, error_code: "embedding_payment_required", message: "нет средств" }),
  });
  const response = await app.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/1/space-check", payload: { provider_id: "p2", model: "m" } });
  assert.deepEqual(response.json(), { ok: false, basis: "primary", same_space: false, similarity: null, error_code: "embedding_payment_required", samples: 0 });
  assert.deepEqual(seen[0], {
    provider_id: "p1", model: "openai/text-embedding-3-small", dimension: 8, request_dimensions: false,
    compare: { provider_id: "p2", model: "m" },
  });

  const down = spaceCheckApp({ points: { global: new QdrantError("qdrant_unavailable", null, "down"), private: [] }, probe: () => ({ ok: true }) });
  assert.equal((await down.app.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/1/space-check", payload: { provider_id: "p2", model: "m" } })).statusCode, 503);
  assert.equal((await down.app.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/9/space-check", payload: { provider_id: "p2", model: "m" } })).statusCode, 404,
    "версии нет — Qdrant не спрашивается");
});

test("проверка пространства: неверный запрос — 400; без Qdrant — сравнение с основным", async () => {
  const { app, seen } = spaceCheckApp({ points: { global: [11], private: [] }, probe: () => ({ ok: true, dimension: 8, compare: { ok: true, similarity: 1, same_space: true } }) });
  for (const payload of [{ provider_id: "p2" }, { model: "m" }, { provider_id: " ", model: "m" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/1/space-check", payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/x/space-check", payload: { provider_id: "p2", model: "m" } })).statusCode, 400);
  assert.equal(seen.length, 0);

  const noQdrant = Fastify();
  const asked: any[] = [];
  registerKnowledgeRoutes(noQdrant, {
    router: { probeEmbeddings: async (request) => { asked.push(request); return { ok: true, dimension: 8, compare: { ok: true, similarity: 0.999, same_space: true } }; } },
    db: { query: async () => ({ rows: [{ provider_id: "p1", model: "m1", dimension: 8, request_dimensions: false }] }), withSystemScope: async () => ({ rows: [] }) } as never,
    vectors: null,
  });
  const response = await noQdrant.inject({ method: "POST", url: "/v1/knowledge/embeddings/versions/1/space-check", payload: { provider_id: "p2", model: "m" } });
  assert.deepEqual(response.json(), { ok: true, basis: "primary", same_space: true, similarity: 0.999, error_code: null, samples: 0 });
  assert.equal(asked[0].reference, undefined);
});

// ---------------------------------------------------------------------
// Сервис версий в admin-api
// ---------------------------------------------------------------------

interface VersionRow extends Record<string, unknown> { version: number; status: string }

function adminService(probe: Record<string, unknown> | ((body: any, path: string) => unknown), now?: () => number) {
  const versions: VersionRow[] = [];
  const probes: unknown[] = [];
  let sequence = 0;
  const statements: string[] = [];
  const providers = [
    { id: "p1", name: "OpenRouter", model: "openai/gpt-5" },
    { id: "p2", name: "Jina", model: "jina-chat" },
  ];
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push(sql.replace(/\s+/gu, " ").trim());
    if (/FROM llm_providers/u.test(sql)) return { rows: providers };
    if (/INSERT INTO knowledge_embedding_versions/u.test(sql)) {
      assert.match(sql, /nextval\('knowledge_embedding_version_seq'\)/u);
      sequence += 1;
      const version = sequence;
      versions.push({
        version, provider_id: params[0], provider_name: "OpenRouter", model: params[1], dimension: params[2], distance: params[3],
        request_dimensions: params[4], fallback_provider_id: params[5], fallback_provider_name: params[5] ? "Jina" : null,
        fallback_model: params[6], hnsw_m: params[7], hnsw_ef_construct: params[8], on_disk: params[9],
        status: "draft", error_code: null, created_at: new Date("2026-09-29T10:00:00Z"), built_at: null, activated_at: null, retired_at: null,
      });
      return { rows: [{ version }] };
    }
    if (/SELECT status FROM knowledge_embedding_versions/u.test(sql)) {
      return { rows: versions.filter((row) => row.version === params[0]).map((row) => ({ status: row.status })) };
    }
    if (/DELETE FROM knowledge_embedding_versions/u.test(sql)) {
      const index = versions.findIndex((row) => row.version === params[0] && ["draft", "failed"].includes(row.status));
      if (index < 0) return { rows: [] };
      versions.splice(index, 1);
      return { rows: [{ version: params[0] }] };
    }
    if (/^UPDATE knowledge_embedding_versions SET fallback_provider_id/u.test(sql)) {
      const row = versions.find((item) => item.version === params[0]);
      if (!row) return { rows: [] };
      Object.assign(row, { fallback_provider_id: params[1], fallback_model: params[2], fallback_provider_name: params[1] ? "Jina" : null });
      return { rows: [{ version: params[0] }] };
    }
    if (/FROM knowledge_embedding_versions v/u.test(sql)) return { rows: [...versions].sort((a, b) => b.version - a.version) };
    return { rows: [] };
  };
  const pool = { query };
  const agent = { request: async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    probes.push({ path, body });
    return typeof probe === "function" ? probe(body, path) : probe;
  } };
  return { service: new KnowledgeEmbeddingService(pool as never, agent as never, now), versions, probes, statements };
}

test("версия заводится после проверки: размерность — из ответа провайдера", async () => {
  const { service, probes, versions } = adminService({ ok: true, dimension: 1024, latency_ms: 90 });
  const created = await service.createVersion({ provider_id: "p1", model: "baai/bge-m3" });
  assert.equal(created.version, 1);
  assert.equal(created.dimension, 1024);
  assert.equal(created.status, "draft");
  assert.equal(created.distance, "Cosine");
  assert.deepEqual(probes[0], {
    path: "/v1/knowledge/embeddings/probe",
    body: { provider_id: "p1", model: "baai/bge-m3", dimension: null, request_dimensions: false, compare: null },
  });
  assert.equal(versions.length, 1);
});

test("проверка не прошла — версия не заводится", async () => {
  const { service, versions } = adminService({ ok: false, error_code: "embedding_auth", message: "Провайдер отклонил ключ" });
  await assert.rejects(() => service.createVersion({ provider_id: "p1", model: "m" }), /не прошла проверку/u);
  assert.equal(versions.length, 0);
});

test("заявленная размерность не совпала с ответом модели — отказ", async () => {
  const { service, versions } = adminService({ ok: true, dimension: 1536, latency_ms: 90 });
  await assert.rejects(() => service.createVersion({ provider_id: "p1", model: "m", dimension: 1024 }), /1536, а не 1024/u);
  assert.equal(versions.length, 0);
});

test("запасной провайдер с другим пространством не принимается", async () => {
  const { service, versions, probes } = adminService({
    ok: true, dimension: 1024, latency_ms: 90,
    compare: { ok: true, dimension: 1024, latency_ms: 70, similarity: 0.41, same_space: false },
  });
  await assert.rejects(
    () => service.createVersion({ provider_id: "p1", model: "baai/bge-m3", fallback_provider_id: "p2", fallback_model: "jina-embeddings-v3" }),
    /другие векторы/u,
  );
  assert.equal(versions.length, 0);
  assert.deepEqual((probes[0] as { body: { compare: unknown } }).body.compare, { provider_id: "p2", model: "jina-embeddings-v3" });
});

test("запасной провайдер того же пространства сохраняется вместе с версией", async () => {
  const { service } = adminService({
    ok: true, dimension: 1024, latency_ms: 90,
    compare: { ok: true, dimension: 1024, latency_ms: 70, similarity: 0.9999, same_space: true },
  });
  const created = await service.createVersion({ provider_id: "p1", model: "baai/bge-m3", fallback_provider_id: "p2", fallback_model: "bge-m3" });
  assert.equal(created.fallback_provider_id, "p2");
  assert.equal(created.fallback_model, "bge-m3");
});

test("провайдер вне реестра, неверная модель и полу-заданный запасной — отказ до проверки", async () => {
  const { service, probes } = adminService({ ok: true, dimension: 8, latency_ms: 1 });
  await assert.rejects(() => service.createVersion({ provider_id: "ghost", model: "m" }), /не OpenAI-совместимый/u);
  await assert.rejects(() => service.createVersion({ provider_id: "p1", model: "m; rm -rf" }), /model/u);
  await assert.rejects(() => service.createVersion({ provider_id: "p1", model: "m", fallback_provider_id: "p2" }), /вместе с моделью/u);
  await assert.rejects(() => service.createVersion({ provider_id: "p1", model: "m", request_dimensions: true }), /размерность/u);
  await assert.rejects(() => service.createVersion({ provider_id: "p1", model: "m", distance: "Manhattan" }), /Cosine/u);
  assert.equal(probes.length, 0);
});

test("номер версии — из последовательности: номер удалённого черновика не достаётся новой модели", async () => {
  const { service, statements } = adminService({ ok: true, dimension: 8, latency_ms: 1 });
  const first = await service.createVersion({ provider_id: "p1", model: "m" });
  await service.deleteVersion(String(first.version));
  const second = await service.createVersion({ provider_id: "p1", model: "other" });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.ok(statements.every((sql) => !/max\(version\)/u.test(sql)));
});

test("удалить можно только черновик или неудавшуюся версию", async () => {
  const { service, versions } = adminService({ ok: true, dimension: 8, latency_ms: 1 });
  await service.createVersion({ provider_id: "p1", model: "m" });
  await service.createVersion({ provider_id: "p1", model: "m2" });
  versions.find((row) => row.version === 2)!.status = "active";
  await assert.rejects(() => service.deleteVersion("2"), /только версию-черновик/u);
  assert.deepEqual(await service.deleteVersion("1"), { deleted: 1 });
  await assert.rejects(() => service.deleteVersion("9"), /не найдена/u);
  await assert.rejects(() => service.deleteVersion("abc"), /version/u);
});

test("обзор: активная версия и провайдеры без ключей и адресов", async () => {
  const { service, versions } = adminService({ ok: true, dimension: 8, latency_ms: 1 });
  await service.createVersion({ provider_id: "p1", model: "m" });
  versions[0]!.status = "active";
  const overview = await service.overview();
  assert.equal(overview.active, 1);
  assert.deepEqual(overview.providers, [
    { id: "p1", name: "OpenRouter", chat_model: "openai/gpt-5" },
    { id: "p2", name: "Jina", chat_model: "jina-chat" },
  ]);
  assert.doesNotMatch(JSON.stringify(overview), /api_key|base_url/u);
});

test("обзор проверяет модель активной версии: у провайдера кончились средства — так и сказано", async () => {
  let clock = Date.parse("2026-10-12T10:00:00Z");
  let answer: Record<string, unknown> = { ok: true, dimension: 8, latency_ms: 1 };
  const { service, versions, probes } = adminService(() => answer, () => clock);
  assert.equal((await service.overview()).active_check, null, "без активной версии проверять нечего");
  await service.createVersion({ provider_id: "p1", model: "openai/text-embedding-3-small" });
  probes.length = 0;
  versions[0]!.status = "active";
  answer = { ok: false, error_code: "embedding_payment_required", message: "У провайдера закончились средства" };
  const dead = await service.overview();
  assert.deepEqual(dead.active_check, {
    version: 1, ok: false, error_code: "embedding_payment_required", fallback: false, checked_at: "2026-10-12T10:00:00.000Z",
  });
  // Та же цель, что у поиска: модель и размерность версии, без сравнения.
  assert.deepEqual(probes, [{ path: "/v1/knowledge/embeddings/probe", body: {
    provider_id: "p1", model: "openai/text-embedding-3-small", dimension: 8, request_dimensions: false, compare: null,
  } }]);
  // Обзор опрашивают раз в 5 секунд: провайдер — не чаще раза в минуту.
  clock += 30_000;
  await service.overview();
  assert.equal(probes.length, 1);
  clock += 31_000;
  answer = { ok: true, dimension: 8, latency_ms: 1 };
  assert.equal((await service.overview()).active_check?.ok, true);
  assert.equal(probes.length, 2);
});

test("проверка активной модели: запасной провайдер выручает; агент недоступен — неизвестно, а не отказ", async () => {
  let primaryDead = false;
  const { service, versions } = adminService((body) => primaryDead && body.provider_id === "p1"
    ? { ok: false, error_code: "embedding_auth" }
    : { ok: true, dimension: 8, latency_ms: 1, compare: { ok: true, dimension: 8, latency_ms: 1, similarity: 1, same_space: true } });
  await service.createVersion({ provider_id: "p1", model: "m", fallback_provider_id: "p2", fallback_model: "m" });
  versions[0]!.status = "active";
  primaryDead = true;
  assert.deepEqual(
    (({ ok, error_code, fallback }) => ({ ok, error_code, fallback }))((await service.overview()).active_check!),
    { ok: true, error_code: "embedding_auth", fallback: true },
  );

  let calls = 0;
  const broken = adminService(() => { calls += 1; if (calls > 1) throw new Error("agent down"); return { ok: true, dimension: 8, latency_ms: 1 }; });
  await broken.service.createVersion({ provider_id: "p1", model: "m" });
  broken.versions[0]!.status = "active";
  assert.equal((await broken.service.overview()).active_check, null);
  assert.equal((await broken.service.overview()).active_check, null);
  assert.equal(calls, 3, "неизвестное не кэшируется");
});

test("проверка активной модели не ждёт зависшего провайдера дольше 8 секунд", async () => {
  let hang = false;
  const { service, versions } = adminService(() => hang ? new Promise(() => {}) : { ok: true, dimension: 8, latency_ms: 1 });
  await service.createVersion({ provider_id: "p1", model: "m" });
  versions[0]!.status = "active";
  hang = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = service.overview();
    // Обзор сперва читает версии и провайдеров; таймер проверки ставится после.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    mock.timers.tick(7_999);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    mock.timers.tick(1);
    const check = (await pending).active_check!;
    assert.deepEqual([check.ok, check.error_code], [false, "embedding_timeout"]);
  } finally {
    mock.timers.reset();
  }
});

test("запасной провайдер к построенной версии: то же пространство — сохраняется без переиндексации", async () => {
  let space: Record<string, unknown> = { ok: true, basis: "index", same_space: true, similarity: 0.9995, error_code: null, samples: 3 };
  let primaryDead = false;
  const { service, versions, probes, statements } = adminService((body, path) => {
    if (path.endsWith("/space-check")) return space;
    return primaryDead && body.provider_id === "p1" ? { ok: false, error_code: "embedding_payment_required" } : { ok: true, dimension: 8, latency_ms: 1 };
  });
  await service.createVersion({ provider_id: "p1", model: "openai/text-embedding-3-small" });
  versions[0]!.status = "active";
  primaryDead = true;
  assert.equal((await service.overview()).active_check?.ok, false, "у OpenRouter кончились средства");
  probes.length = 0;

  const saved = await service.setFallback("1", { fallback_provider_id: "p2", fallback_model: "text-embedding-3-small" });
  assert.equal(saved.fallback_provider_id, "p2");
  assert.equal(saved.fallback_model, "text-embedding-3-small");
  assert.deepEqual(probes[0], { path: "/v1/knowledge/embeddings/versions/1/space-check", body: { provider_id: "p2", model: "text-embedding-3-small" } });
  assert.ok(statements.some((sql) => sql.startsWith("UPDATE knowledge_embedding_versions SET fallback_provider_id")));
  // Проверка активной модели сразу учитывает запасного, а не ждёт минуту.
  const check = (await service.overview()).active_check!;
  assert.deepEqual([check.ok, check.fallback], [true, true]);

  // Другая модель — отказ с объяснением; запись не меняется.
  space = { ok: true, basis: "index", same_space: false, similarity: 0.42, error_code: null, samples: 3 };
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p2", fallback_model: "bge-m3" }), /другие векторы/u);
  assert.equal(versions[0]!.fallback_model, "text-embedding-3-small");
  space = { ok: false, basis: "index", same_space: false, similarity: null, error_code: "embedding_dimension_mismatch", samples: 3 };
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p2", fallback_model: "wide" }), /другие векторы/u);
  space = { ok: false, basis: "index", same_space: false, similarity: null, error_code: "embedding_auth", samples: 3 };
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p2", fallback_model: "wide" }), /не ответила/u);
  // Индекс пуст, а основной не ответил — сравнить не с чем.
  space = { ok: false, basis: "primary", same_space: false, similarity: null, error_code: "embedding_payment_required", samples: 0 };
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p2", fallback_model: "m2" }), /Сравнить модель не с чем/u);

  // Снять запасного — без проверки.
  probes.length = 0;
  const removed = await service.setFallback("1", { fallback_provider_id: "", fallback_model: "" });
  assert.equal(removed.fallback_provider_id, null);
  assert.equal(probes.length, 0);
});

test("проверка, начатая до смены запасного, не кэширует устаревший вердикт", async () => {
  let release: (value: unknown) => void = () => {};
  let probes = 0;
  const { service, versions } = adminService((_body, path) => {
    if (path.endsWith("/space-check")) return { ok: true, basis: "index", same_space: true, similarity: 1, error_code: null, samples: 1 };
    probes += 1;
    // Первая проверка активной модели висит, пока её не отпустят.
    return probes === 2 ? new Promise((resolve) => { release = resolve; }) : { ok: true, dimension: 8, latency_ms: 1 };
  });
  await service.createVersion({ provider_id: "p1", model: "m" });
  versions[0]!.status = "active";
  const inFlight = service.overview();
  await service.setFallback("1", { fallback_provider_id: "p2", fallback_model: "m" });
  release({ ok: false, error_code: "embedding_payment_required" });
  assert.equal((await inFlight).active_check?.ok, false);
  await service.overview();
  assert.equal(probes, 3, "следующий обзор проверяет заново, а не берёт вердикт до смены запасного");
});

test("запасной провайдер: основной вместо запасного, провайдер вне реестра, половина полей — отказ до проверки", async () => {
  const { service, probes } = adminService({ ok: true, dimension: 8, latency_ms: 1 });
  await service.createVersion({ provider_id: "p1", model: "m" });
  probes.length = 0;
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p1", fallback_model: "m" }), /основной провайдер/u);
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p9", fallback_model: "m" }), /не найден/u);
  await assert.rejects(() => service.setFallback("1", { fallback_provider_id: "p2" }), /вместе с моделью/u);
  await assert.rejects(() => service.setFallback("7", { fallback_provider_id: "p2", fallback_model: "m" }), /не найдена/u);
  assert.equal(probes.length, 0);
});

test("embedMany: нечисловой размер пачки — пачка по умолчанию, а не пустой ответ", async () => {
  const { calls, client } = router((body) => answer(body.input, 4));
  const vectors = await client.embedMany(["a", "b", "c"], { version: 1, dimension: 4, batchSize: Number.NaN });
  assert.equal(vectors.length, 3);
  assert.equal(calls.length, 1);
});

test("маршруты панели объявляют роли; изменение версий — под sudo", async () => {
  const { registerKnowledgeRoutes: registerAdminRoutes } = await import("../dist/admin/knowledge-routes.js");
  const declared = new Map<string, { roles?: string[]; sudoScope?: string }>();
  const app = Fastify();
  app.addHook("onRoute", (route) => {
    declared.set(`${String(route.method)} ${route.url}`, (route.config ?? {}) as { roles?: string[]; sudoScope?: string });
  });
  registerAdminRoutes(app, {} as never);
  await app.ready();
  assert.deepEqual(declared.get("GET /api/admin/v1/knowledge/embeddings")?.roles, ["owner", "admin", "operator", "viewer"]);
  assert.deepEqual(declared.get("POST /api/admin/v1/knowledge/embeddings/probe")?.roles, ["owner", "admin"]);
  for (const key of ["POST /api/admin/v1/knowledge/embeddings/versions", "DELETE /api/admin/v1/knowledge/embeddings/versions/:version",
    "PUT /api/admin/v1/knowledge/embeddings/versions/:version/fallback"]) {
    assert.deepEqual(declared.get(key)?.roles, ["owner", "admin"], key);
    assert.equal(declared.get(key)?.sudoScope, "settings:write", key);
  }
});
