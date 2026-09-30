/**
 * Индексация базы знаний в Qdrant и конвейер загрузки.
 *
 * Главное: документ читается только в области своего владельца, точки
 * личной базы несут владельца, а общей — коллекцию; повтор идемпотентен
 * (id точки — id фрагмента, лишние точки снимаются), отказ оставляет
 * документ `failed` с кодом, а задание индексации пишется в той же
 * транзакции, что и фрагменты.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KNOWLEDGE_INDEX_JOB, KnowledgeIndexer, knowledgeIndexScheduler } from "../dist/knowledge/indexer.js";
import { KnowledgeIngestWorker } from "../dist/knowledge/lifecycle.js";

interface Query { sql: string; params: unknown[]; scope: string }

const VERSION = { version: 2, model: "bge-m3", dimension: 3, distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false };

function fakeDb(state: { versions: unknown[]; document: Record<string, unknown> | null; chunks: unknown[] }) {
  const queries: Query[] = [];
  let scope = "none";
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql: sql.replace(/\s+/gu, " ").trim(), params, scope });
    if (/FROM knowledge_embedding_versions/u.test(sql)) return { rows: state.versions };
    if (/FROM knowledge_documents/u.test(sql)) return { rows: state.document ? [state.document] : [] };
    if (/FROM knowledge_chunks/u.test(sql)) return { rows: state.chunks };
    return { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    withUserScope: async (options: { userId: number }, work: () => Promise<unknown>) => {
      const previous = scope;
      scope = `user:${options.userId}`;
      try { return await work(); } finally { scope = previous; }
    },
    withSystemScope: async (_label: string, work: () => Promise<unknown>) => {
      const previous = scope;
      scope = "system";
      try { return await work(); } finally { scope = previous; }
    },
    transaction: async (work: (client: { query: typeof query }) => Promise<unknown>) => await work({ query }),
  };
  return { db, queries };
}

function fakeStore() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    store: {
      ensureSpace: async (...args: unknown[]) => { calls.push({ method: "ensureSpace", args }); },
      upsert: async (...args: unknown[]) => { calls.push({ method: "upsert", args }); },
      pruneDocument: async (...args: unknown[]) => { calls.push({ method: "pruneDocument", args }); },
    },
  };
}

const router = (dimension = 3) => {
  const calls: Array<{ texts: string[]; options: Record<string, unknown> }> = [];
  return {
    calls,
    router: {
      embedMany: async (texts: string[], options: Record<string, unknown>) => {
        calls.push({ texts, options });
        return texts.map(() => new Array(dimension).fill(0.5));
      },
    },
  };
};

const PRIVATE_DOC = { id: "doc-1", user_id: "7", collection_id: null, mime: "application/pdf", created_at: new Date("2026-09-30T10:00:00Z") };
const CHUNKS = [
  { id: "11", content: "Аренда продлена.", section: "1. Аренда", subsection: null, heading: "1. Аренда", page_start: 1, page_end: 1 },
  { id: "12", content: "Пеня 0,1%.", section: "2. Оплата", subsection: "2.1 Штрафы", heading: "2.1 Штрафы", page_start: 2, page_end: 2 },
];

const options = (enabled = true) => ({ enabled: () => enabled, batchSize: () => 16 });

test("личный документ: точки с владельцем, id — фрагмент, текст с путём заголовков, лишнее снято", async () => {
  const { db, queries } = fakeDb({ versions: [VERSION], document: PRIVATE_DOC, chunks: CHUNKS });
  const { calls, store } = fakeStore();
  const embed = router();
  const indexer = new KnowledgeIndexer(db as never, embed.router as never, store as never, options());

  const outcome = await indexer.index("doc-1", 7);
  assert.deepEqual(outcome, { status: "ready", versions: [2], chunks: 2 });

  // Документ и фрагменты читаются только в области владельца.
  const reads = queries.filter((query) => /FROM knowledge_(documents|chunks)/u.test(query.sql));
  assert.ok(reads.every((query) => query.scope === "user:7" && /user_id = \$2/u.test(query.sql) && query.params[1] === 7));

  assert.deepEqual(embed.calls[0]!.texts, ["1. Аренда\nАренда продлена.", "2. Оплата › 2.1 Штрафы\nПеня 0,1%."]);
  assert.deepEqual(embed.calls[0]!.options, { version: 2, dimension: 3, batchSize: 16 });

  const upsert = calls.find((call) => call.method === "upsert")!;
  assert.equal(upsert.args[0], "private");
  const points = upsert.args[2] as Array<{ chunkId: number; payload: Record<string, unknown> }>;
  assert.deepEqual(points.map((point) => point.chunkId), [11, 12]);
  assert.deepEqual(points[1]!.payload, {
    chunk_id: 12, document_id: "doc-1", user_id: "7", collection_id: null, page_start: 2, page_end: 2,
    section: "2. Оплата", mime: "application/pdf", embedding_model: "bge-m3", embedding_version: 2,
    created_at: "2026-09-30T10:00:00.000Z",
  });
  assert.deepEqual(calls.find((call) => call.method === "pruneDocument")!.args, ["private", 2, "doc-1", [11, 12]]);

  // Статусы: indexing → ready с версией.
  const updates = queries.filter((query) => query.sql.startsWith("UPDATE knowledge_documents"));
  assert.deepEqual(updates.map((query) => query.params[2]), ["indexing", "ready"]);
  assert.equal(updates[1]!.params[3], 2);
});

test("несколько версий: документ попадает в каждую, пространство создаётся один раз", async () => {
  const { db } = fakeDb({ versions: [{ ...VERSION, version: 1 }, VERSION], document: PRIVATE_DOC, chunks: CHUNKS });
  const { calls, store } = fakeStore();
  const indexer = new KnowledgeIndexer(db as never, router().router as never, store as never, options());
  await indexer.index("doc-1", 7);
  await indexer.index("doc-1", 7);
  assert.equal(calls.filter((call) => call.method === "ensureSpace").length, 2, "по одному разу на версию на процесс");
  assert.deepEqual(calls.filter((call) => call.method === "pruneDocument").map((call) => call.args[1]), [1, 2, 1, 2]);
});

test("индексация выключена или версии нет — документ не трогается", async () => {
  for (const [enabled, versions, reason] of [[false, [VERSION], "index_disabled"], [true, [], "no_version"]] as const) {
    const { db, queries } = fakeDb({ versions: [...versions], document: PRIVATE_DOC, chunks: CHUNKS });
    const { calls, store } = fakeStore();
    const outcome = await new KnowledgeIndexer(db as never, router().router as never, store as never, options(enabled)).index("doc-1", 7);
    assert.deepEqual(outcome, { status: "skipped", reason });
    assert.equal(calls.length, 0);
    assert.ok(!queries.some((query) => query.sql.startsWith("UPDATE")));
  }
});

test("общая база: точки несут коллекцию, без коллекции — отказ с кодом", async () => {
  const globalDoc = { ...PRIVATE_DOC, user_id: null, collection_id: "col-1" };
  const { db, queries } = fakeDb({ versions: [VERSION], document: globalDoc, chunks: CHUNKS });
  const { calls, store } = fakeStore();
  await new KnowledgeIndexer(db as never, router().router as never, store as never, options()).index("doc-1", null);
  const reads = queries.filter((query) => /FROM knowledge_(documents|chunks)/u.test(query.sql));
  assert.ok(reads.every((query) => query.scope === "system" && /user_id IS NULL AND product_verified/u.test(query.sql)));
  const upsert = calls.find((call) => call.method === "upsert")!;
  assert.equal(upsert.args[0], "global");
  assert.equal((upsert.args[2] as Array<{ payload: Record<string, unknown> }>)[0]!.payload.collection_id, "col-1");

  const orphan = fakeDb({ versions: [VERSION], document: { ...globalDoc, collection_id: null }, chunks: CHUNKS });
  await assert.rejects(
    () => new KnowledgeIndexer(orphan.db as never, router().router as never, fakeStore().store as never, options()).index("doc-1", null),
    /knowledge_collection_missing/u,
  );
  const failed = orphan.queries.find((query) => query.sql.startsWith("UPDATE"))!;
  assert.deepEqual([failed.params[1], failed.params[3]], ["failed", "knowledge_collection_missing"]);
});

test("отказ Qdrant или провайдера: документ failed с кодом, задание уходит на повтор", async () => {
  const { db, queries } = fakeDb({ versions: [VERSION], document: PRIVATE_DOC, chunks: CHUNKS });
  const store = {
    ensureSpace: async () => undefined,
    upsert: async () => { throw Object.assign(new Error("Qdrant недоступен: секрет договора"), { code: "qdrant_unavailable" }); },
    pruneDocument: async () => undefined,
  };
  await assert.rejects(() => new KnowledgeIndexer(db as never, router().router as never, store as never, options()).index("doc-1", 7), /Qdrant недоступен/u);
  const last = queries.filter((query) => query.sql.startsWith("UPDATE")).at(-1)!;
  assert.deepEqual([last.params[2], last.params[4]], ["failed", "qdrant_unavailable"]);
  assert.ok(!queries.some((query) => query.params.some((param) => String(param).includes("секрет"))), "текст ошибки не пишется в базу");
});

test("документ не найден в области владельца — пропуск, а не чужой документ", async () => {
  const { db } = fakeDb({ versions: [VERSION], document: null, chunks: [] });
  const { calls, store } = fakeStore();
  const outcome = await new KnowledgeIndexer(db as never, router().router as never, store as never, options()).index("doc-x", 8);
  assert.deepEqual(outcome, { status: "skipped", reason: "document_missing" });
  assert.equal(calls.length, 0);
});

test("планировщик: задание индексации без текста, ключ повтора — документ и причина", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const scheduler = knowledgeIndexScheduler({ record: async (_client: unknown, intent: Record<string, unknown>) => { recorded.push(intent); return { idempotencyKey: "", duplicate: false }; } } as never, () => true);
  await scheduler.schedule({} as never, { documentId: "doc-1", userId: 7, reason: "ingest" });
  await scheduler.schedule({} as never, { documentId: "doc-2", userId: null, reason: "rebuild" });
  assert.equal(recorded[0]!.type, KNOWLEDGE_INDEX_JOB);
  assert.equal(recorded[0]!.queue, "memory");
  assert.equal(recorded[0]!.idempotencyKey, "knowledge_index:u7:doc-1:ingest");
  assert.deepEqual(recorded[0]!.payload, { document_id: "doc-1", reason: "ingest" });
  assert.equal(recorded[1]!.idempotencyKey, "knowledge_index:system:doc-2:rebuild");
  assert.equal(recorded[1]!.source, "system");
});

test("загрузка: фрагменты со структурой и задание индексации — одной транзакцией", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-ingest-"));
  const path = join(root, "upload");
  await writeFile(path, "# Договор\nАренда продлена до марта.\n\n## Оплата\nДо 5 числа.");
  const queries: Array<{ sql: string; params: unknown[]; inTransaction: boolean }> = [];
  let inTransaction = false;
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql: sql.replace(/\s+/gu, " ").trim(), params, inTransaction });
    if (/SELECT storage_path/u.test(sql)) return { rows: [{ storage_path: path, name: "Договор.md", mime: "text/markdown", status: "queued" }] };
    return { rows: [] };
  };
  const scheduled: unknown[] = [];
  for (const enabled of [true, false]) {
    queries.length = 0;
    scheduled.length = 0;
    const db = {
      query,
      withUserScope: async (_options: unknown, work: () => Promise<unknown>) => await work(),
      transaction: async (work: (client: unknown) => Promise<unknown>) => {
        inTransaction = true;
        try { return await work({ query }); } finally { inTransaction = false; }
      },
    };
    const worker = new KnowledgeIngestWorker(db as never, {
      tempRoot: root,
      scan: async () => "clean",
      embed: async () => new Array(1536).fill(0),
      embedBatch: async (texts: string[]) => texts.map(() => new Array(1536).fill(0)),
      chunking: () => ({ size: 500, overlap: 0 }),
      index: { enabled: () => enabled, schedule: async (_client: unknown, input: unknown) => { scheduled.push({ input, inTransaction }); } },
    });
    await worker.run({ envelope: { payloadRef: "up-1", userId: 7 }, signal: new AbortController().signal } as never);

    const chunkInserts = queries.filter((item) => item.sql.startsWith("INSERT INTO knowledge_chunks"));
    assert.equal(chunkInserts.length, 2);
    assert.ok(chunkInserts.every((item) => item.inTransaction));
    // $8..$13: page_start, page_end, section, subsection, heading, token_count
    assert.deepEqual(chunkInserts.map((item) => [item.params[9], item.params[10], item.params[11]]), [
      ["Договор", null, "Договор"],
      ["Договор", "Оплата", "Оплата"],
    ]);
    const document = queries.find((item) => item.sql.startsWith("INSERT INTO knowledge_documents"))!;
    assert.equal(document.params[2], 2, "chunk_count");
    assert.deepEqual(scheduled, enabled ? [{ input: { documentId: "up-1", userId: 7, reason: "ingest" }, inTransaction: true }] : []);
  }
});
