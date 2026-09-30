// Векторный индекс базы знаний против настоящего Qdrant.
//
// Тесты агента подменяют fetch и проверяют, что уходит в Qdrant. Здесь —
// что Qdrant с этим делает: понимает ли он форму коллекций и индексов,
// держит ли фильтр арендатора, переводит ли alias атомарно, отдаёт ли
// отказ с объяснением. Версия Qdrant в CI — та же, что в versions.env.

import assert from "node:assert/strict";

import { QdrantClient, QdrantError } from "../../eva-agent-service/dist/knowledge/qdrant-client.js";
import { knowledgeCollection, KnowledgeVectorStore } from "../../eva-agent-service/dist/knowledge/vector-store.js";

const url = process.env.QDRANT_TEST_URL ?? "http://127.0.0.1:6333";
const apiKey = process.env.QDRANT_TEST_API_KEY ?? "ci-qdrant-key";

const client = new QdrantClient({ url, apiKey });
const store = new KnowledgeVectorStore(client);

const space = (version, dimension = 4) => ({ version, model: `ci-model-v${version}`, dimension, distance: "Cosine" });

const point = (chunkId, vector, owner, extra = {}) => ({
  chunkId,
  vector,
  payload: {
    chunk_id: chunkId,
    document_id: owner.document,
    user_id: owner.user ?? null,
    collection_id: owner.collection ?? null,
    page_start: 1,
    page_end: 1,
    section: null,
    mime: "text/plain",
    embedding_model: "ci-model-v1",
    embedding_version: 1,
    created_at: "2026-09-29T10:00:00Z",
    ...extra,
  },
});

// Сервис CI стартует вместе с job и к этому шагу обычно давно готов, но
// ждать его — дело проверки, а не удачи.
for (let attempt = 0; !(await client.ready()); attempt += 1) {
  if (attempt >= 60) throw new Error(`Qdrant не готов по адресу ${url}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function raw(method, path) {
  const response = await fetch(`${url}${path}`, { method, headers: { "api-key": apiKey } });
  return await response.json();
}

// Повторный прогон на том же сервере начинается с чистого листа: удаление
// коллекции удаляет и её alias.
for (const collection of (await raw("GET", "/collections")).result.collections) {
  if (collection.name.startsWith("eva_knowledge_")) await raw("DELETE", `/collections/${collection.name}`);
}

// Готовность — без ключа; всё остальное без ключа — отказ, а не пустой ответ.
assert.equal(await client.ready(), true, "Qdrant не готов");
await assert.rejects(
  () => new QdrantClient({ url, apiKey: "wrong" }).count("anything"),
  (error) => error instanceof QdrantError && error.code === "qdrant_unauthorized",
);

// Индекс ещё не включали: alias нет, поиск пуст, а не авария.
assert.deepEqual(await store.searchPrivate(7, [1, 0, 0, 0], { limit: 5 }), []);
assert.deepEqual(await store.activeVersions(), { private: null, global: null });

// Коллекции версии создаются один раз и принимают свою форму.
await store.ensureSpace(space(1));
await store.ensureSpace(space(1));
const described = await store.describe(1);
assert.equal(described.private.size, 4);
assert.equal(described.global.distance, "Cosine");
const privateInfo = await raw("GET", `/collections/${knowledgeCollection("private", 1)}`);
assert.equal(privateInfo.result.config.hnsw_config.m, 0, "у личной базы нет общего графа по всем людям");
assert.equal(privateInfo.result.payload_schema.user_id.params?.is_tenant, true, "user_id должен быть полем-арендатором");
await assert.rejects(() => store.ensureSpace(space(1, 5)), /vector_space_mismatch/);

// Оборванное создание: коллекция есть, индексов нет. Повторный
// ensureSpace достраивает индекс владельца, а не молча принимает её.
await client.createCollection(knowledgeCollection("private", 9), { size: 4, distance: "Cosine", hnsw: { m: 0, payload_m: 16 }, indexes: [] });
await client.createCollection(knowledgeCollection("global", 9), { size: 4, distance: "Cosine", indexes: [] });
await store.ensureSpace(space(9));
const repaired = await raw("GET", `/collections/${knowledgeCollection("private", 9)}`);
assert.equal(repaired.result.payload_schema.user_id?.params?.is_tenant, true, "индекс владельца не достроен");
assert.ok(repaired.result.payload_schema.document_id, "индекс документа не достроен");
await store.dropVersion(9);

// Точки двух людей. Точка человека 8 ближе к запросу, чем любая точка
// человека 7, — поиск человека 7 всё равно не должен её увидеть.
await store.upsert("private", space(1), [
  point(101, [1, 0, 0, 0.1], { user: "7", document: "doc-7a" }),
  point(102, [0.5, 0.5, 0, 0], { user: "7", document: "doc-7a" }),
  point(103, [0, 1, 0, 0], { user: "7", document: "doc-7b" }),
  point(201, [1, 0, 0, 0], { user: "8", document: "doc-8a" }),
]);
await store.upsert("global", space(1), [
  point(301, [1, 0, 0, 0], { collection: "col-a", document: "doc-ga" }),
  point(302, [1, 0, 0.1, 0], { collection: "col-b", document: "doc-gb" }),
]);

// До перевода alias поиск по-прежнему пуст: новая версия невидима, пока
// её не включили. Проверка версии по имени коллекции видит её сразу.
assert.deepEqual(await store.searchPrivate(7, [1, 0, 0, 0], { limit: 5 }), []);
assert.equal((await store.searchPrivate(7, [1, 0, 0, 0], { limit: 5, version: 1 })).length, 3);

await store.activate(1);
assert.deepEqual(await store.activeVersions(), { private: 1, global: 1 });

const mine = await store.searchPrivate(7, [1, 0, 0, 0], { limit: 10 });
assert.deepEqual(mine.map((hit) => hit.chunkId), [101, 102, 103]);
assert.ok(mine.every((hit) => hit.payload.user_id === "7"));
assert.deepEqual((await store.searchPrivate(8, [1, 0, 0, 0], { limit: 10 })).map((hit) => hit.chunkId), [201]);
assert.deepEqual(await store.searchPrivate(9, [1, 0, 0, 0], { limit: 10 }), []);

assert.deepEqual((await store.searchGlobal([1, 0, 0, 0], ["col-b"], { limit: 10 })).map((hit) => hit.chunkId), [302]);
assert.deepEqual(
  (await store.searchGlobal([1, 0, 0, 0], ["col-a", "col-b"], { limit: 10 })).map((hit) => hit.chunkId),
  [301, 302],
);
assert.equal((await store.searchGlobal([0, 0, 0, 1], ["col-a"], { limit: 10, scoreThreshold: 0.5 })).length, 0);

// Повтор записи заменяет точку: id точки — id фрагмента.
await store.upsert("private", space(1), [point(101, [1, 0, 0, 0.1], { user: "7", document: "doc-7a" })]);
assert.equal(await store.countPoints("private", 1), 4);

// Сверка: точки по документам и страницы id без векторов.
assert.deepEqual(
  Object.fromEntries(await store.documentPointCounts("private", 1, 100)),
  { "doc-7a": 2, "doc-7b": 1, "doc-8a": 1 },
);
const pages = [];
let offset = null;
do {
  const page = await store.scrollChunkIds("private", 1, offset, 3);
  pages.push(...page.chunkIds);
  offset = page.next;
} while (offset !== null);
assert.deepEqual(pages.sort((a, b) => a - b), [101, 102, 103, 201]);

// Переиндексация документа: лишние точки (фрагментов больше нет) снимаются,
// нужные остаются, чужие документы не задеты.
await store.upsert("private", space(1), [point(104, [0.2, 0.2, 0.2, 0.2], { user: "7", document: "doc-7a" })]);
await store.pruneDocument("private", 1, "doc-7a", [101, 102]);
assert.deepEqual(
  Object.fromEntries(await store.documentPointCounts("private", 1, 100)),
  { "doc-7a": 2, "doc-7b": 1, "doc-8a": 1 },
  "pruneDocument снял не то",
);

// Удаление: документа, отдельных фрагментов и всей личной базы человека.
await store.deleteDocuments("private", 1, ["doc-7b"]);
assert.deepEqual((await store.searchPrivate(7, [0, 1, 0, 0], { limit: 10 })).map((hit) => hit.chunkId).sort(), [101, 102]);
await store.deleteChunks("private", 1, [102]);
await store.deleteUser(1, 8);
assert.deepEqual((await store.searchPrivate(8, [1, 0, 0, 0], { limit: 10 })), []);
assert.equal(await store.countPoints("private", 1), 1, "удаление человека 8 не должно задеть человека 7");

// Смена модели: новая пара коллекций другой размерности, перевод alias
// одним запросом, старая версия остаётся для отката, активную не удалить.
const next = space(2, 3);
await store.ensureSpace(next);
await store.upsert("private", next, [point(101, [1, 0, 0], { user: "7", document: "doc-7a" }, { embedding_model: next.model, embedding_version: 2 })]);
await store.activate(2);
assert.deepEqual(await store.activeVersions(), { private: 2, global: 2 });
assert.deepEqual((await store.searchPrivate(7, [1, 0, 0], { limit: 5 })).map((hit) => hit.payload.embedding_version), [2]);
await assert.rejects(() => store.dropVersion(2), /vector_version_active/);
assert.equal(await store.countPoints("private", 1), 1, "прежняя версия хранится для отката");

// Откат — тот же перевод alias назад.
await store.activate(1);
assert.deepEqual((await store.searchPrivate(7, [1, 0, 0, 0], { limit: 5 })).map((hit) => hit.chunkId), [101]);
await store.activate(2);
await store.dropVersion(1);
assert.equal((await store.describe(1)).private, null);

// Отказ Qdrant объясняет себя: неверная размерность видна администратору.
await assert.rejects(
  () => client.upsert(knowledgeCollection("private", 2), [{ id: 999, vector: [1, 0, 0, 0], payload: {} }]),
  (error) => error instanceof QdrantError && error.code === "qdrant_bad_request" && /dim/i.test(error.message),
);

// Снимок создаётся внутри тома Qdrant.
assert.match(await client.createSnapshot(knowledgeCollection("global", 2)), /\.snapshot$/);

console.log("qdrant: индекс, изоляция арендаторов, alias и сверка — PASS");
