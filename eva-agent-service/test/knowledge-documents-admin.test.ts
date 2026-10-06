/**
 * Общая база знаний в панели: коллекции, загрузка администратора,
 * удаление и переиндексация документов, построение и включение версии.
 *
 * Главное: панель трогает только документы без владельца (общую базу), а
 * личные базы видит числами; тяжёлая работа не выполняется в запросе —
 * файл ложится на том, а разбор, удаление точек и перестройка уходят
 * заданиями в job_outbox в той же транзакции, что и изменение строк.
 * Все запросы проходят настоящую границу арендатора в области
 * администратора с записью аудита.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import Fastify from "fastify";

import { KnowledgeDocumentsService, KNOWLEDGE_ADMIN_MAX_BYTES } from "../dist/admin/knowledge-documents-service.js";
import { registerKnowledgeDocumentRoutes } from "../dist/admin/knowledge-routes.js";
import { QdrantError } from "../dist/knowledge/qdrant-client.js";
import { adminScope, assertQueryAllowed, runInScope } from "../dist/tenancy/scope.js";

interface Query { sql: string; params: unknown[]; inTransaction: boolean }

const COLLECTION = "1c000000-0000-4000-8000-000000000001";
const DOC_A = "0a000000-0000-4000-8000-00000000000a";
const DOC_B = "0b000000-0000-4000-8000-00000000000b";

function fakePool(respond: (sql: string, params: unknown[]) => { rows: unknown[] } | Error | undefined) {
  const queries: Query[] = [];
  let inTransaction = false;
  const query = async (sql: string, params: unknown[] = []) => {
    // Та же граница, что у guardPool admin-api: запрос к таблицам людей —
    // только в области администратора с записью аудита.
    assertQueryAllowed(sql, params);
    const flat = sql.replace(/\s+/gu, " ").trim();
    if (flat === "BEGIN") inTransaction = true;
    queries.push({ sql: flat, params, inTransaction });
    if (flat === "COMMIT" || flat === "ROLLBACK") inTransaction = false;
    const result = respond(flat, params);
    if (result instanceof Error) throw result;
    return result ?? { rows: [], rowCount: 1 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
  return { pool, queries };
}

async function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return await runInScope(adminScope({ actor: "owner", role: "owner", auditId: "audit-1", route: "test" }), work);
}

function jobs(queries: Query[]): Array<{ type: string; userId: unknown; payload: Record<string, unknown>; idempotencyKey: string; inTransaction: boolean }> {
  return queries
    .filter((query) => query.sql.startsWith("INSERT INTO job_outbox"))
    .map((query) => {
      const envelope = JSON.parse(String(query.params[5])) as Record<string, unknown>;
      return {
        type: String(envelope.type),
        userId: envelope.userId,
        payload: envelope.payload as Record<string, unknown>,
        idempotencyKey: String(envelope.idempotencyKey),
        inTransaction: query.inTransaction,
      };
    });
}

const COLLECTION_ROW = {
  id: COLLECTION, code: "faq", title: "FAQ", description: null, enabled: true, position: 0,
  created_at: new Date("2026-09-30T10:00:00Z"), updated_at: new Date("2026-09-30T10:00:00Z"),
  documents: "2", indexed: "1", failed: "0", chunks: "12",
};

test("коллекции: код проверяется, повтор кода — 409, коллекцию с документами не удалить", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.startsWith("INSERT INTO knowledge_collections")) {
      return queries.filter((query) => query.sql.startsWith("INSERT INTO knowledge_collections")).length > 1
        ? Object.assign(new Error("duplicate"), { code: "23505" })
        : undefined;
    }
    if (sql.includes("FROM knowledge_collections c")) {
      // Список возвращает только что заведённую коллекцию: её id выдаёт сервис.
      const inserted = queries.filter((query) => query.sql.startsWith("INSERT INTO knowledge_collections")).at(-1);
      return { rows: [{ ...COLLECTION_ROW, id: inserted?.params[0] ?? COLLECTION }] };
    }
    if (sql.startsWith("SELECT id FROM knowledge_collections")) return { rows: [{ id: COLLECTION }] };
    if (sql.startsWith("SELECT (SELECT count(*) FROM knowledge_documents")) return { rows: [{ documents: "2", uploads: "0" }] };
    return undefined;
  });
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: null, uploadsEnabled: true });
  await asAdmin(async () => {
    await assert.rejects(() => service.createCollection({ code: "Не латиница", title: "FAQ" }), /Код коллекции/u);
    await assert.rejects(() => service.createCollection({ code: "faq", title: "" }), /Название/u);
    const created = await service.createCollection({ code: "faq", title: " FAQ ", description: "Частые вопросы" });
    assert.equal(created.code, "faq");
    assert.equal(created.documents, 2);
    const insert = queries.find((query) => query.sql.startsWith("INSERT INTO knowledge_collections"))!;
    assert.deepEqual(insert.params.slice(1), ["faq", "FAQ", "Частые вопросы", true, 0]);
    await assert.rejects(() => service.createCollection({ code: "faq", title: "FAQ" }), (error: { statusCode?: number }) => error.statusCode === 409);

    // Документы коллекции считаются только среди общей базы.
    const list = queries.find((query) => query.sql.includes("FROM knowledge_collections c"))!;
    assert.match(list.sql, /d\.collection_id = c\.id AND d\.user_id IS NULL/u);

    await assert.rejects(() => service.deleteCollection(COLLECTION), (error: { statusCode?: number; details?: unknown }) =>
      error.statusCode === 409);
    assert.ok(!queries.some((query) => query.sql.startsWith("DELETE FROM knowledge_collections")));
  });
});

test("удаление коллекции: под блокировкой строки; неразобранная загрузка тоже не даёт удалить", async () => {
  let counts = { documents: "0", uploads: "1" };
  let exists = true;
  const { pool, queries } = fakePool((sql) => {
    if (sql.startsWith("SELECT id FROM knowledge_collections")) return { rows: exists ? [{ id: COLLECTION }] : [] };
    if (sql.startsWith("SELECT (SELECT count(*) FROM knowledge_documents")) return { rows: [counts] };
    return undefined;
  });
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: null, uploadsEnabled: true });
  await asAdmin(async () => {
    // Загрузка ещё не создала документ: документов ноль, но удалять нельзя.
    await assert.rejects(() => service.deleteCollection(COLLECTION), (error: { statusCode?: number; details?: { uploads?: number } }) =>
      error.statusCode === 409 && error.details?.uploads === 1);
    const count = queries.find((query) => query.sql.startsWith("SELECT (SELECT count(*)"))!;
    assert.match(count.sql, /FROM knowledge_uploads .*status IN \('queued', 'processing'\)/u);
    assert.ok(!queries.some((query) => query.sql.startsWith("DELETE FROM knowledge_collections")));
    assert.equal(queries.at(-1)?.sql, "ROLLBACK");

    counts = { documents: "0", uploads: "0" };
    queries.length = 0;
    assert.deepEqual(await service.deleteCollection(COLLECTION), { deleted: COLLECTION });
    // Блокировка — первой, подсчёт и удаление — в той же транзакции после неё.
    assert.deepEqual(queries.map((query) => query.sql.split(" ").slice(0, 2).join(" ")),
      ["BEGIN", "SELECT id", "SELECT (SELECT", "DELETE FROM", "COMMIT"]);
    assert.match(queries[1]!.sql, /FOR UPDATE$/u);

    exists = false;
    await assert.rejects(() => service.deleteCollection(COLLECTION), (error: { statusCode?: number }) => error.statusCode === 404);
  });
});

test("загрузка в общую базу: файл на томе, запись приёма без владельца и задание разбора — одной транзакцией", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-admin-upload-"));
  const { pool, queries } = fakePool((sql) => sql.startsWith("SELECT 1 FROM knowledge_collections") ? { rows: [{ "?column?": 1 }] } : undefined);
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: root, store: null, uploadsEnabled: true });
  const result = await asAdmin(async () => await service.upload({
    collectionId: COLLECTION,
    name: "Регламент.md",
    mime: "text/markdown",
    stream: Readable.from([Buffer.from("# Регламент\nТекст.")]),
  }));
  assert.equal(result.status, "queued");
  assert.deepEqual(await readdir(join(root, "global")), [result.id]);
  assert.equal(await readFile(join(root, "global", result.id), "utf8"), "# Регламент\nТекст.");

  const insert = queries.find((query) => query.sql.startsWith("INSERT INTO knowledge_uploads"))!;
  assert.equal(insert.inTransaction, true);
  assert.match(insert.sql, /VALUES \(\$1, NULL, \$2/u, "у загрузки общей базы нет владельца");
  assert.deepEqual(insert.params.slice(0, 6), [result.id, COLLECTION, null, "Регламент.md", "text/markdown", Buffer.byteLength("# Регламент\nТекст.")]);
  assert.deepEqual(jobs(queries), [{
    type: "knowledge_ingest", userId: null, payload: { upload_id: result.id },
    idempotencyKey: `knowledge_ingest:system:${result.id}`, inTransaction: true,
  }]);
  assert.ok(queries.some((query) => query.sql === "COMMIT"));
});

test("загрузка: неверный формат, пустой и слишком большой файл, чужая коллекция — отказ без файла на томе", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-admin-upload-"));
  let collectionExists = true;
  let insertError: Error | undefined;
  const { pool, queries } = fakePool((sql) => {
    if (sql.startsWith("INSERT INTO knowledge_uploads")) return insertError;
    return sql.startsWith("SELECT 1 FROM knowledge_collections") ? { rows: collectionExists ? [{ "?column?": 1 }] : [] } : undefined;
  });
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: root, store: null, uploadsEnabled: true });
  const upload = (input: Partial<Parameters<KnowledgeDocumentsService["upload"]>[0]>) => asAdmin(async () => await service.upload({
    collectionId: COLLECTION, name: "файл.txt", mime: "text/plain", stream: Readable.from([Buffer.from("текст")]), ...input,
  }));
  await assert.rejects(() => upload({ mime: "application/x-msdownload" }), /формат/u);
  await assert.rejects(() => upload({ collectionId: "../../etc" }), /collection_id/u);
  await assert.rejects(() => upload({ stream: Readable.from([]) }), /пустой/u);
  await assert.rejects(() => upload({ stream: Readable.from([Buffer.alloc(KNOWLEDGE_ADMIN_MAX_BYTES + 1)]) }), /10 МБ/u);
  await assert.rejects(() => upload({ truncated: () => true }), /10 МБ/u);
  collectionExists = false;
  await assert.rejects(() => upload({}), (error: { statusCode?: number }) => error.statusCode === 404);
  collectionExists = true;
  // Коллекцию удалили, пока читался файл, или заменяемого документа нет:
  // внешний ключ записи приёма — 404, а не сбой сервера.
  insertError = Object.assign(new Error("fk"), { code: "23503", constraint: "knowledge_uploads_collection_id_fkey" });
  await assert.rejects(() => upload({}), (error: { statusCode?: number; message?: string }) =>
    error.statusCode === 404 && /Коллекция/u.test(String(error.message)));
  insertError = Object.assign(new Error("fk"), { code: "23503", constraint: "knowledge_uploads_replaces_document_id_fkey" });
  await assert.rejects(() => upload({ replaces: DOC_A }), (error: { statusCode?: number; message?: string }) =>
    error.statusCode === 404 && /Заменяемый/u.test(String(error.message)));
  assert.deepEqual(await readdir(join(root, "global")).catch(() => []), [], "недопринятые файлы удалены");
  // Запись приёма пытались вставить только в двух случаях с внешним ключом,
  // и обе транзакции откатились: ни записи, ни задания.
  assert.equal(queries.filter((query) => query.sql.startsWith("INSERT INTO knowledge_uploads")).length, 2);
  assert.ok(!queries.some((query) => query.sql === "COMMIT" || query.sql.startsWith("INSERT INTO job_outbox")));
});

test("загрузка при выключенном разборе у агента — сразу отказ, файл не пишется, поток дочитан", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-admin-upload-"));
  const { pool, queries } = fakePool(() => undefined);
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: root, store: null, uploadsEnabled: false });
  const stream = Readable.from([Buffer.from("текст")]);
  await assert.rejects(
    () => asAdmin(async () => await service.upload({ collectionId: COLLECTION, name: "файл.txt", mime: "text/plain", stream })),
    (error: { statusCode?: number; message?: string }) => error.statusCode === 409 && /EVA_KNOWLEDGE_UPLOADS/u.test(String(error.message)),
  );
  assert.equal(stream.readableFlowing, true, "поток дочитывается, соединение не ждёт");
  assert.deepEqual(queries, []);
  assert.deepEqual(await readdir(root), []);
});

test("загрузка общей базы: живой флаг включает и выключает приём, разбор записан в прежний outbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-admin-upload-live-"));
  const { pool, queries } = fakePool((sql) => sql.startsWith("SELECT 1 FROM knowledge_collections") ? { rows: [{ "?column?": 1 }] } : undefined);
  let enabled = false;
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: root, store: null, uploadsEnabled: async () => enabled });
  const upload = async () => await asAdmin(async () => await service.upload({ collectionId: COLLECTION,
    name: "психология.md", mime: "text/markdown", stream: Readable.from([Buffer.from("# Прокрастинация\nОдин маленький шаг.")]) }));
  assert.equal((await asAdmin(async () => await service.indexOverview())).uploads_enabled, false);
  await assert.rejects(upload, /Включить загрузку/u);
  enabled = true;
  assert.equal((await asAdmin(async () => await service.indexOverview())).uploads_enabled, true);
  const result = await upload();
  assert.equal(result.status, "queued");
  assert.deepEqual(jobs(queries).map((j) => [j.type, j.userId, j.inTransaction]), [["knowledge_ingest", null, true]]);
  assert.equal((await readdir(join(root, "global"))).length, 1);
  enabled = false;
  await assert.rejects(upload, /Включить загрузку/u);
  assert.equal((await readdir(join(root, "global"))).length, 1, "отказ записал ещё один файл");
  const stopped = new KnowledgeDocumentsService(pool as never, { uploadsRoot: root, store: null, uploadsEnabled: async () => true, uploadsWorkerEnabled: false });
  assert.equal((await asAdmin(async () => await stopped.indexOverview())).uploads_enabled, false);
  await assert.rejects(() => asAdmin(async () => await stopped.upload({ collectionId: COLLECTION,
    name: "x.md", mime: "text/markdown", stream: Readable.from([Buffer.from("x")]) })), /EVA_BULLMQ_JOBS/u);
  assert.equal(jobs(queries).length, 1, "при выключенном обработчике появилось задание без исполнителя");
});

test("удаление и переиндексация: только общая база, задания в той же транзакции", async () => {
  const { pool, queries } = fakePool((sql, params) => {
    if (sql.startsWith("DELETE FROM knowledge_documents")) return { rows: (params[0] as string[]).filter((id) => id === DOC_A).map((id) => ({ id })) };
    if (sql.startsWith("UPDATE knowledge_documents")) return { rows: [{ id: DOC_A }, { id: DOC_B }] };
    return undefined;
  });
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: null, uploadsEnabled: true, now: () => 42 });
  await asAdmin(async () => {
    await assert.rejects(() => service.deleteDocuments({ ids: [] }), /пуст/u);
    await assert.rejects(() => service.deleteDocuments({ ids: ["not-a-uuid"] }), /ids/u);
    const deleted = await service.deleteDocuments({ ids: [DOC_A, DOC_B.toUpperCase()] });
    // DOC_B не нашёлся в общей базе (например, это чужой личный
    // документ) — удалён только DOC_A, и задание — только на него.
    assert.deepEqual(deleted, { deleted: [DOC_A] });
    const removal = queries.find((query) => query.sql.startsWith("DELETE FROM knowledge_documents"))!;
    assert.match(removal.sql, /user_id IS NULL AND product_verified/u);
    assert.equal(removal.inTransaction, true);
    const uploads = queries.find((query) => query.sql.startsWith("DELETE FROM knowledge_uploads"))!;
    assert.match(uploads.sql, /user_id IS NULL/u);
    assert.deepEqual(jobs(queries).map((job) => [job.type, job.userId, job.payload, job.inTransaction]), [
      ["knowledge_index", null, { document_id: DOC_A, reason: "delete" }, true],
    ]);

    queries.length = 0;
    const reindexed = await service.reindex({ collection_id: COLLECTION });
    assert.deepEqual(reindexed, { scheduled: 2 });
    const update = queries.find((query) => query.sql.startsWith("UPDATE knowledge_documents"))!;
    assert.match(update.sql, /WHERE user_id IS NULL AND product_verified/u);
    assert.deepEqual(update.params, [COLLECTION, []]);
    assert.deepEqual(jobs(queries).map((job) => job.idempotencyKey), [
      `knowledge_index:system:${DOC_A}:reindex-42`,
      `knowledge_index:system:${DOC_B}:reindex-42`,
    ]);
  });
});

test("повтор загрузки: только неудавшаяся или отменённая, у задания свой ключ", async () => {
  let updated = true;
  const { pool, queries } = fakePool((sql) => sql.startsWith("UPDATE knowledge_uploads") ? { rows: updated ? [{ id: DOC_A }] : [] } : undefined);
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: null, uploadsEnabled: true, now: () => 7 });
  await asAdmin(async () => {
    assert.deepEqual(await service.retryUpload(DOC_A), { id: DOC_A, status: "queued" });
    const update = queries.find((query) => query.sql.startsWith("UPDATE knowledge_uploads"))!;
    assert.match(update.sql, /user_id IS NULL AND status IN \('failed', 'cancelled'\)/u);
    assert.deepEqual(jobs(queries).map((job) => job.idempotencyKey), [`knowledge_ingest:system:${DOC_A}:retry-7`]);
    updated = false;
    await assert.rejects(() => service.retryUpload(DOC_A), (error: { statusCode?: number }) => error.statusCode === 409);
  });
});

test("удаление загрузки: только неудавшаяся или отменённая — файл и запись одной транзакцией", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-admin-delete-"));
  await mkdir(join(root, "global"), { recursive: true });
  await writeFile(join(root, "global", DOC_A), "исходный файл");
  let found = true;
  const { pool, queries } = fakePool((sql) => sql.startsWith("SELECT id FROM knowledge_uploads") ? { rows: found ? [{ id: DOC_A }] : [] } : undefined);
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: root, store: null, uploadsEnabled: true });
  await asAdmin(async () => {
    assert.deepEqual(await service.deleteUpload(DOC_A), { deleted: DOC_A });
    const select = queries.find((query) => query.sql.startsWith("SELECT id FROM knowledge_uploads"))!;
    assert.match(select.sql, /user_id IS NULL AND status IN \('failed', 'cancelled'\) FOR UPDATE/u);
    const removed = queries.find((query) => query.sql.startsWith("DELETE FROM knowledge_uploads"))!;
    assert.ok(select.inTransaction && removed.inTransaction);
    assert.deepEqual(removed.params, [DOC_A]);
    assert.deepEqual(await readdir(join(root, "global")), [], "исходный файл удалён");
    found = false;
    queries.length = 0;
    await assert.rejects(() => service.deleteUpload(DOC_B), (error: { statusCode?: number }) => error.statusCode === 409);
    assert.ok(!queries.some((query) => query.sql.startsWith("DELETE")), "идущая или готовая загрузка не удаляется");
    assert.equal(queries.at(-1)?.sql, "ROLLBACK");
    await assert.rejects(() => service.deleteUpload("../etc/passwd"), (error: { statusCode?: number }) => error.statusCode === 400);
  });
});

test("построение версии: без Qdrant — отказ; черновик становится building, перестройка — заданием", async () => {
  const { pool, queries } = fakePool((sql) =>
    sql.startsWith("UPDATE knowledge_embedding_versions") ? { rows: [{ status: "building", started: "1727690000000" }] } : undefined);
  const without = new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: null, uploadsEnabled: true });
  await assert.rejects(() => asAdmin(async () => await without.build(2, {})), /QDRANT_API_KEY/u);

  const store = { activate: async () => undefined, countPoints: async () => 0 };
  const service = new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store, uploadsEnabled: true });
  const result = await asAdmin(async () => await service.build("2", { full: true }));
  assert.deepEqual(result, { version: 2, status: "building", started_at: "2024-09-30T09:53:20.000Z" });
  assert.deepEqual(jobs(queries).map((job) => [job.type, job.payload, job.inTransaction]), [
    ["knowledge_rebuild", { version: 2, started: 1727690000000, full: true, after: null }, true],
  ]);
});

function activationScenario(input: { active?: number; status?: string; unbuilt?: boolean; failure?: string } = {}) {
  const order: string[] = [];
  const row = (version: number, status: string) => ({ version, status, model: `model-${version}`, dimension: 8, distance: "Cosine",
    built_at: input.unbuilt ? null : new Date("2026-09-30T10:00:00Z"), build_started_at: null, error_code: null });
  let versions = [row(2, input.status ?? "ready"), ...(input.active ? [row(input.active, "active")] : [])];
  let snapshot: typeof versions | null = null;
  let commitFailed = false;
  let alias: number | null = input.active ?? null;
  let attempts = 0;
  const { pool, queries } = fakePool((sql, params) => {
    if (sql === "BEGIN") snapshot = versions.map((v) => ({ ...v }));
    if (sql === "ROLLBACK" && snapshot) versions = snapshot;
    if (sql === "COMMIT") {
      order.push("commit");
      if (["commit", "ambiguous"].includes(input.failure ?? "") && !commitFailed) {
        commitFailed = true;
        if (input.failure === "ambiguous") snapshot = null;
        return new Error("connection lost");
      }
      snapshot = null;
    }
    if (sql.startsWith("SELECT version FROM knowledge_embedding_versions")) return { rows: versions.filter((v) => v.status === "active") };
    if (sql.startsWith("SELECT version, model")) return { rows: versions.filter((v) => v.version === params[0] || v.status === "active") };
    if (sql.startsWith("SELECT count(*)")) return { rows: [{ total: "0" }] };
    if (sql.startsWith("UPDATE knowledge_embedding_versions SET status = 'retired'")) {
      order.push("retire");
      versions.filter((v) => v.status === "active" && v.version !== params[0]).forEach((v) => { v.status = "retired"; });
    }
    if (sql.startsWith("UPDATE knowledge_documents")) {
      order.push("documents");
      if (input.failure === "documents") return Object.assign(new Error("lock timeout"), { code: "55P03" });
    }
    if (sql.startsWith("UPDATE knowledge_embedding_versions SET status = 'active'")) {
      order.push("activate");
      if (input.failure === "db") return new Error("write failed");
      const v = versions.find((v) => v.version === params[0]);
      if (v) v.status = "active";
      return { rows: v ? [{ version: v.version }] : [] };
    }
    return undefined;
  });
  const store = {
    ready: async () => true, activeVersions: async () => ({ private: alias, global: alias }), countPoints: async () => 0,
    describe: async () => {
      order.push("validate");
      assert.equal(queries.at(-1)?.sql, "LOCK TABLE knowledge_documents, knowledge_chunks IN SHARE MODE");
      return { private: { size: 8, distance: "Cosine", status: "green" }, global: { size: 8, distance: "Cosine", status: "green" } };
    },
    scrollPoints: async () => ({ points: [], next: null }),
    activate: async (version: number | null) => {
      order.push(`alias:${version}`); attempts += 1; alias = version;
      if ((input.failure === "alias" && attempts === 1) || input.failure === "recovery") {
        throw new QdrantError("qdrant_unavailable", null, "request timed out after applying");
      }
    },
  };
  return { service: new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: store as never, uploadsEnabled: true }),
    versions: () => versions, alias: () => alias, order, queries };
}

test("первая активация: полная проверка под блокировкой, aliases перед строкой, всё в транзакции", async () => {
  const scenario = activationScenario();
  assert.deepEqual(await asAdmin(async () => await scenario.service.activate(2)), { version: 2, status: "active" });
  assert.deepEqual(scenario.order, ["validate", "documents", "alias:2", "retire", "activate", "commit"]);
  // Проверка доказала полноту версии: документы, которые записало
  // построение, а не их собственное задание, больше не «ждут индексации».
  const documents = scenario.queries.find((q) => q.sql.startsWith("UPDATE knowledge_documents"))!;
  assert.deepEqual(documents.params, [2]);
  assert.match(documents.sql, /SET index_status = 'ready', indexed_version = \$1/u);
  assert.match(documents.sql, /WHERE status = 'ready' AND index_status <> 'ready'/u);
  assert.ok(scenario.queries.find((q) => q.sql.includes("pg_advisory_xact_lock"))?.inTransaction);
  assert.ok(scenario.queries.filter((q) => q.sql.startsWith("UPDATE")).every((q) => q.inTransaction));
});

test("K7: смена активной версии и откат переводят предыдущую в retired, сохраняя её пространство", async () => {
  for (const status of ["ready", "retired"]) {
    const scenario = activationScenario({ active: 1, status });
    const original = scenario.versions().map((v) => [v.version, v.model, v.dimension]);
    assert.deepEqual(await asAdmin(async () => await scenario.service.activate(2, { expected_active_version: 1 })), { version: 2, status: "active" });
    assert.equal(scenario.alias(), 2);
    assert.deepEqual(scenario.versions().map((v) => [v.version, v.status]), [[2, "active"], [1, "retired"]]);
    assert.deepEqual(scenario.versions().map((v) => [v.version, v.model, v.dimension]), original);
    assert.ok(scenario.order.indexOf("retire") < scenario.order.indexOf("activate"));
  }
});

test("K7: draft, building, failed и ready без built_at не меняют aliases", async () => {
  for (const input of [{ status: "draft" }, { status: "building" }, { status: "failed" }, { unbuilt: true }]) {
    const scenario = activationScenario({ active: 1, ...input });
    await assert.rejects(() => asAdmin(async () => await scenario.service.activate(2)), /полностью построенную/u);
    assert.equal(scenario.alias(), 1);
    assert.deepEqual(scenario.order, []);
    assert.equal(scenario.queries.at(-1)?.sql, "ROLLBACK");
  }
});

test("K7: stale UI и verify_only не переключают другую активную модель", async () => {
  for (const body of [{ verify_only: true }, { expected_active_version: 3 }]) {
    const scenario = activationScenario({ active: 1 });
    await assert.rejects(() => asAdmin(async () => await scenario.service.activate(2, body)), /изменилась/u);
    assert.equal(scenario.alias(), 1);
    assert.deepEqual(scenario.order, []);
  }
});

test("активация: занятая строка документа — «повторите», aliases не тронуты", async () => {
  const scenario = activationScenario({ active: 1, failure: "documents" });
  await assert.rejects(() => asAdmin(async () => await scenario.service.activate(2)), /повторите активацию/u);
  assert.equal(scenario.alias(), 1);
  assert.deepEqual(scenario.order, ["validate", "documents"]);
  assert.equal(scenario.versions().find((v) => v.status === "active")?.version, 1);
  assert.equal(scenario.queries.at(-1)?.sql, "ROLLBACK");
});

test("K7: ошибки aliases, SQL и COMMIT восстанавливают aliases по канонической версии", async () => {
  for (const active of [undefined, 1]) for (const failure of ["alias", "db", "commit"]) {
    const scenario = activationScenario({ active, failure });
    await assert.rejects(() => asAdmin(async () => await scenario.service.activate(2)));
    assert.equal(scenario.alias(), active ?? null, `${failure}: первая активация очищает только наши aliases`);
    assert.equal(scenario.versions().find((v) => v.version === 2)?.status, "ready");
    assert.equal(scenario.versions().find((v) => v.status === "active")?.version, active);
    assert.ok(scenario.order.includes(`alias:${active ?? null}`));
  }
});

test("K7: неоднозначный COMMIT читается заново; отказ восстановления сообщается явно", async () => {
  const committed = activationScenario({ active: 1, failure: "ambiguous" });
  assert.deepEqual(await asAdmin(async () => await committed.service.activate(2)), { version: 2, status: "active" });
  assert.equal(committed.alias(), 2);
  const broken = activationScenario({ active: 1, failure: "recovery" });
  await assert.rejects(() => asAdmin(async () => await broken.service.activate(2)),
    (error: { statusCode?: number; details?: { code?: string } }) => error.statusCode === 409 && error.details?.code === "knowledge_alias_recovery_required");
});

test("состояние индекса: личные базы — только числа; Qdrant недоступен — прогресс неизвестен, а не ноль", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("GROUP BY 1, 2")) {
      return { rows: [
        { scope: "private", index_status: "ready", documents: "3", chunks: "30", lag_seconds: "0" },
        { scope: "private", index_status: "pending", documents: "1", chunks: "10", lag_seconds: "95.4" },
        { scope: "global", index_status: "ready", documents: "2", chunks: "20", lag_seconds: "0" },
      ] };
    }
    if (sql.startsWith("SELECT count(DISTINCT user_id)")) return { rows: [{ total: "2" }] };
    if (sql.startsWith("SELECT version, model")) {
      return { rows: [
        { version: 2, model: "bge-m3", dimension: 1024, status: "building", error_code: null,
          build_started_at: new Date("2026-09-30T10:00:00Z"), built_at: null, activated_at: null },
        { version: 1, model: "old", dimension: 1536, status: "active", error_code: null,
          build_started_at: null, built_at: new Date("2026-09-01T10:00:00Z"), activated_at: new Date("2026-09-01T11:00:00Z") },
      ] };
    }
    return undefined;
  });
  const store = {
    activate: async () => undefined,
    ready: async () => true,
    activeVersions: async () => ({ private: 1, global: 1 }),
    countPoints: async (scope: string, version: number) => {
      if (version === 1) throw new Error("qdrant_unavailable");
      return scope === "private" ? 20 : 10;
    },
  };
  const overview = await asAdmin(async () => await new KnowledgeDocumentsService(pool as never, { uploadsRoot: "/nonexistent", store: store as never, uploadsEnabled: true }).indexOverview());
  assert.equal(overview.qdrant_status, "ready");
  assert.equal(overview.aliases_match_active, true);
  assert.deepEqual(overview.scopes, {
    private: { documents: 4, chunks: 40, lag_seconds: 95, by_status: { ready: 3, pending: 1 } },
    global: { documents: 2, chunks: 20, lag_seconds: 0, by_status: { ready: 2 } },
  });
  assert.equal(overview.private_owners, 2);
  const versions = overview.versions as Array<Record<string, unknown>>;
  assert.deepEqual([versions[0]!.building, versions[0]!.points, versions[0]!.progress], [true, 30, 0.5]);
  assert.deepEqual([versions[1]!.building, versions[1]!.points, versions[1]!.progress], [false, null, null]);
  // Наружу — ни названий документов, ни владельцев.
  for (const query of queries.filter((item) => /knowledge_documents/u.test(item.sql))) {
    assert.doesNotMatch(query.sql, /SELECT[^;]*\b(name|user_id AS|content)\b[^;]*FROM knowledge_documents/u);
  }
  assert.doesNotMatch(JSON.stringify(overview), /user_id|name/u);
});

test("маршруты: роли и sudo объявлены, все читают через аудит; загрузка разбирает multipart только у себя", async () => {
  const declared = new Map<string, { roles?: string[]; sudoScope?: string; tenantAccess?: string }>();
  const seen: Array<Record<string, unknown>> = [];
  const service = {
    upload: async (input: { collectionId: unknown; replaces: unknown; name: string; mime: string; stream: Readable }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) chunks.push(chunk as Buffer);
      seen.push({ collectionId: input.collectionId, replaces: input.replaces, name: input.name, mime: input.mime, body: Buffer.concat(chunks).toString("utf8") });
      return { id: "u1", status: "queued" };
    },
  };
  const app = Fastify();
  app.addHook("onRoute", (route) => {
    declared.set(`${String(route.method)} ${route.url}`, (route.config ?? {}) as { roles?: string[]; sudoScope?: string; tenantAccess?: string });
  });
  app.post("/api/admin/v1/other", async (request) => ({ type: typeof request.body }));
  registerKnowledgeDocumentRoutes(app, service as never);
  await app.ready();

  for (const [key, access] of declared) {
    if (!key.includes("/knowledge/")) continue;
    assert.equal(access.tenantAccess, "cross-user", key);
    const reading = key.startsWith("GET ") || key.startsWith("HEAD ");
    assert.deepEqual(access.roles, reading ? ["owner", "admin", "operator", "viewer"] : ["owner", "admin"], key);
  }
  for (const key of [
    "POST /api/admin/v1/knowledge/collections",
    "PATCH /api/admin/v1/knowledge/collections/:id",
    "DELETE /api/admin/v1/knowledge/collections/:id",
    "POST /api/admin/v1/knowledge/embeddings/versions/:version/build",
    "POST /api/admin/v1/knowledge/embeddings/versions/:version/activate",
  ]) {
    assert.equal(declared.get(key)?.sudoScope, "settings:write", key);
  }
  assert.ok(declared.has("POST /api/admin/v1/knowledge/uploads"));

  const boundary = "----evaself";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="Регламент.md"',
    "Content-Type: text/markdown",
    "",
    "# Регламент",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/v1/knowledge/uploads?collection_id=${COLLECTION}`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(seen, [{ collectionId: COLLECTION, replaces: undefined, name: "Регламент.md", mime: "text/markdown", body: "# Регламент" }]);

  // Остальные маршруты панели multipart не принимают: разбор подключён
  // только в области маршрута загрузки.
  const other = await app.inject({
    method: "POST",
    url: "/api/admin/v1/other",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(other.statusCode, 415);
});
