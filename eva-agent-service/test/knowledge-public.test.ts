/**
 * Своя база знаний в Mini App (docs/knowledge-base.md, K5a).
 *
 * Маршруты: вкладка узнаёт о выключенной функции из `GET /knowledge`, а не
 * из ошибки; человек определяется подписью, а не телом запроса; очистка —
 * только с явным подтверждением. Сервис: каждый запрос — в области
 * человека (настоящая `assertQueryAllowed`), удаление ставит задание
 * синхронизации в той же транзакции, состояние документа не выдаёт
 * внутренних кодов индекса.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import Fastify from "fastify";

import { KnowledgeUploadService, knowledgeDocumentState } from "../dist/knowledge/lifecycle.js";
import type { KnowledgeDocumentsPublic } from "../dist/public/knowledge-routes.js";
import { registerPublicRoutes, type KnowledgeResearchPublic } from "../dist/public/routes.js";
import { assertQueryAllowed, currentScope, runInScope, systemScope, userScope } from "../dist/tenancy/scope.js";

const BOT_TOKEN = "123456789:AAAA_test_token";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const USER = { id: 42001, first_name: "Test", username: "test_user", language_code: "ru" };
const DOC = "0a000000-0000-4000-8000-00000000000a";

function initData(user: Record<string, unknown>): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(NOW.getTime() / 1000)), query_id: "AAEAAAE",
    signature: "telegram-ed25519-signature", user: JSON.stringify(user),
  });
  const check = [...params.entries()].sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function app(services: { knowledgeDocuments?: KnowledgeDocumentsPublic; knowledgeResearch?: KnowledgeResearchPublic } = {}) {
  const fastify = Fastify({ logger: false });
  registerPublicRoutes(fastify, {
    config: { telegramBotToken: BOT_TOKEN, telegramWebAppMaxAgeSeconds: 3_600, rateLimitWindowSeconds: 60, publicRateLimitPerIp: 100, publicRateLimitPerUser: 60 } as never,
    repository: { openSession: async () => ({}) } as never,
    now: () => NOW,
    ...services,
  });
  return fastify;
}

const signed = { "x-telegram-init-data": initData(USER) };

function documents(calls: string[]): KnowledgeDocumentsPublic {
  return {
    overview: async (telegramId) => {
      calls.push(`overview:${telegramId}`);
      return { documents: [{ id: DOC, name: "план.md", state: "ready" }], total: 1, uploads: [] };
    },
    remove: async (telegramId, id) => {
      calls.push(`remove:${telegramId}:${id}`);
      return { deleted: id === DOC };
    },
    clear: async (telegramId) => {
      calls.push(`clear:${telegramId}`);
      return { deleted: 3 };
    },
  };
}

test("выключенная функция: GET /knowledge — enabled:false, изменения отклоняются", async () => {
  const fastify = app();
  try {
    const overview = await fastify.inject({ method: "GET", url: "/public/knowledge", headers: signed });
    assert.equal(overview.statusCode, 200);
    assert.deepEqual(overview.json(), { enabled: false, documents: [], total: 0, uploads: [] });
    const removal = await fastify.inject({ method: "DELETE", url: `/public/knowledge/documents/${DOC}`, headers: signed });
    assert.equal(removal.statusCode, 400);
  } finally {
    await fastify.close();
  }
});

test("без подписи — 401, до сервиса запрос не доходит", async () => {
  const calls: string[] = [];
  const fastify = app({ knowledgeDocuments: documents(calls) });
  try {
    assert.equal((await fastify.inject({ method: "GET", url: "/public/knowledge" })).statusCode, 401);
    assert.equal((await fastify.inject({ method: "DELETE", url: `/public/knowledge/documents/${DOC}` })).statusCode, 401);
    assert.deepEqual(calls, []);
  } finally {
    await fastify.close();
  }
});

test("включённая функция: обзор, удаление своего документа, очистка только с подтверждением", async () => {
  const calls: string[] = [];
  const fastify = app({ knowledgeDocuments: documents(calls) });
  try {
    const overview = await fastify.inject({ method: "GET", url: "/public/knowledge", headers: signed });
    assert.equal(overview.statusCode, 200);
    const body = overview.json() as { enabled: boolean; max_bytes: number; total: number };
    assert.equal(body.enabled, true);
    assert.equal(body.max_bytes, 10 * 1024 * 1024);
    assert.equal(body.total, 1);

    assert.equal((await fastify.inject({ method: "DELETE", url: "/public/knowledge/documents/../../etc", headers: signed })).statusCode, 404);
    assert.equal((await fastify.inject({ method: "DELETE", url: "/public/knowledge/documents/not-a-uuid", headers: signed })).statusCode, 400);
    const missing = await fastify.inject({ method: "DELETE", url: "/public/knowledge/documents/0b000000-0000-4000-8000-00000000000b", headers: signed });
    assert.equal(missing.statusCode, 404);
    const removed = await fastify.inject({ method: "DELETE", url: `/public/knowledge/documents/${DOC}`, headers: signed });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), { deleted: true });

    const unconfirmed = await fastify.inject({ method: "DELETE", url: "/public/knowledge/documents", headers: signed, payload: { confirm: "yes" } });
    assert.equal(unconfirmed.statusCode, 400);
    const cleared = await fastify.inject({ method: "DELETE", url: "/public/knowledge/documents", headers: signed, payload: { confirm: true } });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { deleted: 3 });

    // Человек — из подписи: чужой id нигде не подставить.
    assert.deepEqual(calls, [
      `overview:${USER.id}`,
      `remove:${USER.id}:0b000000-0000-4000-8000-00000000000b`,
      `remove:${USER.id}:${DOC}`,
      `clear:${USER.id}`,
    ]);
  } finally {
    await fastify.close();
  }
});

test("загрузка новой версии: id заменяемого документа из строки запроса доходит до сервиса", async () => {
  const received: Array<{ replaces?: string }> = [];
  const research: KnowledgeResearchPublic = {
    upload: async (_telegramId, input) => {
      for await (const _chunk of input.stream) { /* дочитать поток */ }
      received.push({ ...(input.replaces ? { replaces: input.replaces } : {}) });
      return { id: "u1", status: "queued" };
    },
    uploadStatus: async () => null, researchCreate: async () => ({}), researchStatus: async () => null,
    researchReport: async () => null, researchCancel: async () => ({}),
  };
  const fastify = app({ knowledgeResearch: research });
  try {
    const boundary = "----K5aBoundary";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="план.md"\r\nContent-Type: text/markdown\r\n\r\n# План\r\n--${boundary}--\r\n`;
    const headers = { ...signed, "content-type": `multipart/form-data; boundary=${boundary}` };
    assert.equal((await fastify.inject({ method: "POST", url: `/public/knowledge/uploads?replaces=${DOC}`, headers, payload: body })).statusCode, 200);
    assert.equal((await fastify.inject({ method: "POST", url: "/public/knowledge/uploads", headers, payload: body })).statusCode, 200);
    assert.deepEqual(received, [{ replaces: DOC }, {}]);
  } finally {
    await fastify.close();
  }
});

// ------------------------------------------------------------------
// Сервис
// ------------------------------------------------------------------

interface Query { sql: string; params: unknown[]; inTransaction: boolean }

function guardedDb(respond: (sql: string, params: unknown[]) => { rows: unknown[] } | undefined) {
  const queries: Query[] = [];
  let inTransaction = false;
  const query = async (sql: string, params: unknown[] = []) => {
    assertQueryAllowed(sql, params);
    const flat = sql.replace(/\s+/gu, " ").trim();
    queries.push({ sql: flat, params, inTransaction });
    return respond(flat, params) ?? { rows: [], rowCount: 1 };
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

function outbox() {
  const jobs: Array<{ type: string; userId: unknown; payload: Record<string, unknown>; inTransaction: boolean }> = [];
  return { jobs, record: (queries: Query[]) => async (_client: unknown, envelope: { type: string; userId: unknown; payload: Record<string, unknown> }) => {
    jobs.push({ type: envelope.type, userId: envelope.userId, payload: envelope.payload, inTransaction: queries.at(-1)?.inTransaction ?? false });
  } };
}

const INTERNAL = 7;
const resolveUser = (sql: string) => sql.startsWith("SELECT id FROM users") ? { rows: [{ id: String(INTERNAL) }] } : undefined;

test("состояние документа: без индекса разобранный документ готов, с индексом — по статусу индекса", () => {
  assert.equal(knowledgeDocumentState("pending", false), "ready");
  assert.equal(knowledgeDocumentState("failed", false), "ready");
  assert.equal(knowledgeDocumentState("ready", true), "ready");
  assert.equal(knowledgeDocumentState("pending", true), "indexing");
  assert.equal(knowledgeDocumentState("indexing", true), "indexing");
  assert.equal(knowledgeDocumentState("failed", true), "failed");
});

test("обзор: только свои документы, состояние вместо кодов индекса", async () => {
  let indexing = true;
  const { db, queries } = guardedDb((sql) => {
    const user = resolveUser(sql);
    if (user) return user;
    if (sql.startsWith("SELECT id,name,mime,size_bytes")) return { rows: [
      { id: DOC, name: "план.md", mime: "text/markdown", size_bytes: "2048", chunk_count: 2, index_status: "pending", revision: 1, source: "upload", created_at: NOW, updated_at: NOW },
    ] };
    if (sql.startsWith("SELECT count(*) AS total")) return { rows: [{ total: "1" }] };
    return undefined;
  });
  const box = outbox();
  const service = new KnowledgeUploadService(db as never, { record: box.record(queries) } as never, "/nonexistent", undefined, () => indexing);
  const view = await service.overview(USER.id) as { documents: Array<Record<string, unknown>>; total: number };
  assert.equal(view.total, 1);
  assert.equal(view.documents[0]!.state, "indexing");
  assert.equal(view.documents[0]!.size_bytes, 2048);
  assert.ok(!("index_status" in view.documents[0]!), "внутренний статус индекса ушёл наружу");
  for (const query of queries.filter((item) => /knowledge_(documents|uploads)/u.test(item.sql))) {
    assert.match(query.sql, /WHERE user_id=\$1/u);
    assert.equal(query.params[0], INTERNAL);
  }
  indexing = false;
  const plain = await service.overview(USER.id) as { documents: Array<Record<string, unknown>> };
  assert.equal(plain.documents[0]!.state, "ready");
});

test("удаление: свой документ, задание синхронизации в той же транзакции; чужой id — false", async () => {
  const { db, queries } = guardedDb((sql, params) => {
    const user = resolveUser(sql);
    if (user) return user;
    if (sql.startsWith("DELETE FROM knowledge_documents")) return { rows: (params[0] as string[]).filter((id) => id === DOC).map((id) => ({ id })) };
    return undefined;
  });
  const box = outbox();
  const service = new KnowledgeUploadService(db as never, { record: box.record(queries) } as never, "/nonexistent");
  assert.deepEqual(await service.remove(USER.id, DOC), { deleted: true });
  const deletion = queries.find((query) => query.sql.startsWith("DELETE FROM knowledge_documents"))!;
  assert.match(deletion.sql, /AND user_id = \$2/u);
  assert.equal(deletion.params[1], INTERNAL);
  assert.equal(deletion.inTransaction, true);
  assert.deepEqual(box.jobs, [{ type: "knowledge_index", userId: INTERNAL, payload: { document_id: DOC, reason: "delete" }, inTransaction: true }]);

  assert.deepEqual(await service.remove(USER.id, "0b000000-0000-4000-8000-00000000000b"), { deleted: false });
  assert.deepEqual(await service.remove(USER.id, "../../etc"), { deleted: false });
  assert.equal(box.jobs.length, 1);
});

test("очистка: порциями до конца, неудавшиеся загрузки — вместе с файлами", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-knowledge-clear-"));
  const failed = "0c000000-0000-4000-8000-00000000000c";
  await mkdir(join(root, String(INTERNAL)), { recursive: true });
  await writeFile(join(root, String(INTERNAL), failed), "битый файл");
  const remaining = Array.from({ length: 501 }, (_value, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`);
  const { db, queries } = guardedDb((sql, params) => {
    const user = resolveUser(sql);
    if (user) return user;
    if (sql.startsWith("SELECT id FROM knowledge_documents")) return { rows: remaining.slice(0, 500).map((id) => ({ id })) };
    if (sql.startsWith("DELETE FROM knowledge_documents")) {
      const ids = params[0] as string[];
      remaining.splice(0, ids.length);
      return { rows: ids.map((id) => ({ id })) };
    }
    if (sql.startsWith("SELECT id FROM knowledge_uploads WHERE user_id=$1 AND status IN")) return { rows: [{ id: failed }] };
    if (sql.startsWith("DELETE FROM knowledge_uploads WHERE id=$1")) {
      // Строка удаляется только после файла: к этому моменту его уже нет.
      filePresentAtRowDelete = existsSync(join(root, String(INTERNAL), failed));
    }
    return undefined;
  });
  let filePresentAtRowDelete: boolean | null = null;
  const box = outbox();
  const service = new KnowledgeUploadService(db as never, { record: box.record(queries) } as never, root);
  assert.deepEqual(await service.clear(USER.id), { deleted: 501 });
  assert.equal(queries.filter((query) => query.sql.startsWith("DELETE FROM knowledge_documents")).length, 2);
  assert.equal(box.jobs.length, 501);
  assert.deepEqual(await readdir(join(root, String(INTERNAL))), [], "файл неудавшейся загрузки остался");
  assert.equal(filePresentAtRowDelete, false, "строка приёма удалена раньше файла");
  const rowDelete = queries.find((query) => query.sql.startsWith("DELETE FROM knowledge_uploads WHERE id=$1"))!;
  assert.deepEqual(rowDelete.params, [failed, INTERNAL]);
});

test("очистка: файл не удалился — строка приёма остаётся для следующей очистки", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-knowledge-clear-fail-"));
  const failed = "0e000000-0000-4000-8000-00000000000e";
  // Вместо файла — непустой каталог: `rm` без recursive откажет.
  await mkdir(join(root, String(INTERNAL), failed, "inner"), { recursive: true });
  const { db, queries } = guardedDb((sql) => {
    const user = resolveUser(sql);
    if (user) return user;
    if (sql.startsWith("SELECT id FROM knowledge_uploads WHERE user_id=$1 AND status IN")) return { rows: [{ id: failed }] };
    return undefined;
  });
  const box = outbox();
  const service = new KnowledgeUploadService(db as never, { record: box.record(queries) } as never, root);
  await assert.rejects(() => service.clear(USER.id));
  assert.ok(!queries.some((query) => query.sql.startsWith("DELETE FROM knowledge_uploads")), "строка удалена, хотя файл остался");
});

test("загрузка новой версии: только своего документа, id — в записи приёма", async () => {
  const root = await mkdtemp(join(tmpdir(), "eva-knowledge-replace-"));
  let own = true;
  const { db, queries } = guardedDb((sql) => {
    const user = resolveUser(sql);
    if (user) return user;
    if (sql.startsWith("SELECT id FROM knowledge_documents WHERE id=$1 AND user_id=$2")) return { rows: own ? [{ id: DOC }] : [] };
    return undefined;
  });
  const box = outbox();
  const service = new KnowledgeUploadService(db as never, { record: box.record(queries) } as never, root);
  const upload = async (replaces?: string) => await service.createFromStream(USER.id, {
    name: "план.md", mime: "text/markdown", stream: Readable.from([Buffer.from("# План v2")]), ...(replaces ? { replaces } : {}),
  });
  await assert.rejects(() => upload("../../etc"), /document_replaces_invalid/u);
  await upload(DOC);
  const insert = queries.find((query) => query.sql.startsWith("INSERT INTO knowledge_uploads"))!;
  assert.equal(insert.params.at(-1), DOC);
  own = false;
  await assert.rejects(() => upload(DOC), /document_replaces_missing/u);
  assert.equal(queries.filter((query) => query.sql.startsWith("INSERT INTO knowledge_uploads")).length, 1);
  assert.deepEqual(await readdir(join(root, String(INTERNAL))).then((files) => files.length), 1, "файл отклонённой загрузки остался");
});
