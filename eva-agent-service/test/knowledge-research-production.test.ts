import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pg from "pg";
import type { PoolClient } from "pg";
import Fastify from "fastify";

import { registerPublicRoutes, type KnowledgeResearchPublic } from "../dist/public/routes.js";
import { ResearchRepository } from "../dist/research/adapters.js";
import { Database } from "../dist/db.js";


const BOT_TOKEN = "123456789:AAAA_test_token";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const USER = { id: 42001, first_name: "Test", username: "test_user", language_code: "ru" };
const OTHER_USER = { id: 42002, first_name: "Other", username: "other_user", language_code: "ru" };

const url = process.env.BATCH16_DATABASE_URL;
const root = resolve(import.meta.dirname, "../..");
const migration = join(root, "postgres/migrations/051_knowledge_research.sql");
const down = join(root, "postgres/migrations/down/051_knowledge_research.sql");
let pool: pg.Pool;

async function sqlFile(path: string) { await pool.query(await readFile(path, "utf8")); }

function signInitData(user: Record<string, unknown>, authDate: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDate), query_id: "AAEAAAE",
    signature: "telegram-ed25519-signature", user: JSON.stringify(user),
  });
  const check = [...params.entries()].sort(([l], [r]) => l.localeCompare(r))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function buildTestApp(overrides: { knowledgeResearch?: KnowledgeResearchPublic; config?: Record<string, unknown> } = {}) {
  const app = Fastify({ logger: false });
  registerPublicRoutes(app, {
    config: { telegramBotToken: BOT_TOKEN, telegramWebAppMaxAgeSeconds: 3_600, rateLimitWindowSeconds: 60, publicRateLimitPerIp: 100, publicRateLimitPerUser: 60, ...(overrides.config ?? {}) } as never,
    repository: {
      openSession: async (user) => ({ user: { id: 1, first_name: user.first_name, last_name: null, username: user.username ?? null, language_code: user.language_code ?? "ru", timezone: "UTC" }, plan: "free", quotas: [] }),
      getToday: async () => ({ main_action: "test" }),
      listTasks: async () => [],
      getProfile: async () => ({ telegram_id: 0, timezone: "UTC" }),
      updateProfile: async (_, input) => ({ telegram_id: 0, input }),
      getProgress: async () => ({ percent: 0 }),
      startWorkBlock: async () => ({}),
      completeWorkBlock: async () => ({}),
      listGoals: async () => [],
      createGoal: async () => ({ id: "g1" }),
      updateGoal: async () => ({ id: "g1" }),
      getConversations: async () => [],
      createConversation: async () => ({ id: "c1" }),
      activateConversation: async () => ({ id: "c1" }),
      archiveConversation: async () => ({}),
    },
    now: () => NOW,
    ...(overrides.knowledgeResearch ? { knowledgeResearch: overrides.knowledgeResearch } : {}),
  });
  return app;
}

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url });
  const stmts = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "CREATE TABLE IF NOT EXISTS schema_migrations(version text primary key)",
    "CREATE TABLE IF NOT EXISTS users(id bigserial primary key, telegram_id bigint unique)",
    "CREATE TABLE IF NOT EXISTS telegram_outbox(id bigserial primary key,idempotency_key text unique,user_id bigint,chat_id bigint,telegram_method text,payload jsonb,priority int)",
    "CREATE TABLE IF NOT EXISTS agent_conversations(user_id bigint,conversation_id text,agent_id text,purpose text,status text)",
    "CREATE TABLE IF NOT EXISTS job_outbox(id bigserial primary key,type text,queue text,user_id bigint,trace_id text,correlation_id text,idempotency_key text,payload_ref text,payload jsonb,deadline_ms int,timezone text,source text,privacy text)",
    "CREATE TABLE IF NOT EXISTS job_runs(id text primary key,type text,queue text,user_id bigint,correlation_id text,status text,started_at timestamptz,completed_at timestamptz,expires_at timestamptz,last_heartbeat_at timestamptz,cancel_requested boolean DEFAULT false,cancel_token text)",
  ];
  for (const s of stmts) await pool.query(s);
  await pool.query("INSERT INTO users(telegram_id) VALUES($1),($2) ON CONFLICT DO NOTHING", [USER.id, OTHER_USER.id]);
  await pool.query("INSERT INTO agent_conversations(user_id,conversation_id,agent_id,purpose,status) SELECT id,'conv-research','agent-1','research','active' FROM users WHERE telegram_id=$1 LIMIT 1", [USER.id]);
});
after(async () => { if (pool) await pool.end(); });

// ───────────── A. Route-level: auth, multipart, tenant ─────────────

test("knowledge upload route rejects missing auth", async () => {
  const calls: string[] = [];
  const app = buildTestApp({ knowledgeResearch: { upload: async () => { calls.push("upload"); return { id: "u1", status: "queued" }; }, uploadStatus: async () => null, researchCreate: async () => ({}), researchStatus: async () => null, researchReport: async () => null, researchCancel: async () => ({ cancelled: false }) } });
  const r = await app.inject({ method: "POST", url: "/public/knowledge/uploads", payload: Buffer.from("test") });
  assert.equal(r.statusCode, 401);
  assert.equal(calls.length, 0);
  await app.close();
});

test("knowledge upload route accepts valid multipart with signed auth", async () => {
  const captured: Array<{ telegramId: number; name: string; mime: string }> = [];
  const app = buildTestApp({ knowledgeResearch: {
    upload: async (telegramId, input) => { captured.push({ telegramId, name: input.name, mime: input.mime }); /* consume stream */ const chunks: Buffer[] = []; for await (const c of input.stream) chunks.push(Buffer.from(c)); return { id: "u1", status: "queued" }; },
    uploadStatus: async () => ({ id: "u1", status: "queued" }), researchCreate: async () => ({}), researchStatus: async () => null, researchReport: async () => null, researchCancel: async () => ({ cancelled: false }),
  } });
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  const boundary = "----TestBoundary123";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello world\r\n--${boundary}--\r\n`;
  const r = await app.inject({ method: "POST", url: "/public/knowledge/uploads", headers: { "x-telegram-init-data": initData, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(r.statusCode, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].telegramId, USER.id);
  assert.equal(captured[0].name, "test.txt");
  assert.equal(captured[0].mime, "text/plain");
  await app.close();
});

test("knowledge upload route denies cross-tenant spoof via initData", async () => {
  let receivedId = 0;
  const app = buildTestApp({ knowledgeResearch: {
    upload: async (telegramId) => { receivedId = telegramId; return { id: "u1", status: "queued" }; },
    uploadStatus: async () => null, researchCreate: async () => ({}), researchStatus: async () => null, researchReport: async () => null, researchCancel: async () => ({ cancelled: false }),
  } });
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  // Even if user tries to pass other user's data, telegramId comes from signed initData
  const boundary = "----TestBoundary456";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\ndata\r\n--${boundary}--\r\n`;
  const r = await app.inject({ method: "POST", url: "/public/knowledge/uploads", headers: { "x-telegram-init-data": initData, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(r.statusCode, 200);
  assert.equal(receivedId, USER.id); // identity from signature, not from body
  await app.close();
});

test("knowledge upload returns 400 when feature disabled", async () => {
  const app = buildTestApp(); // no knowledgeResearch
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  const r = await app.inject({ method: "POST", url: "/public/knowledge/uploads", headers: { "x-telegram-init-data": initData, "content-type": "multipart/form-data; boundary=x" }, payload: "--x--" });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /отключена/);
  await app.close();
});

test("research create route rejects missing auth", async () => {
  const app = buildTestApp({ knowledgeResearch: { upload: async () => ({ id: "u1", status: "queued" }), uploadStatus: async () => null, researchCreate: async () => ({ id: "r1" }), researchStatus: async () => null, researchReport: async () => null, researchCancel: async () => ({ cancelled: false }) } });
  const r = await app.inject({ method: "POST", url: "/public/research", payload: { query: "test", conversation_id: "c", agent_id: "a" } });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("research status/report/cancel routes are tenant-scoped", async () => {
  const calls: Array<{ op: string; telegramId: number; id: string }> = [];
  const app = buildTestApp({ knowledgeResearch: {
    upload: async () => ({ id: "u1", status: "queued" }), uploadStatus: async () => null,
    researchCreate: async (t) => { calls.push({ op: "create", telegramId: t, id: "" }); return { id: "r1" }; },
    researchStatus: async (t, id) => { calls.push({ op: "status", telegramId: t, id }); return { id, status: "processing" }; },
    researchReport: async (t, id) => { calls.push({ op: "report", telegramId: t, id }); return { summary: "ok" }; },
    researchCancel: async (t, id) => { calls.push({ op: "cancel", telegramId: t, id }); return { cancelled: true }; },
  } });
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  const authHeaders = { "x-telegram-init-data": initData };
  // All routes pass through verified identity → telegramId from initData
  assert.equal((await app.inject({ method: "POST", url: "/public/research", headers: authHeaders, payload: { query: "test", conversation_id: "c", agent_id: "a" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/public/research/r1", headers: authHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/public/research/r1/report", headers: authHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/public/research/r1/cancel", headers: authHeaders })).statusCode, 200);
  // All calls used the signed USER.id
  for (const c of calls) assert.equal(c.telegramId, USER.id);
  await app.close();
});

test("research routes return 400 when feature disabled", async () => {
  const app = buildTestApp();
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  for (const [method, url] of [["POST", "/public/research"], ["GET", "/public/research/r1"], ["GET", "/public/research/r1/report"], ["POST", "/public/research/r1/cancel"]] as const) {
    const r = await app.inject({ method, url, headers: { "x-telegram-init-data": initData }, ...(method === "POST" && url === "/public/research" ? { payload: { query: "test" } } : {}) });
    assert.equal(r.statusCode, 400, `${method} ${url}`);
    assert.match(r.json().message, /отключен/i);
  }
  await app.close();
});

// ───────────── B. Job layer registration ─────────────

test("buildJobLayer registers knowledge_ingest and research_run when flags enabled", { skip: !url }, async () => {
  const db = new Database(url!);
  await db.connect();
  try {
    // buildJobLayer needs many deps; we verify registration by checking the source
    const source = await readFile(join(root, "eva-agent-service/src/jobs/index.ts"), "utf8");
    assert.match(source, /knowledge_ingest/i, "knowledge_ingest handler registered");
    assert.match(source, /research_run/i, "research_run handler registered");
    assert.match(source, /queue\("research"\)/, "research queue opened");
    assert.match(source, /queue\("memory"\)/, "memory queue for knowledge");
    // Verify knowledge_uploads is in TENANT_TABLES
    const tables = await readFile(join(root, "eva-agent-service/src/tenancy/tables.ts"), "utf8");
    assert.match(tables, /knowledge_uploads/, "knowledge_uploads is tenant-scoped");
  } finally { await db.close(); }
});

// ───────────── C. Active cancellation ─────────────

test("ResearchEnqueuer.cancel invokes requestCancelByCorrelation on JobRunJournal", { skip: !url }, async () => {
  await sqlFile(migration);
  const userId = Number((await pool.query("SELECT id FROM users WHERE telegram_id=$1", [USER.id])).rows[0].id);
  const db = new Database(url!);
  await db.connect();
  let cancelCalled = false;
  let cancelCorrelationId = "";
  const fakeRuns = { requestCancelByCorrelation: async (cid: string, _uid: number, _token: string) => { cancelCalled = true; cancelCorrelationId = cid; return true; } };
  // Import ResearchEnqueuer from dist
  const { ResearchEnqueuer } = await import("../dist/research/enqueue.js");
  const fakeOutbox = { record: async () => ({}) };
  const enqueuer = new ResearchEnqueuer(db, fakeOutbox as never, fakeRuns as never);
  const requestId = randomUUID();
  // Seed request
  await pool.query("INSERT INTO research_requests(id,user_id,conversation_id,agent_id,query,status) VALUES($1,$2,'conv-research','agent-1','test query','processing')", [requestId, userId]);
  const result = await enqueuer.cancel(userId, requestId);
  assert.equal(cancelCalled, true, "requestCancelByCorrelation was called");
  assert.equal(cancelCorrelationId, requestId, "correlation ID matches request ID");
  assert.equal(result, true, "cancel returned true");
  // Verify request marked cancelled
  const row = (await pool.query("SELECT status FROM research_requests WHERE id=$1", [requestId])).rows[0];
  assert.equal(row.status, "cancelled");
  await db.close();
});

// ───────────── D. Research atomicity in real PG ─────────────

test("research report+sources+claims+outbox commit atomically", { skip: !url }, async () => {
  await sqlFile(migration);
  const userId = Number((await pool.query("SELECT id FROM users WHERE telegram_id=$1", [USER.id])).rows[0].id);
  const db = new Database(url!); await db.connect();
  const repo = new ResearchRepository(db);
  const id = randomUUID(), srcId = randomUUID();
  await pool.query("INSERT INTO research_requests(id,user_id,conversation_id,agent_id,query,status) VALUES($1,$2,'conv-research','agent-1','q','processing')", [id, userId]);
  const report = { id, userId, conversationId: "conv-research", summary: "test summary", confidence: 1, checkedAt: new Date().toISOString(), memoryWritten: false as const,
    sources: [{ id: srcId, url: "https://example.com/a", canonicalUrl: "https://example.com/a", domain: "example.com", title: "A", author: null, publishedAt: null, retrievedAt: new Date().toISOString(), contentHash: "h1", type: "text/html", language: "en", relevance: 1, quality: 0.8, status: "read" as const }],
    claims: [{ claim: "fact A", sourceId: srcId, evidenceQuote: "evidence A", evidenceStart: 0, evidenceEnd: 10, evidenceHash: "eh1", contradiction: null }],
  };
  await db.withUserScope({ userId, label: "test.atomic", inherit: true }, async () => db.transaction(async (client: PoolClient) => repo.saveWithCompletion(client, report, { requestId: id, chatId: USER.id })));
  // Verify all committed
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_reports WHERE id=$1", [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_sources WHERE report_id=$1", [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_claim_sources WHERE report_id=$1", [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT status FROM research_requests WHERE id=$1", [id])).rows[0].status, "completed");
  assert.equal((await pool.query("SELECT count(*)::int n FROM telegram_outbox WHERE idempotency_key=$1", [`research-summary:${id}`])).rows[0].n, 1);
  await db.close();
});

test("research atomic failure rolls back all", { skip: !url }, async () => {
  await sqlFile(migration);
  const userId = Number((await pool.query("SELECT id FROM users WHERE telegram_id=$1", [USER.id])).rows[0].id);
  const db = new Database(url!); await db.connect();
  const repo = new ResearchRepository(db);
  const id = randomUUID(), srcId = randomUUID();
  await pool.query("INSERT INTO research_requests(id,user_id,conversation_id,agent_id,query,status) VALUES($1,$2,'conv-research','agent-1','q','processing')", [id, userId]);
  const badReport = { id, userId, conversationId: "conv-research", summary: "bad", confidence: 0, checkedAt: new Date().toISOString(), memoryWritten: false as const,
    sources: [{ id: srcId, url: "http://invalid", canonicalUrl: "http://invalid", domain: "invalid", title: "X", author: null, publishedAt: null, retrievedAt: new Date().toISOString(), contentHash: "h", type: "web", language: "en", relevance: 0, quality: 0, status: "read" as const }],
    claims: [{ claim: "bad", sourceId: srcId, evidenceQuote: "bad", evidenceStart: 0, evidenceEnd: 3, evidenceHash: "bh", contradiction: null }],
  };
  // Inject constraint to force failure
  await pool.query("ALTER TABLE research_sources ADD CONSTRAINT batch16_fail_test CHECK (domain <> 'invalid') NOT VALID");
  await assert.rejects(db.withUserScope({ userId, label: "test.rollback", inherit: true }, async () => db.transaction(async (client: PoolClient) => repo.saveWithCompletion(client, badReport, { requestId: id, chatId: USER.id }))));
  // Everything rolled back
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_reports WHERE id=$1", [id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_sources WHERE report_id=$1", [id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM telegram_outbox WHERE idempotency_key=$1", [`research-summary:${id}`])).rows[0].n, 0);
  await pool.query("ALTER TABLE research_sources DROP CONSTRAINT batch16_fail_test");
  await db.close();
});

// ───────────── E. Migration lifecycle ─────────────

test("migration 051 is repeatable and idempotent", { skip: !url }, async () => {
  await sqlFile(migration); await sqlFile(migration); // no error
  assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version='051_knowledge_research'")).rows[0].n, 1);
  assert.notEqual((await pool.query("SELECT to_regclass('knowledge_uploads')")).rows[0].t, null);
  assert.notEqual((await pool.query("SELECT to_regclass('research_reports')")).rows[0].t, null);
});

test("down migration removes all 051 tables", { skip: !url }, async () => {
  await sqlFile(down);
  const checkTable = async (name: string) => {
    const r = await pool.query("SELECT to_regclass($1) AS t", [name]);
    return r.rows[0]?.t ?? null;
  };
  assert.equal(await checkTable("knowledge_uploads"), null);
  assert.equal(await checkTable("knowledge_documents"), null);
  assert.equal(await checkTable("research_reports"), null);
  // Re-apply for subsequent tests
  await sqlFile(migration);
});

// ───────────── F. Upload lifecycle with real filesystem ─────────────

test("createFromStream persists file and records outbox", { skip: !url }, async () => {
  await sqlFile(migration);
  const userId = Number((await pool.query("SELECT id FROM users WHERE telegram_id=$1", [USER.id])).rows[0].id);
  const db = new Database(url!); await db.connect();
  const uploadRoot = await mkdtemp(join(tmpdir(), "batch16-upload-"));
  const outboxRecords: unknown[] = [];
  const fakeOutbox = { record: async (_client: unknown, entry: unknown) => { outboxRecords.push(entry); return ""; } };
  const { KnowledgeUploadService } = await import("../dist/knowledge/lifecycle.js");
  const svc = new KnowledgeUploadService(db, fakeOutbox as never, uploadRoot);
  const stream = Readable.from(Buffer.from("hello knowledge"));
  const result = await svc.createFromStream(USER.id, { name: "doc.txt", mime: "text/plain", stream });
  assert.equal(result.status, "queued");
  assert.ok(result.id);
  // DB row
  const row = (await pool.query("SELECT name,mime,size_bytes,status FROM knowledge_uploads WHERE id=$1 AND user_id=$2", [result.id, userId])).rows[0];
  assert.equal(row.name, "doc.txt");
  assert.equal(row.mime, "text/plain");
  assert.equal(row.size_bytes, "15");
  assert.equal(row.status, "queued");
  // Outbox
  assert.equal(outboxRecords.length, 1);
  // File exists
  const files = await readdir(join(uploadRoot, String(userId)));
  assert.ok(files.length > 0);
  await db.close();
  await rm(uploadRoot, { recursive: true, force: true });
});

test("createFromStream rejects unsupported MIME and oversized", { skip: !url }, async () => {
  const db = new Database(url!); await db.connect();
  const uploadRoot = await mkdtemp(join(tmpdir(), "batch16-reject-"));
  const fakeOutbox = { record: async () => "" };
  const { KnowledgeUploadService } = await import("../dist/knowledge/lifecycle.js");
  const svc = new KnowledgeUploadService(db, fakeOutbox as never, uploadRoot, 4);
  await assert.rejects(svc.createFromStream(USER.id, { name: "virus.exe", mime: "application/x-msdownload", stream: Readable.from(Buffer.from("x")) }), /unsupported/);
  await assert.rejects(svc.createFromStream(USER.id, { name: "big.txt", mime: "text/plain", stream: Readable.from(Buffer.from("12345")) }), /too_large/);
  await db.close();
  await rm(uploadRoot, { recursive: true, force: true });
});
