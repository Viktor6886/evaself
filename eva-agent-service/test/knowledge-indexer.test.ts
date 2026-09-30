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
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KNOWLEDGE_INDEX_JOB, KnowledgeIndexer, knowledgeIndexScheduler } from "../dist/knowledge/indexer.js";
import { KnowledgeIngestWorker } from "../dist/knowledge/lifecycle.js";
import { QdrantError } from "../dist/knowledge/qdrant-client.js";
import { assertQueryAllowed, currentScope, runInScope, systemScope, userScope } from "../dist/tenancy/scope.js";

interface Query { sql: string; params: unknown[]; scope: string; inTransaction: boolean }

const VERSION = { version: 2, model: "bge-m3", dimension: 3, distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false };

function scopeName(): string {
  const scope = currentScope();
  if (!scope) return "none";
  if (scope.kind === "user") return `user:${scope.userId}`;
  if (scope.kind === "system") return scope.crossUser ? "system:cross" : "system";
  return "admin";
}

/**
 * База-фейк с настоящей границей арендатора: каждый запрос проходит
 * `assertQueryAllowed` в той области, которую открыл код. Запрос к общей
 * базе (`user_id IS NULL`) в системной области без `crossUser` здесь
 * падает так же, как упал бы в работе.
 */
function guardedDb(respond: (sql: string, params: unknown[]) => { rows: unknown[] } | undefined) {
  const queries: Query[] = [];
  let inTransaction = false;
  const query = async (sql: string, params: unknown[] = []) => {
    assertQueryAllowed(sql, params);
    queries.push({ sql: sql.replace(/\s+/gu, " ").trim(), params, scope: scopeName(), inTransaction });
    return respond(sql, params) ?? { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    withUserScope: async (options: { userId: number; label: string; inherit?: boolean }, work: () => Promise<unknown>) =>
      options.inherit && currentScope() ? await work() : await runInScope(userScope({ userId: options.userId, label: options.label }), work),
    withSystemScope: async (reason: string, work: () => Promise<unknown>, options: { crossUser?: boolean; inherit?: boolean } = {}) =>
      options.inherit && currentScope() ? await work() : await runInScope(systemScope(reason, options), work),
    transaction: async (work: (client: { query: typeof query }) => Promise<unknown>) => {
      inTransaction = true;
      try { return await work({ query }); } finally { inTransaction = false; }
    },
  };
  return { db, queries };
}

function fakeDb(state: {
  versions: unknown[];
  document: Record<string, unknown> | null;
  chunks: unknown[];
  previousChunks?: unknown[];
  upload?: boolean;
}) {
  return guardedDb((sql, params) => {
    if (/^\s*DELETE FROM knowledge_documents/u.test(sql)) return { rows: (params[0] as string[]).map((id) => ({ id })) };
    if (/FROM knowledge_embedding_versions/u.test(sql)) return { rows: state.versions };
    if (/FROM knowledge_documents/u.test(sql)) return { rows: state.document ? [state.document] : [] };
    if (/FROM knowledge_chunks/u.test(sql)) {
      return { rows: state.document && params[0] === state.document.id ? state.chunks : state.previousChunks ?? [] };
    }
    if (/^\s*SELECT 1 FROM knowledge_uploads/u.test(sql)) return { rows: state.upload ? [{ "?column?": 1 }] : [] };
    return undefined;
  });
}

function fakeStore(vectors: Map<number, number[]> | Error = new Map()) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    store: {
      ensureSpace: async (...args: unknown[]) => { calls.push({ method: "ensureSpace", args }); },
      upsert: async (...args: unknown[]) => { calls.push({ method: "upsert", args }); },
      pruneDocument: async (...args: unknown[]) => { calls.push({ method: "pruneDocument", args }); },
      deleteDocuments: async (...args: unknown[]) => { calls.push({ method: "deleteDocuments", args }); },
      vectorsOf: async (...args: unknown[]) => {
        calls.push({ method: "vectorsOf", args });
        if (vectors instanceof Error) throw vectors;
        return vectors;
      },
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

function jobsLog() {
  const scheduled: Array<{ input: Record<string, unknown>; inTransaction?: boolean }> = [];
  return { scheduled, jobs: { schedule: async (_client: unknown, input: Record<string, unknown>) => { scheduled.push({ input }); } } };
}

const options = (enabled = true, extra: Record<string, unknown> = {}) => ({
  enabled: () => enabled,
  configured: () => true,
  batchSize: () => 16,
  uploadsRoot: "/nonexistent",
  jobs: jobsLog().jobs,
  ...extra,
});

test("личный документ: точки с владельцем, id — фрагмент, текст с путём заголовков, лишнее снято", async () => {
  const { db, queries } = fakeDb({ versions: [VERSION], document: PRIVATE_DOC, chunks: CHUNKS });
  const { calls, store } = fakeStore();
  const embed = router();
  const indexer = new KnowledgeIndexer(db as never, embed.router as never, store as never, options());

  const outcome = await indexer.index("doc-1", 7);
  assert.deepEqual(outcome, { status: "ready", versions: [2], chunks: 2, reused: 0 });

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
  // Системная область с доступом к строкам без владельца: без `crossUser`
  // граница отвергла бы запрос `user_id IS NULL` (фейк проверяет это
  // настоящей `assertQueryAllowed`).
  assert.ok(reads.every((query) => query.scope === "system:cross" && /user_id IS NULL AND product_verified/u.test(query.sql)));
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

const DOC_X = "0b6f3c1e-5a1d-4c8e-9f21-7d3a2b1c0e99";

test("документа нет в области владельца: снимаются его точки под этим владельцем во всех версиях и исходный файл", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-index-remove-"));
  await mkdir(join(root, "8"), { recursive: true });
  await writeFile(join(root, "8", DOC_X), "исходный файл");
  const retired = { ...VERSION, version: 1 };
  const { db, queries } = fakeDb({ versions: [retired, VERSION], document: null, chunks: [] });
  const { calls, store } = fakeStore();
  const embed = router();
  const outcome = await new KnowledgeIndexer(db as never, embed.router as never, store as never, options(false, { uploadsRoot: root }))
    .index(DOC_X, 8);

  // Флаг индексации выключен, а следы удалённого документа снимаются всё
  // равно: исходный файл — данные человека.
  assert.deepEqual(outcome, { status: "removed", versions: [1, 2] });
  assert.ok(queries.some((query) => /status IN \('building', 'ready', 'active', 'retired'\)/u.test(query.sql)),
    "выведенная версия тоже: откат на неё не должен вернуть удалённое");
  assert.deepEqual(calls.map((call) => [call.method, ...call.args]), [
    ["deleteDocuments", "private", 1, [DOC_X], 8],
    ["deleteDocuments", "private", 2, [DOC_X], 8],
  ]);
  assert.equal(embed.calls.length, 0);
  assert.deepEqual(await readdir(join(root, "8")), [], "исходный файл удалён");
  const reads = queries.filter((query) => /FROM knowledge_(documents|uploads)/u.test(query.sql));
  assert.ok(reads.every((query) => query.scope === "user:8" && query.params[1] === 8));

  // Файл, на который ещё ссылается загрузка, не удаляется.
  await writeFile(join(root, "8", DOC_X), "исходный файл");
  const referenced = fakeDb({ versions: [VERSION], document: null, chunks: [], upload: true });
  await new KnowledgeIndexer(referenced.db as never, router().router as never, fakeStore().store as never, options(true, { uploadsRoot: root }))
    .index(DOC_X, 8);
  assert.deepEqual(await readdir(join(root, "8")), [DOC_X]);

  // Коллекции версии нет — снимать нечего; прочий отказ Qdrant — повтор,
  // но исходный файл к этому моменту уже удалён: это данные человека.
  await writeFile(join(root, "8", DOC_X), "исходный файл");
  const missing = fakeStore();
  missing.store.deleteDocuments = async () => { throw Object.assign(new QdrantError("qdrant_not_found", 404, "Not found"), {}); };
  const noCollection = await new KnowledgeIndexer(db as never, router().router as never, missing.store as never, options(true, { uploadsRoot: root }))
    .index(DOC_X, 8);
  assert.equal(noCollection.status, "removed");
  await writeFile(join(root, "8", DOC_X), "исходный файл");
  const down = fakeStore();
  down.store.deleteDocuments = async () => { throw new QdrantError("qdrant_unavailable", null, "Qdrant недоступен"); };
  await assert.rejects(() => new KnowledgeIndexer(db as never, router().router as never, down.store as never, options(true, { uploadsRoot: root }))
    .index(DOC_X, 8), /Qdrant недоступен/u);
  assert.deepEqual(await readdir(join(root, "8")), [], "файл удалён до обращения к Qdrant");

  // Без ключа Qdrant точек нет — снимать их не у кого.
  const unconfigured = fakeStore();
  await new KnowledgeIndexer(db as never, router().router as never, unconfigured.store as never, options(true, { uploadsRoot: root, configured: () => false }))
    .index(DOC_X, 8);
  assert.equal(unconfigured.calls.length, 0);
});

const PREVIOUS = "5c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5";

test("новая версия документа: векторы неизменённых фрагментов берутся из прежней, прежняя снимается после индексации", async () => {
  const previousChunks = [
    { ...CHUNKS[0], id: "5" },
    { ...CHUNKS[1], id: "6", content: "Пеня 0,5%." },
  ];
  const { db, queries } = fakeDb({
    versions: [VERSION],
    document: { ...PRIVATE_DOC, replaces_document_id: PREVIOUS },
    chunks: CHUNKS,
    previousChunks,
  });
  const { calls, store } = fakeStore(new Map([[5, [0.1, 0.2, 0.3]], [6, [0.9, 0.9, 0.9]]]));
  const embed = router();
  const log = jobsLog();
  const outcome = await new KnowledgeIndexer(db as never, embed.router as never, store as never, options(true, { jobs: log.jobs }))
    .index("doc-1", 7);

  assert.equal(outcome.status, "ready");
  assert.equal((outcome as { reused: number }).reused, 1);
  // Прежние фрагменты читаются в области того же владельца.
  const previousRead = queries.find((query) => /FROM knowledge_chunks/u.test(query.sql) && query.params[0] === PREVIOUS)!;
  assert.deepEqual([previousRead.scope, previousRead.params[1]], ["user:7", 7]);
  assert.deepEqual(calls.find((call) => call.method === "vectorsOf")!.args.slice(0, 3), ["private", 2, [5]]);
  // Провайдер считает только изменённый фрагмент.
  assert.deepEqual(embed.calls.map((call) => call.texts), [["2. Оплата › 2.1 Штрафы\nПеня 0,1%."]]);
  const points = calls.find((call) => call.method === "upsert")!.args[2] as Array<{ vector: number[] }>;
  assert.deepEqual(points[0]!.vector, [0.1, 0.2, 0.3], "вектор неизменённого фрагмента — из прежней версии");

  // Прежняя версия снимается после того, как новая помечена ready, — в
  // транзакции, вместе с заданием снять её точки и файл.
  const ready = queries.findIndex((query) => query.sql.startsWith("UPDATE knowledge_documents") && query.params[2] === "ready");
  const removal = queries.findIndex((query) => query.sql.startsWith("DELETE FROM knowledge_documents"));
  assert.ok(ready >= 0 && removal > ready);
  assert.equal(queries[removal]!.inTransaction, true);
  assert.deepEqual(queries[removal]!.params, [[PREVIOUS], 7]);
  assert.deepEqual(log.scheduled.map((item) => item.input), [{ documentId: PREVIOUS, userId: 7, reason: "delete" }]);
});

test("векторы прежней версии не прочитались — считаются заново, индексация не падает", async () => {
  const { db } = fakeDb({
    versions: [VERSION],
    document: { ...PRIVATE_DOC, replaces_document_id: PREVIOUS },
    chunks: CHUNKS,
    previousChunks: [{ ...CHUNKS[0], id: "5" }],
  });
  const embed = router();
  const outcome = await new KnowledgeIndexer(db as never, embed.router as never, fakeStore(new Error("qdrant_timeout")).store as never, options())
    .index("doc-1", 7);
  assert.equal((outcome as { reused: number }).reused, 0);
  assert.equal(embed.calls[0]!.texts.length, 2);
});

test("перестройка одной версии: пишется только она, состояние документа и прежняя версия не трогаются", async () => {
  const { db, queries } = fakeDb({
    versions: [{ ...VERSION, version: 1 }, VERSION],
    document: { ...PRIVATE_DOC, replaces_document_id: PREVIOUS },
    chunks: CHUNKS,
  });
  const { calls, store } = fakeStore();
  const outcome = await new KnowledgeIndexer(db as never, router().router as never, store as never, options())
    .index("doc-1", 7, undefined, { versions: [2] });
  assert.deepEqual((outcome as { versions: number[] }).versions, [2]);
  assert.deepEqual(calls.filter((call) => call.method === "upsert").map((call) => (call.args[1] as { version: number }).version), [2]);
  assert.ok(!queries.some((query) => /^(UPDATE|DELETE) knowledge_documents|^DELETE FROM knowledge_documents/u.test(query.sql)));
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

const UPLOAD = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9";
const EXISTING = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

interface IngestSetup {
  userId: number | null;
  /** null — записи приёма нет: человек очистил базу, пока задание ждало. */
  upload?: Record<string, unknown> | null;
  duplicate?: string | null;
  previous?: { id: string; revision: number } | null;
  enabled?: boolean;
}

async function ingest(setup: IngestSetup) {
  const root = await mkdtemp(join(tmpdir(), "eva-ingest-"));
  const path = join(root, "upload");
  await writeFile(path, "# Договор\nАренда продлена до марта.\n\n## Оплата\nДо 5 числа.");
  const upload = {
    storage_path: path, name: "Договор.md", mime: "text/markdown", status: "queued", content_hash: "hash-1",
    collection_id: setup.userId === null ? "col-1" : null, replaces_document_id: null, ...setup.upload,
  };
  const { db, queries } = guardedDb((sql, params) => {
    if (/SELECT storage_path/u.test(sql)) return { rows: setup.upload === null ? [] : [upload] };
    if (/SELECT id FROM knowledge_documents/u.test(sql)) return { rows: setup.duplicate ? [{ id: setup.duplicate }] : [] };
    if (/SELECT id,revision FROM knowledge_documents/u.test(sql)) return { rows: setup.previous ? [setup.previous] : [] };
    if (/^\s*DELETE FROM knowledge_documents/u.test(sql)) return { rows: (params[0] as string[]).map((id) => ({ id })) };
    return undefined;
  });
  const scheduled: Array<{ input: unknown; inTransaction: boolean }> = [];
  let transactionOpen = false;
  const transaction = db.transaction;
  db.transaction = async (work) => {
    transactionOpen = true;
    try { return await transaction(work); } finally { transactionOpen = false; }
  };
  const worker = new KnowledgeIngestWorker(db as never, {
    tempRoot: root,
    scan: async () => "clean",
    embed: async () => new Array(1536).fill(0),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(1536).fill(0)),
    chunking: () => ({ size: 500, overlap: 0 }),
    index: {
      enabled: () => setup.enabled ?? true,
      schedule: async (_client: unknown, input: unknown) => { scheduled.push({ input, inTransaction: transactionOpen }); },
    },
  });
  await worker.run({ envelope: { payloadRef: UPLOAD, userId: setup.userId }, signal: new AbortController().signal } as never);
  return { queries, scheduled, root };
}

test("загрузка: фрагменты со структурой и задание индексации — одной транзакцией", async () => {
  for (const enabled of [true, false]) {
    const { queries, scheduled } = await ingest({ userId: 7, enabled });

    const chunkInserts = queries.filter((item) => item.sql.startsWith("INSERT INTO knowledge_chunks"));
    assert.equal(chunkInserts.length, 2);
    assert.ok(chunkInserts.every((item) => item.inTransaction && item.scope === "user:7"));
    // $9..$14: page_start, page_end, section, subsection, heading, token_count
    assert.deepEqual(chunkInserts.map((item) => [item.params[10], item.params[11], item.params[12]]), [
      ["Договор", null, "Договор"],
      ["Договор", "Оплата", "Оплата"],
    ]);
    assert.deepEqual(chunkInserts.map((item) => [item.params[1], item.params[2]]), [[7, false], [7, false]], "владелец, не общая база");
    const document = queries.find((item) => item.sql.startsWith("INSERT INTO knowledge_documents"))!;
    assert.deepEqual(document.params, [UPLOAD, 7, 2, 1, null], "chunk_count, первая ревизия, без прежней версии");
    assert.deepEqual(scheduled, enabled ? [{ input: { documentId: UPLOAD, userId: 7, reason: "ingest" }, inTransaction: true }] : []);
    const done = queries.find((item) => /SET status='ready',outcome=/u.test(item.sql))!;
    assert.deepEqual(done.params, [UPLOAD, 7, "new", UPLOAD]);
  }
});

test("дубликат: тот же файл у того же человека — второй документ не заводится, файл удалён", async () => {
  const { queries, scheduled, root } = await ingest({ userId: 7, duplicate: EXISTING });
  const lookup = queries.find((item) => /SELECT id FROM knowledge_documents/u.test(item.sql))!;
  assert.deepEqual([lookup.scope, lookup.params], ["user:7", [7, "hash-1"]]);
  assert.ok(!queries.some((item) => /^INSERT INTO knowledge_(documents|chunks)/u.test(item.sql)));
  const done = queries.find((item) => /SET status='ready',outcome=/u.test(item.sql))!;
  assert.deepEqual(done.params, [UPLOAD, 7, "duplicate", EXISTING]);
  assert.deepEqual(scheduled, []);
  assert.ok(!(await readdir(root)).includes("upload"), "копия файла не хранится");
});

test("общая база: новая версия по имени в коллекции, при выключенной индексации прежняя снимается сразу", async () => {
  const { queries, scheduled } = await ingest({ userId: null, enabled: false, previous: { id: EXISTING, revision: 3 } });
  // Всё — в системной области с доступом к строкам без владельца.
  const touching = queries.filter((item) => /knowledge_(documents|chunks|uploads)/u.test(item.sql));
  assert.ok(touching.every((item) => item.scope === "system:cross"));
  const previous = queries.find((item) => /SELECT id,revision FROM knowledge_documents/u.test(item.sql))!;
  assert.deepEqual(previous.params, ["col-1", null, "Договор.md"]);

  const document = queries.find((item) => item.sql.startsWith("INSERT INTO knowledge_documents"))!;
  assert.match(document.sql, /product_verified,collection_id/u);
  assert.match(document.sql, /'admin'/u);
  assert.deepEqual(document.params, [UPLOAD, 2, 4, EXISTING], "ревизия — следующая за прежней");
  const chunks = queries.filter((item) => item.sql.startsWith("INSERT INTO knowledge_chunks"));
  assert.ok(chunks.every((item) => item.params[1] === null && item.params[2] === true));

  const removal = queries.find((item) => item.sql.startsWith("DELETE FROM knowledge_documents"))!;
  assert.equal(removal.inTransaction, true);
  assert.deepEqual(removal.params, [[EXISTING]]);
  assert.deepEqual(scheduled, [{ input: { documentId: EXISTING, userId: null, reason: "delete" }, inTransaction: true }]);
  const done = queries.find((item) => /SET status='ready',outcome=/u.test(item.sql))!;
  assert.deepEqual(done.params, [UPLOAD, "new_version", UPLOAD]);
});

test("новая версия при включённой индексации: прежняя остаётся до индексации новой", async () => {
  const { queries, scheduled } = await ingest({ userId: 7, previous: { id: EXISTING, revision: 1 }, upload: { replaces_document_id: EXISTING } });
  assert.ok(!queries.some((item) => item.sql.startsWith("DELETE FROM knowledge_documents")));
  assert.deepEqual(scheduled.map((item) => item.input), [{ documentId: UPLOAD, userId: 7, reason: "ingest" }]);
  const previous = queries.find((item) => /SELECT id,revision FROM knowledge_documents/u.test(item.sql))!;
  assert.deepEqual([previous.scope, previous.params], ["user:7", [EXISTING, 7]]);
});

test("повтор уже принятой загрузки ничего не делает; отказ пишет код, а не текст", async () => {
  const replay = await ingest({ userId: 7, upload: { status: "ready" } });
  assert.ok(!replay.queries.some((item) => /^(INSERT|UPDATE|DELETE)/u.test(item.sql)));

  await assert.rejects(() => ingest({ userId: 7, upload: { storage_path: "/nonexistent/секрет договора.pdf" } }));
});

test("записи приёма нет — задание завершается без ошибки и ничего не пишет", async () => {
  // Раньше здесь был отказ `knowledge_upload_missing`: задание повторялось
  // до конца попыток и уходило в DLQ, хотя разбирать уже нечего.
  const cleared = await ingest({ userId: 7, upload: null });
  assert.ok(!cleared.queries.some((item) => /^(INSERT|UPDATE|DELETE)/u.test(item.sql)));
  assert.deepEqual(cleared.scheduled, []);
});

test("после отказа коллекция проверяется заново: потерянный том не ломает индексацию до рестарта", async () => {
  const { db } = fakeDb({ versions: [VERSION], document: PRIVATE_DOC, chunks: CHUNKS });
  let ensured = 0;
  let failUpsert = true;
  const store = {
    ensureSpace: async () => { ensured += 1; },
    upsert: async () => { if (failUpsert) throw Object.assign(new Error("not found"), { code: "qdrant_not_found" }); },
    pruneDocument: async () => undefined,
  };
  const indexer = new KnowledgeIndexer(db as never, router().router as never, store as never, options());
  await assert.rejects(() => indexer.index("doc-1", 7));
  failUpsert = false;
  await indexer.index("doc-1", 7);
  assert.equal(ensured, 2, "после отказа ensureSpace должен выполниться снова");
});
