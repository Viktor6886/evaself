/**
 * Сверка PostgreSQL ↔ Qdrant и перестройка версии индекса базы знаний.
 *
 * Главное: сверка только приводит Qdrant к PostgreSQL — снимает точки
 * чужой версии и удалённых документов, ставит в индексацию неполные
 * документы (кроме тех, что индексируются прямо сейчас), перестраивает
 * версию без коллекций; исходный файл без записи приёма удаляется, только
 * если он старше суток. Перестройка идёт порциями с курсором, пропускает
 * полные документы и не трогает версию, которую начали строить заново.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KNOWLEDGE_REBUILD_JOB, KnowledgeMaintenance, scheduleKnowledgeReconcile } from "../dist/knowledge/maintenance.js";
import { knowledgeIndexMetrics, resetKnowledgeMetrics } from "../dist/knowledge/metrics.js";
import { QdrantError } from "../dist/knowledge/qdrant-client.js";
import { assertQueryAllowed, currentScope, runInScope, systemScope, userScope } from "../dist/tenancy/scope.js";

interface Query { sql: string; params: unknown[]; scope: string; inTransaction: boolean }

const A = "0a000000-0000-4000-8000-00000000000a";
const B = "0b000000-0000-4000-8000-00000000000b";
const C = "0c000000-0000-4000-8000-00000000000c";
const D = "0d000000-0000-4000-8000-00000000000d";
const G = "0e000000-0000-4000-8000-00000000000e";
const ORPHAN = "0f000000-0000-4000-8000-00000000000f";

function scopeName(): string {
  const scope = currentScope();
  if (!scope) return "none";
  if (scope.kind === "user") return `user:${scope.userId}`;
  if (scope.kind === "system") return scope.crossUser ? "system:cross" : "system";
  return "admin";
}

/** База-фейк с настоящей границей арендатора (см. knowledge-indexer.test.ts). */
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

function outboxLog() {
  const recorded: Array<Record<string, unknown>> = [];
  return { recorded, outbox: { record: async (_client: unknown, intent: Record<string, unknown>) => { recorded.push(intent); return { idempotencyKey: "", duplicate: false }; } } };
}

function indexLog() {
  const scheduled: Array<Record<string, unknown>> = [];
  return { scheduled, index: { enabled: () => true, schedule: async (_client: unknown, input: Record<string, unknown>) => { scheduled.push(input); } } };
}

interface StoreState {
  collections?: boolean;
  foreign?: Partial<Record<"private" | "global", number>>;
  points?: Partial<Record<"private" | "global", Record<string, number>>>;
}

function fakeStore(state: StoreState) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const info = { size: 3, distance: "Cosine", points: 0, indexedFields: [] };
  return {
    calls,
    store: {
      describe: async (version: number) => {
        calls.push({ method: "describe", args: [version] });
        return state.collections === false ? { private: null, global: info } : { private: info, global: info };
      },
      removeForeignVersion: async (scope: "private" | "global", version: number) => {
        calls.push({ method: "removeForeignVersion", args: [scope, version] });
        return state.foreign?.[scope] ?? 0;
      },
      documentPointCounts: async (scope: "private" | "global", version: number, limit: number) => {
        calls.push({ method: "documentPointCounts", args: [scope, version, limit] });
        return new Map(Object.entries(state.points?.[scope] ?? {}));
      },
      deleteDocuments: async (...args: unknown[]) => { calls.push({ method: "deleteDocuments", args }); },
      ensureSpace: async (...args: unknown[]) => { calls.push({ method: "ensureSpace", args }); },
      countPoints: async () => 0,
      documentPoints: async (scope: "private" | "global", version: number, documentId: string) => {
        calls.push({ method: "documentPoints", args: [scope, version, documentId] });
        return state.points?.[scope]?.[documentId] ?? 0;
      },
    },
  };
}

const VERSIONS = [{ version: 2, status: "active" }];

test("сверка: чужая версия, сироты и неполные документы; индексируемый сейчас не трогается", async () => {
  resetKnowledgeMetrics();
  const order: string[] = [];
  const { db, queries } = guardedDb((sql) => {
    if (/FROM knowledge_embedding_versions/u.test(sql)) return { rows: VERSIONS };
    if (/count\(\*\) AS total/u.test(sql)) return { rows: [{ total: "4" }] };
    if (/WHERE user_id IS NOT NULL AND status = 'ready'/u.test(sql)) {
      order.push("documents:private");
      return { rows: [
        { id: A, user_id: "7", chunk_count: 2, busy: false },
        { id: B, user_id: "7", chunk_count: 3, busy: false },
        { id: C, user_id: "8", chunk_count: 4, busy: false },
        { id: D, user_id: "8", chunk_count: 5, busy: true },
      ] };
    }
    if (/WHERE user_id IS NULL AND product_verified AND status = 'ready'/u.test(sql)) {
      order.push("documents:global");
      return { rows: [{ id: G, user_id: null, chunk_count: 1, busy: false }] };
    }
    return undefined;
  });
  const { calls, store } = fakeStore({
    foreign: { private: 3 },
    points: { private: { [A]: 2, [B]: 1, [ORPHAN]: 6 }, global: { [G]: 1 } },
  });
  const facet = store.documentPointCounts;
  store.documentPointCounts = async (scope, version, limit) => {
    order.push(`points:${scope}`);
    return await facet(scope, version, limit);
  };
  const jobs = indexLog();
  const maintenance = new KnowledgeMaintenance(db as never, store as never, {} as never, {
    enabled: () => true, configured: () => true, uploadsRoot: "/nonexistent", outbox: outboxLog().outbox, index: jobs.index, now: () => 1_000,
  });

  const report = await maintenance.reconcile();
  assert.deepEqual(report, { foreign: 3, scheduled: 2, orphans: 1, rebuilds: 0, files: 0 });
  // Сирота — документ, точки которого есть, а в PostgreSQL его нет.
  assert.deepEqual(calls.filter((call) => call.method === "deleteDocuments").map((call) => call.args), [["private", 2, [ORPHAN]]]);
  // B неполон, у C нет ни одной точки; D индексируется прямо сейчас.
  assert.deepEqual(jobs.scheduled, [
    { documentId: B, userId: 7, reason: "reconcile-1000" },
    { documentId: C, userId: 8, reason: "reconcile-1000" },
  ]);
  const pending = queries.filter((query) => /SET index_status = 'pending'/u.test(query.sql));
  assert.deepEqual(pending.map((query) => query.params[0]), [B, C]);
  assert.ok(pending.every((query) => query.inTransaction && query.scope === "system:cross"));
  // Сначала точки Qdrant, потом документы PostgreSQL: документ, чьи точки
  // уже видны, обязательно есть и в PostgreSQL, если его не удалили. В
  // обратном порядке документ, заведённый между двумя чтениями, сошёл бы
  // за сироту, и его точки были бы сняты.
  assert.deepEqual(order, ["points:private", "documents:private", "points:global", "documents:global"]);
  const metrics = knowledgeIndexMetrics();
  assert.deepEqual(metrics.points, [{ scope: "private", version: 2, value: 9 }, { scope: "global", version: 2, value: 1 }]);
  assert.equal(metrics.reconcile.runs, 1);
  assert.equal(metrics.reconcile.orphans, 1);
});

test("сверка при выключенной индексации трогает только файлы; без коллекций версии — перестройка", async () => {
  const { db } = guardedDb((sql) => /FROM knowledge_embedding_versions/u.test(sql) ? { rows: VERSIONS } : undefined);
  const disabled = fakeStore({});
  const report = await new KnowledgeMaintenance(db as never, disabled.store as never, {} as never, {
    enabled: () => false, configured: () => true, uploadsRoot: "/nonexistent", outbox: outboxLog().outbox, index: indexLog().index,
  }).reconcile();
  assert.equal(report.skipped, "index_disabled");
  assert.equal(disabled.calls.length, 0);

  const lost = guardedDb((sql) => {
    if (/FROM knowledge_embedding_versions/u.test(sql)) return { rows: VERSIONS };
    if (/UPDATE knowledge_embedding_versions/u.test(sql)) return { rows: [{ started: "1727665500000" }] };
    return undefined;
  });
  const log = outboxLog();
  const missing = fakeStore({ collections: false });
  const result = await new KnowledgeMaintenance(lost.db as never, missing.store as never, {} as never, {
    enabled: () => true, configured: () => true, uploadsRoot: "/nonexistent", outbox: log.outbox, index: indexLog().index,
  }).reconcile();
  assert.equal(result.rebuilds, 1);
  assert.ok(!missing.calls.some((call) => call.method === "documentPointCounts"), "документ за документом не сверяется");
  assert.equal(log.recorded[0]!.type, KNOWLEDGE_REBUILD_JOB);
  assert.deepEqual(log.recorded[0]!.payload, { version: 2, started: 1727665500000, full: false, after: null });
  assert.equal(log.recorded[0]!.idempotencyKey, "knowledge_rebuild:system:v2:1727665500000:start");
});

test("сверка не трогает версию, которую строят: ни перезапуска, ни документов в очередь", async () => {
  const { db, queries } = guardedDb((sql) => {
    if (/FROM knowledge_embedding_versions/u.test(sql)) return { rows: [{ version: 3, status: "ready", building: true }] };
    return undefined;
  });
  const lost = fakeStore({ collections: false });
  const jobs = indexLog();
  const report = await new KnowledgeMaintenance(db as never, lost.store as never, {} as never, {
    enabled: () => true, configured: () => true, uploadsRoot: "/nonexistent", outbox: outboxLog().outbox, index: jobs.index,
  }).reconcile();
  assert.deepEqual([report.rebuilds, report.scheduled, report.orphans], [0, 0, 0]);
  assert.ok(!lost.calls.some((call) => call.method === "documentPointCounts"));
  assert.ok(!queries.some((query) => query.sql.startsWith("UPDATE knowledge_embedding_versions")));
  // Признак построения считается в самом запросе версий.
  const versions = queries.find((query) => /FROM knowledge_embedding_versions/u.test(query.sql))!;
  assert.match(versions.sql, /build_started_at > built_at/u);
});

test("сверка файлов: удаляется только старый файл без записи приёма", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-sweep-"));
  await mkdir(join(root, "7"));
  await mkdir(join(root, "global"));
  const old = new Date("2026-09-20T00:00:00Z");
  for (const [dir, name] of [["7", A], ["7", B], ["global", G], ["7", "не-uuid"]] as const) {
    await writeFile(join(root, dir, name), "файл");
    await utimes(join(root, dir, name), old, old);
  }
  await writeFile(join(root, "7", C), "свежий");
  const { db, queries } = guardedDb((sql) => /FROM knowledge_uploads/u.test(sql) ? { rows: [{ id: B }] } : undefined);
  const report = await new KnowledgeMaintenance(db as never, fakeStore({}).store as never, {} as never, {
    enabled: () => false, configured: () => false, uploadsRoot: root, outbox: outboxLog().outbox, index: indexLog().index,
    now: () => Date.parse("2026-09-30T03:00:00Z"),
  }).reconcile();
  assert.equal(report.files, 2);
  assert.deepEqual((await readdir(join(root, "7"))).sort(), [B, C, "не-uuid"].sort());
  assert.deepEqual(await readdir(join(root, "global")), []);
  assert.ok(queries.every((query) => query.scope === "system:cross"));
});

function rebuildDb(state: { status?: string; started?: number; documents: Array<{ id: string; user_id: string | null; chunk_count: number }> }) {
  return guardedDb((sql, params) => {
    if (/SELECT status, \(extract/u.test(sql)) return { rows: [{ status: state.status ?? "building", started: String(state.started ?? 5_000) }] };
    if (/SELECT model, dimension/u.test(sql)) {
      return { rows: [{ model: "bge-m3", dimension: 1024, distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false }] };
    }
    if (/FROM knowledge_documents/u.test(sql) && /ORDER BY id/u.test(sql)) {
      const after = params[0] as string | null;
      return { rows: state.documents.filter((row) => after === null || row.id > after) };
    }
    return undefined;
  });
}

function rebuildContext(payload: Record<string, unknown>, attempt = 1) {
  return {
    envelope: { payload, userId: null, payloadRef: String(payload.version) },
    attempt,
    signal: new AbortController().signal,
    timing: { maxAttempts: 3 },
  } as never;
}

test("перестройка: полные документы пропускаются, остальные индексируются в эту версию, в конце — ready", async () => {
  const documents = [
    { id: A, user_id: "7", chunk_count: 2 },
    { id: B, user_id: "7", chunk_count: 3 },
    { id: G, user_id: null, chunk_count: 1 },
  ];
  const { db, queries } = rebuildDb({ documents });
  const indexed: unknown[] = [];
  const indexer = { index: async (...args: unknown[]) => { indexed.push(args.filter((_, index) => index !== 2)); return { status: "ready" }; } };
  const { calls, store } = fakeStore({ points: { private: { [A]: 2, [B]: 1 } } });
  const result = await new KnowledgeMaintenance(db as never, store as never, indexer as never, {
    enabled: () => true, configured: () => true, uploadsRoot: "/nonexistent", outbox: outboxLog().outbox, index: indexLog().index,
  }).rebuild(rebuildContext({ version: 2, started: 5_000, full: false, after: null }));

  assert.deepEqual(result, { status: "done", processed: 2 });
  assert.deepEqual(indexed, [[B, 7, { versions: [2] }], [G, null, { versions: [2] }]]);
  // Коллекции создаются в начале перестройки: у пустой базы иначе их не
  // было бы вовсе, и включить готовую версию было бы нечем.
  const ensured = calls.filter((call) => call.method === "ensureSpace");
  assert.deepEqual(ensured.map((call) => call.args), [[
    { version: 2, model: "bge-m3", dimension: 1024, distance: "Cosine" },
    { m: 16, efConstruct: 100, onDisk: false },
  ]]);
  const done = queries.find((query) => /SET built_at = now\(\)/u.test(query.sql))!;
  assert.deepEqual(done.params, [2, 5_000], "только та перестройка, что началась в этот момент");
  const page = queries.find((query) => /ORDER BY id/u.test(query.sql))!;
  assert.equal(page.scope, "system:cross");
});

test("перестройка: полная переиндексирует всё; кончилось время — продолжение с курсора отдельным заданием", async () => {
  const documents = [
    { id: A, user_id: "7", chunk_count: 2 },
    { id: B, user_id: "7", chunk_count: 3 },
    { id: C, user_id: "8", chunk_count: 1 },
  ];
  const { db, queries } = rebuildDb({ documents });
  let clock = 0;
  const indexed: string[] = [];
  const indexer = { index: async (id: string) => { indexed.push(id); clock += 2 * 60_000; return { status: "ready" }; } };
  const { store } = fakeStore({ points: { private: { [A]: 2, [B]: 3, [C]: 1 } } });
  const log = outboxLog();
  const result = await new KnowledgeMaintenance(db as never, store as never, indexer as never, {
    enabled: () => true, configured: () => true, uploadsRoot: "/nonexistent", outbox: log.outbox, index: indexLog().index, now: () => clock,
  }).rebuild(rebuildContext({ version: 2, started: 5_000, full: true, after: null }));

  // Порция — три минуты: два документа по две минуты, и очередь уступлена.
  assert.deepEqual(result, { status: "continued", processed: 2 });
  assert.deepEqual(indexed, [A, B], "полная перестройка не пропускает полные документы");
  assert.deepEqual(log.recorded.map((intent) => intent.payload), [{ version: 2, started: 5_000, full: true, after: B }]);
  assert.equal(log.recorded[0]!.idempotencyKey, `knowledge_rebuild:system:v2:5000:${B}`);
  assert.ok(!queries.some((query) => /SET built_at/u.test(query.sql)), "версия ещё не готова");

  // Продолжение начинает после курсора и коллекции заново не проверяет.
  const next = rebuildDb({ documents });
  const rest: string[] = [];
  const continued = fakeStore({ points: { private: { [A]: 2, [B]: 3, [C]: 1 } } });
  await new KnowledgeMaintenance(next.db as never, continued.store as never, { index: async (id: string) => { rest.push(id); return { status: "ready" }; } } as never, {
    enabled: () => true, configured: () => true, uploadsRoot: "/nonexistent", outbox: outboxLog().outbox, index: indexLog().index,
  }).rebuild(rebuildContext({ version: 2, started: 5_000, full: true, after: B }));
  assert.deepEqual(rest, [C]);
  assert.ok(!continued.calls.some((call) => call.method === "ensureSpace"));
});

test("перестройка: устаревшее задание ничего не делает; выключенная индексация — код на версии; отказ последней попытки — failed", async () => {
  const stale = rebuildDb({ started: 9_999, documents: [{ id: A, user_id: "7", chunk_count: 1 }] });
  const untouched: unknown[] = [];
  const options = { configured: () => true, uploadsRoot: "/nonexistent", outbox: outboxLog().outbox, index: indexLog().index };
  const result = await new KnowledgeMaintenance(stale.db as never, fakeStore({}).store as never, { index: async (...args: unknown[]) => { untouched.push(args); } } as never, {
    ...options, enabled: () => true,
  }).rebuild(rebuildContext({ version: 2, started: 5_000, full: true, after: null }));
  assert.deepEqual(result, { status: "stale", processed: 0 });
  assert.deepEqual(untouched, []);

  const disabled = rebuildDb({ documents: [] });
  await new KnowledgeMaintenance(disabled.db as never, fakeStore({}).store as never, {} as never, { ...options, enabled: () => false })
    .rebuild(rebuildContext({ version: 2, started: 5_000, full: false, after: null }));
  assert.ok(disabled.queries.some((query) => /error_code = 'knowledge_index_disabled'/u.test(query.sql)));

  for (const attempt of [1, 3]) {
    const failing = rebuildDb({ documents: [{ id: A, user_id: "7", chunk_count: 1 }] });
    const indexer = { index: async () => { throw new QdrantError("qdrant_unavailable", null, "Qdrant недоступен: текст документа"); } };
    await assert.rejects(() => new KnowledgeMaintenance(failing.db as never, fakeStore({}).store as never, indexer as never, { ...options, enabled: () => true })
      .rebuild(rebuildContext({ version: 2, started: 5_000, full: false, after: null }, attempt)));
    const marked = failing.queries.find((query) => /SET error_code = \$3/u.test(query.sql))!;
    assert.deepEqual(marked.params, [2, 5_000, "qdrant_unavailable", attempt === 3], "текста отказа в базе нет — только код");
  }
});

test("сверка по кнопке: задание без содержимого, ключ повтора — момент запроса", async () => {
  const log = outboxLog();
  await scheduleKnowledgeReconcile(log.outbox as never, {} as never, 1727665500000);
  assert.equal(log.recorded[0]!.type, "knowledge_reconcile");
  assert.equal(log.recorded[0]!.queue, "memory");
  assert.equal(log.recorded[0]!.userId, null);
  assert.deepEqual(log.recorded[0]!.payload, {});
  assert.equal(log.recorded[0]!.idempotencyKey, "knowledge_reconcile:system:manual:1727665500000");
});
