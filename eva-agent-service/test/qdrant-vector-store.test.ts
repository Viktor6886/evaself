/**
 * Векторный индекс базы знаний: клиент Qdrant и KnowledgeVectorStore.
 *
 * Главное здесь — изоляция: личный поиск всегда несёт фильтр по владельцу,
 * а точка чужого владельца не отдаётся, даже если Qdrant её вернул. Плюс
 * то, что держит индекс производным и восстановимым: id точки — id
 * фрагмента, пространства векторов не смешиваются, alias переводится
 * одним запросом.
 *
 * Настоящий Qdrant проверяет scripts/ci/test-qdrant.mjs в CI.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { knowledgeMetrics, resetKnowledgeMetrics } from "../dist/knowledge/metrics.js";
import { QdrantClient, QdrantError } from "../dist/knowledge/qdrant-client.js";
import {
  knowledgeCollection,
  KnowledgeVectorStore,
  versionOfCollection,
} from "../dist/knowledge/vector-store.js";

interface Call { method: string; path: string; headers: Record<string, string>; body: any }

const SPACE = { version: 1, model: "text-embedding-3-small", dimension: 3, distance: "Cosine" as const };

function fakeQdrant(routes: Record<string, (call: Call) => { status?: number; result?: unknown; error?: string } | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const call: Call = {
      method: init.method ?? "GET",
      path: parsed.pathname + parsed.search,
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {})),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${parsed.pathname}`;
    const handler = routes[key] ?? routes[parsed.pathname];
    const outcome = handler ? handler(call) : { status: 404, error: "Not found" };
    if (outcome instanceof Error) throw outcome;
    const status = outcome.status ?? 200;
    const body = status >= 400 ? { status: { error: outcome.error ?? "error" } } : { result: outcome.result ?? true, status: "ok" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const client = new QdrantClient({ url: "http://qdrant:6333/", apiKey: "secret-key", fetch: fetcher });
  return { calls, client, store: new KnowledgeVectorStore(client) };
}

const point = (chunkId: number, scope: "private" | "global", extra: Record<string, unknown> = {}) => ({
  chunkId,
  vector: [0.1, 0.2, 0.3],
  payload: {
    chunk_id: chunkId,
    document_id: `doc-${chunkId}`,
    user_id: scope === "private" ? "7" : null,
    collection_id: scope === "global" ? "col-a" : null,
    page_start: 1,
    page_end: 1,
    section: null,
    mime: "application/pdf",
    embedding_model: SPACE.model,
    embedding_version: 1,
    created_at: "2026-09-29T10:00:00Z",
    ...extra,
  },
});

beforeEach(() => resetKnowledgeMetrics());

test("имена коллекций и alias: версия в имени, чужое имя — не наше", () => {
  assert.equal(knowledgeCollection("private", 2), "eva_knowledge_private_v2");
  assert.equal(knowledgeCollection("global", 1), "eva_knowledge_global_v1");
  assert.equal(versionOfCollection("eva_knowledge_global_v12"), 12);
  assert.equal(versionOfCollection("other_v1"), null);
  assert.throws(() => knowledgeCollection("private", 0), /embedding_version_invalid/);
});

test("личный поиск всегда несёт фильтр по владельцу из серверного контекста", async () => {
  const { calls, store } = fakeQdrant({
    "POST /collections/eva_knowledge_private/points/query": () => ({
      result: { points: [{ id: 11, score: 0.9, payload: { document_id: "doc-11", user_id: "7" } }] },
    }),
  });
  const hits = await store.searchPrivate(7, [0.1, 0.2, 0.3], { limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.chunkId), [11]);
  assert.deepEqual(calls[0]!.body.filter, { must: [{ key: "user_id", match: { value: "7" } }] });
  assert.equal(calls[0]!.headers["api-key"], "secret-key");

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(() => store.searchPrivate(bad, [0.1, 0.2, 0.3], { limit: 5 }), /knowledge_user_invalid/);
  }
  assert.equal(calls.length, 1, "поиск без годного владельца не должен доходить до Qdrant");
});

test("точка чужого владельца не отдаётся, даже если Qdrant её вернул", async () => {
  const { store } = fakeQdrant({
    "POST /collections/eva_knowledge_private/points/query": () => ({
      result: {
        points: [
          { id: 1, score: 0.9, payload: { document_id: "mine", user_id: "7" } },
          { id: 2, score: 0.8, payload: { document_id: "foreign", user_id: "8" } },
        ],
      },
    }),
  });
  const hits = await store.searchPrivate(7, [0.1, 0.2, 0.3], { limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.documentId), ["mine"]);
});

test("общая база ищется только по включённым коллекциям", async () => {
  const { calls, store } = fakeQdrant({
    "POST /collections/eva_knowledge_global/points/query": () => ({ result: { points: [] } }),
  });
  assert.deepEqual(await store.searchGlobal([0.1, 0.2, 0.3], [], { limit: 5 }), []);
  assert.equal(calls.length, 0, "пустой список коллекций не должен искать по всей общей базе");
  await store.searchGlobal([0.1, 0.2, 0.3], ["col-a", "col-b"], { limit: 5 });
  assert.equal(calls[0]!.path, "/collections/eva_knowledge_global/points/query", "общий поиск не ходит в личные коллекции");
  assert.deepEqual(calls[0]!.body.filter,{ must: [{ key: "collection_id", match: { any: ["col-a", "col-b"] } }] });
});

test("индекс ещё не включали — поиск пуст, а не авария", async () => {
  const { store } = fakeQdrant({});
  assert.deepEqual(await store.searchPrivate(7, [0.1, 0.2, 0.3], { limit: 5 }), []);
});

test("коллекции явно названной версии нет — отказ, а не пустой ответ", async () => {
  // PostgreSQL называет версию активной, а коллекцию потеряли: «ничего не
  // нашлось» скрыло бы потерянный индекс, поиск обязан уйти в degraded.
  const { store } = fakeQdrant({});
  await assert.rejects(
    () => store.searchPrivate(7, [0.1, 0.2, 0.3], { limit: 5, version: 3 }),
    (error: unknown) => error instanceof QdrantError && error.code === "qdrant_not_found",
  );
  await assert.rejects(
    () => store.searchGlobal([0.1, 0.2, 0.3], ["col-a"], { limit: 5, version: 3 }),
    (error: unknown) => error instanceof QdrantError && error.code === "qdrant_not_found",
  );
});

test("запись: id точки — id фрагмента, область и пространство векторов проверяются", async () => {
  const { calls, store } = fakeQdrant({ "PUT /collections/eva_knowledge_private_v1/points": () => ({ result: {} }) });
  await store.upsert("private", SPACE, [point(42, "private")]);
  assert.equal(calls[0]!.path, "/collections/eva_knowledge_private_v1/points?wait=true");
  assert.equal(calls[0]!.body.points[0].id, 42);
  assert.equal(calls[0]!.body.points[0].payload.content, undefined, "текст фрагмента не должен уходить в Qdrant");

  await assert.rejects(() => store.upsert("private", SPACE, [point(1, "private", { user_id: null })]), /knowledge_scope_invalid/);
  await assert.rejects(() => store.upsert("global", SPACE, [point(1, "global", { collection_id: null })]), /knowledge_scope_invalid/);
  await assert.rejects(() => store.upsert("global", SPACE, [point(1, "global", { user_id: "7" })]), /knowledge_scope_invalid/);
  await assert.rejects(() => store.upsert("private", SPACE, [{ ...point(1, "private"), vector: [0.1, 0.2] }]), /embedding_dimension_invalid/);
  await assert.rejects(() => store.upsert("private", SPACE, [point(1, "private", { embedding_version: 2 })]), /vector_space_mismatch/);
  assert.equal(calls.length, 1, "неверные точки не должны доходить до Qdrant");
});

test("коллекции версии: личная — графы по арендаторам, общая — обычный граф", async () => {
  const { calls, store } = fakeQdrant({
    "GET /collections/eva_knowledge_private_v1": () => ({ status: 404, error: "Not found" }),
    "GET /collections/eva_knowledge_global_v1": () => ({ status: 404, error: "Not found" }),
    "PUT /collections/eva_knowledge_private_v1": () => ({ result: true }),
    "PUT /collections/eva_knowledge_global_v1": () => ({ result: true }),
    "PUT /collections/eva_knowledge_private_v1/index": () => ({ result: {} }),
    "PUT /collections/eva_knowledge_global_v1/index": () => ({ result: {} }),
  });
  await store.ensureSpace(SPACE);
  const created = calls.filter((call) => call.method === "PUT" && !call.path.includes("/index"));
  assert.deepEqual(created[0]!.body.hnsw_config, { m: 0, payload_m: 16, ef_construct: 100, on_disk: false });
  assert.equal(created[1]!.body.hnsw_config.m, 16);
  assert.deepEqual(created[0]!.body.vectors, { size: 3, distance: "Cosine" });
  const indexes = calls.filter((call) => call.path.includes("/index")).map((call) => call.body);
  assert.deepEqual(indexes[0], { field_name: "user_id", field_schema: { type: "keyword", is_tenant: true } });
  assert.ok(indexes.some((body) => body.field_name === "collection_id"));
});

test("коллекция той же версии с другой размерностью — отказ, а не пересоздание", async () => {
  const info = { status: "green", points_count: 5, config: { params: { vectors: { size: 1536, distance: "Cosine" } } } };
  const { calls, store } = fakeQdrant({
    "GET /collections/eva_knowledge_private_v1": () => ({ result: info }),
  });
  await assert.rejects(() => store.ensureSpace(SPACE), /vector_space_mismatch/);
  assert.ok(!calls.some((call) => call.method === "PUT" || call.method === "DELETE"));
});

test("переключение alias — один запрос с удалением и созданием обеих", async () => {
  const { calls, store } = fakeQdrant({
    "GET /aliases": () => ({ result: { aliases: [{ alias_name: "eva_knowledge_private", collection_name: "eva_knowledge_private_v1" }] } }),
    "POST /collections/aliases": () => ({ result: true }),
  });
  await store.activate(2);
  const switched = calls.filter((call) => call.path === "/collections/aliases");
  assert.equal(switched.length, 1);
  assert.deepEqual(switched[0]!.body.actions, [
    { delete_alias: { alias_name: "eva_knowledge_private" } },
    { create_alias: { collection_name: "eva_knowledge_private_v2", alias_name: "eva_knowledge_private" } },
    { create_alias: { collection_name: "eva_knowledge_global_v2", alias_name: "eva_knowledge_global" } },
  ]);
});

test("активную версию удалить нельзя", async () => {
  const { store } = fakeQdrant({
    "GET /aliases": () => ({ result: { aliases: [{ alias_name: "eva_knowledge_global", collection_name: "eva_knowledge_global_v3" }] } }),
  });
  await assert.rejects(() => store.dropVersion(3), /vector_version_active/);
});

test("отказы Qdrant различимы: недоступен, таймаут, ключ, сервер", async () => {
  const cases: Array<[() => Response | Error, string]> = [
    [() => new TypeError("fetch failed"), "qdrant_unavailable"],
    [() => new Response(JSON.stringify({ status: { error: "Must provide an API key" } }), { status: 401 }), "qdrant_unauthorized"],
    [() => new Response("oops", { status: 503 }), "qdrant_server_error"],
  ];
  for (const [respond, code] of cases) {
    const client = new QdrantClient({
      url: "http://qdrant:6333",
      apiKey: "k",
      fetch: (async () => { const value = respond(); if (value instanceof Error) throw value; return value; }) as typeof fetch,
    });
    await assert.rejects(() => client.count("x"), (error: QdrantError) => error.code === code);
  }
  const slow = new QdrantClient({
    url: "http://qdrant:6333",
    apiKey: "k",
    timeoutMs: 20,
    fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch,
  });
  await assert.rejects(() => slow.count("x"), (error: QdrantError) => error.code === "qdrant_timeout" && error.transient);
});

test("проверка готовности идёт без ключа и не бросает", async () => {
  const { calls, client } = fakeQdrant({ "GET /readyz": () => ({ result: "ok" }) });
  assert.equal(await client.ready(), true);
  assert.equal(calls[0]!.headers["api-key"], undefined);
  const down = new QdrantClient({ url: "http://qdrant:6333", apiKey: "k", fetch: (async () => { throw new Error("down"); }) as typeof fetch });
  assert.equal(await down.ready(), false);
});

test("вызовы Qdrant считаются в метриках по операции и исходу", async () => {
  const { store } = fakeQdrant({
    "POST /collections/eva_knowledge_private/points/query": () => ({ result: { points: [] } }),
    "PUT /collections/eva_knowledge_private_v1/points": () => ({ status: 500, error: "boom" }),
  });
  await store.searchPrivate(7, [0.1, 0.2, 0.3], { limit: 5 });
  await assert.rejects(() => store.upsert("private", SPACE, [point(1, "private")]));
  const rows = Object.fromEntries(knowledgeMetrics().qdrant.map((row) => [row.name, row]));
  assert.equal(rows.search!.count, 1);
  assert.equal(rows.search!.errors, 0);
  assert.equal(rows.upsert!.count, 1);
  assert.equal(rows.upsert!.errors, 1);
});

test("описание отказа Qdrant доходит до вызывающего без ключа", async () => {
  const { client } = fakeQdrant({
    "PUT /collections/x/points": () => ({ status: 400, error: "Wrong input: Vector dimension error: expected dim: 4, got 3" }),
  });
  await assert.rejects(
    () => client.upsert("x", [{ id: 1, vector: [1, 2, 3], payload: {} }]),
    (error: QdrantError) => /expected dim: 4/.test(error.message) && !error.message.includes("secret-key"),
  );
});

test("payload собирается по списку полей: лишнее поле вызывающего в индекс не уходит", async () => {
  const { calls, store } = fakeQdrant({ "PUT /collections/eva_knowledge_private_v1/points": () => ({ result: {} }) });
  const withText = point(5, "private", { content: "текст фрагмента" }) as ReturnType<typeof point>;
  await store.upsert("private", SPACE, [withText]);
  const sent = calls[0]!.body.points[0].payload;
  assert.equal(sent.content, undefined);
  assert.deepEqual(Object.keys(sent).sort(), [
    "chunk_id", "collection_id", "created_at", "document_id", "embedding_model", "embedding_version",
    "mime", "page_end", "page_start", "section", "user_id",
  ]);
});

test("точка с чужим chunk_id или владельцем не той формы отклоняется до Qdrant", async () => {
  const { calls, store } = fakeQdrant({});
  await assert.rejects(() => store.upsert("private", SPACE, [point(5, "private", { chunk_id: 6 })]), /knowledge_chunk_invalid/);
  for (const owner of ["", "abc", "07", "-7"]) {
    await assert.rejects(() => store.upsert("private", SPACE, [point(5, "private", { user_id: owner })]), /knowledge_scope_invalid/);
  }
  assert.equal(calls.length, 0);
});

test("оборванное создание коллекции: недостающий индекс владельца достраивается", async () => {
  const info = (fields: string[]) => ({
    status: "green",
    points_count: 0,
    config: { params: { vectors: { size: 3, distance: "Cosine" } } },
    payload_schema: Object.fromEntries(fields.map((field) => [field, { data_type: "keyword" }])),
  });
  const { calls, store } = fakeQdrant({
    "GET /collections/eva_knowledge_private_v1": () => ({ result: info([]) }),
    "GET /collections/eva_knowledge_global_v1": () => ({ result: info(["collection_id", "document_id"]) }),
    "PUT /collections/eva_knowledge_private_v1/index": () => ({ result: {} }),
  });
  await store.ensureSpace(SPACE);
  const indexes = calls.filter((call) => call.method === "PUT").map((call) => [call.path, call.body.field_name]);
  assert.deepEqual(indexes, [
    ["/collections/eva_knowledge_private_v1/index?wait=true", "user_id"],
    ["/collections/eva_knowledge_private_v1/index?wait=true", "document_id"],
  ]);
  assert.deepEqual(calls.find((call) => call.body?.field_name === "user_id")!.body.field_schema, { type: "keyword", is_tenant: true });
});

test("отменённый заранее вызов не уходит в Qdrant и отличим от сбоя", async () => {
  const { calls, client } = fakeQdrant({ "POST /collections/x/points/count": () => ({ result: { count: 1 } }) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => client.query("x", [1], { limit: 1, signal: controller.signal }),
    (error: QdrantError) => error.code === "qdrant_cancelled" && !error.transient,
  );
  assert.equal(calls.length, 0);
});

test("таймаут при чтении тела ответа — тот же отказ сервиса, а не сырой AbortError", async () => {
  const client = new QdrantClient({
    url: "http://qdrant:6333",
    apiKey: "k",
    timeoutMs: 20,
    fetch: (async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    })) as unknown as typeof fetch,
  });
  await assert.rejects(() => client.count("x"), (error: QdrantError) => error instanceof QdrantError && error.code === "qdrant_timeout");
});

test("нечисловой limit поиска — ошибка вызывающего, а не запрос с null", async () => {
  const { calls, store } = fakeQdrant({});
  await assert.rejects(() => store.searchPrivate(7, [0.1, 0.2, 0.3], { limit: Number.NaN }), /knowledge_limit_invalid/);
  assert.equal(calls.length, 0);
});

test("отмена хода во время вызова — qdrant_cancelled, а не недоступность", async () => {
  const controller = new AbortController();
  const client = new QdrantClient({
    url: "http://qdrant:6333",
    apiKey: "k",
    fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      controller.abort();
    })) as typeof fetch,
  });
  await assert.rejects(
    () => client.query("x", [1], { limit: 1, signal: controller.signal }),
    (error: QdrantError) => error.code === "qdrant_cancelled",
  );
});

test("точки по документам: значение со счётом 0 (удалённый документ) не считается документом индекса", async () => {
  const { store } = fakeQdrant({
    "POST /collections/eva_knowledge_private_v1/facet": () => ({
      result: { hits: [{ value: "doc-a", count: 3 }, { value: "doc-deleted", count: 0 }] },
    }),
  });
  assert.deepEqual(Object.fromEntries(await store.documentPointCounts("private", 1, 100)), { "doc-a": 3 });
});

test("удаление документа без строки в PostgreSQL: владелец личной базы входит в фильтр", async () => {
  const { calls, store } = fakeQdrant({ "POST /collections/eva_knowledge_private_v1/points/delete": () => ({ result: {} }) });
  await store.deleteDocuments("private", 1, ["doc-a"], 7);
  assert.deepEqual(calls[0]!.body, {
    filter: { must: [{ key: "document_id", match: { any: ["doc-a"] } }, { key: "user_id", match: { value: "7" } }] },
  });
  await assert.rejects(() => store.deleteDocuments("global", 1, ["doc-a"], 7), /knowledge_scope_invalid/u);
  await assert.rejects(() => store.deleteDocuments("private", 1, ["doc-a"], 0), /knowledge_user_invalid/u);
});

test("векторы по id: только найденные и только числовые; чужая версия снимается по фильтру", async () => {
  const { calls, store } = fakeQdrant({
    "POST /collections/eva_knowledge_private_v1/points": () => ({
      result: [{ id: 11, vector: [0.1, 0.2, 0.3] }, { id: 12, vector: { named: [1] } }, { id: 13, vector: [0.1, "x"] }],
    }),
    "POST /collections/eva_knowledge_global_v2/points/count": () => ({ result: { count: 2 } }),
    "POST /collections/eva_knowledge_global_v2/points/delete": () => ({ result: {} }),
  });
  const vectors = await store.vectorsOf("private", 1, [11, 12, 13, 14]);
  assert.deepEqual([...vectors], [[11, [0.1, 0.2, 0.3]]]);
  assert.deepEqual(calls[0]!.body, { ids: [11, 12, 13, 14], with_payload: false, with_vector: true });

  assert.equal(await store.removeForeignVersion("global", 2), 2);
  const filter = { must_not: [{ key: "embedding_version", match: { value: 2 } }] };
  assert.deepEqual(calls.slice(1).map((call) => [call.path.split("?")[0], call.body]), [
    ["/collections/eva_knowledge_global_v2/points/count", { exact: true, filter }],
    ["/collections/eva_knowledge_global_v2/points/delete", { filter }],
  ]);
});
