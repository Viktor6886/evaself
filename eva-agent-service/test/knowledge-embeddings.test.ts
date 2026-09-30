/**
 * Версии эмбеддингов в агенте и панели: пакетный клиент роутера, маршрут
 * проверки модели и сервис версий admin-api.
 *
 * Правило, ради которого написаны тесты сервиса: версия заводится только
 * после удачной проверки модели. Размерность берётся из ответа
 * провайдера, запасной провайдер — только с тем же пространством.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import Fastify from "fastify";

import { KnowledgeEmbeddingService } from "../dist/admin/knowledge-embedding-service.js";
import { registerKnowledgeRoutes } from "../dist/knowledge/routes.js";
import { knowledgeMetrics, resetKnowledgeMetrics } from "../dist/knowledge/metrics.js";
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

// ---------------------------------------------------------------------
// Сервис версий в admin-api
// ---------------------------------------------------------------------

interface VersionRow extends Record<string, unknown> { version: number; status: string }

function adminService(probe: Record<string, unknown>) {
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
    if (/FROM knowledge_embedding_versions v/u.test(sql)) return { rows: [...versions].sort((a, b) => b.version - a.version) };
    return { rows: [] };
  };
  const pool = { query };
  const agent = { request: async (path: string, init?: RequestInit) => { probes.push({ path, body: JSON.parse(String(init?.body)) }); return probe; } };
  return { service: new KnowledgeEmbeddingService(pool as never, agent as never), versions, probes, statements };
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
  for (const key of ["POST /api/admin/v1/knowledge/embeddings/versions", "DELETE /api/admin/v1/knowledge/embeddings/versions/:version"]) {
    assert.deepEqual(declared.get(key)?.roles, ["owner", "admin"], key);
    assert.equal(declared.get(key)?.sudoScope, "settings:write", key);
  }
});
