import assert from "node:assert/strict";
import { test } from "node:test";

import { KnowledgeVersionError, validateKnowledgeVersion } from "../dist/knowledge/version-validation.js";
import { adminScope, assertQueryAllowed, runInScope } from "../dist/tenancy/scope.js";

const SPACE = { version: 2, model: "bge-m3", dimension: 8, distance: "Cosine" as const };
const ROWS = [
  { id: "11", document_id: "doc-7", user_id: "7", collection_id: null },
  { id: "12", document_id: "doc-8", user_id: "8", collection_id: null },
  { id: "21", document_id: "doc-global", user_id: null, collection_id: "enabled" },
];
const point = (row: typeof ROWS[number]) => ({ id: Number(row.id), payload: {
  chunk_id: Number(row.id), document_id: row.document_id, user_id: row.user_id, collection_id: row.collection_id,
  embedding_model: SPACE.model, embedding_version: SPACE.version,
} });

function fixture() {
  const queries: string[] = [];
  const points = { private: ROWS.slice(0, 2).map(point), global: ROWS.slice(2).map(point) };
  const info = { size: 8, distance: "Cosine", status: "green", points: 0 };
  const store = {
    describe: async () => ({ private: { ...info }, global: { ...info } }),
    scrollPoints: async (scope: "private" | "global") => ({ points: points[scope], next: null as number | string | null }),
    countPoints: async (scope: "private" | "global") => points[scope].length,
  };
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      assertQueryAllowed(sql, values);
      queries.push(sql);
      if (sql.startsWith("LOCK")) return { rows: [] };
      const global = sql.includes("c.user_id IS NULL AND d.user_id IS NULL");
      const canonical = ROWS.filter((row) => (row.user_id === null) === global);
      assert.match(sql, /d.status = 'ready'/u);
      if (global) assert.match(sql, /c.product_verified AND d.product_verified AND d.collection_id IS NOT NULL/u);
      else assert.match(sql, /d.user_id = c.user_id/u);
      if (sql.includes("count(*)")) return { rows: [{ total: String(canonical.length) }] };
      return { rows: canonical.filter((row) => (values[0] as number[]).includes(Number(row.id))) };
    },
  };
  return { store, client, points, info, queries,
    validate: async () => await runInScope(adminScope({ actor: "owner", role: "owner", auditId: "proof", route: "activate" }),
      async () => await validateKnowledgeVersion(client as never, store as never, SPACE)) };
}

test("полнота: каждый id и tenant payload проверяются по PG в обоих пространствах под SHARE lock", async () => {
  const f = fixture();
  assert.deepEqual(await f.validate(), { private: 2, global: 1 });
  assert.equal(f.queries[0], "LOCK TABLE knowledge_documents, knowledge_chunks IN SHARE MODE");
  assert.ok(f.queries.filter((q) => !q.startsWith("LOCK")).every((q) => !q.includes("content")));
});

test("одинакового числа точек недостаточно: сирота вместо канонического id отклоняется", async () => {
  const f = fixture();
  f.points.private[0]!.id = 99;
  f.points.private[0]!.payload.chunk_id = 99;
  await assert.rejects(() => f.validate(), (e: KnowledgeVersionError) => e.code === "knowledge_index_incomplete");
});

test("подмена владельца, документа, коллекции, модели или версии отклоняется", async () => {
  for (const [scope, field, value] of [
    ["private", "user_id", "8"], ["private", "collection_id", "other"], ["private", "document_id", "doc-8"],
    ["private", "chunk_id", 12], ["global", "collection_id", "disabled"], ["global", "user_id", "7"],
    ["global", "embedding_model", "different-model"], ["private", "embedding_version", 1],
  ] as const) {
    const f = fixture();
    (f.points[scope][0]!.payload as Record<string, unknown>)[field] = value;
    await assert.rejects(() => f.validate(), (e: KnowledgeVersionError) => e.code === "knowledge_index_incomplete", field);
  }
});

test("неполный индекс, неверная размерность, distance, отсутствие коллекции и нездоровый Qdrant не активируются", async () => {
  const missing = fixture();
  missing.points.private.pop();
  await assert.rejects(() => missing.validate(), /Не все фрагменты/u);
  for (const patch of [{ size: 1536 }, { distance: "Dot" }, { status: "red" }]) {
    const f = fixture(); Object.assign(f.info, patch);
    await assert.rejects(() => f.validate(), (e: KnowledgeVersionError) => ["vector_space_mismatch", "knowledge_index_unhealthy"].includes(e.code));
  }
  const gone = fixture();
  gone.store.describe = async () => ({ private: null, global: gone.info }) as never;
  await assert.rejects(() => gone.validate(), (e: KnowledgeVersionError) => e.code === "vector_space_mismatch");
});

test("дубли id, зацикленный cursor и изменение exact count во время проверки отклоняются", async () => {
  const duplicated = fixture();
  duplicated.points.private.push(duplicated.points.private[0]!);
  await assert.rejects(() => duplicated.validate(), /повторяющиеся/u);
  const looping = fixture();
  looping.store.scrollPoints = async () => ({ points: [], next: "cursor" });
  await assert.rejects(() => looping.validate(), /некорректную страницу/u);
  const changed = fixture();
  changed.store.countPoints = async () => 999;
  await assert.rejects(() => changed.validate(), /Не все фрагменты/u);
});

test("несколько страниц проверяются целиком, чужие UUID point ids не принимаются", async () => {
  const paged = fixture();
  paged.store.scrollPoints = async (scope, _version?: number, offset?: number | string | null) => scope === "private"
    ? { points: [paged.points.private[offset === null ? 0 : 1]!], next: offset === null ? 11 : null }
    : { points: paged.points.global, next: null };
  assert.deepEqual(await paged.validate(), { private: 2, global: 1 });
  const uuid = fixture();
  uuid.points.private[0]!.id = "a0000000-0000-0000-0000-000000000000" as never;
  await assert.rejects(() => uuid.validate(), /неверные/u);
});
