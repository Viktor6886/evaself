/**
 * Жизненный цикл на настоящих PostgreSQL и Qdrant, той же схемe и
 * сервисах, что в приложении. Подменяется только embedding-upstream
 * (детерминированный провайдер без внешних ключей) и антивирус.
 * Выбор инструмента и естественный ответ Letta здесь не имитируются:
 * это отдельный canary с настроенным LLM, см. docs/knowledge-base.md.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { Database } from "../../eva-agent-service/dist/db.js";
import { SecretBox } from "../../eva-agent-service/dist/llm.js";
import { guardPool } from "../../eva-agent-service/dist/tenancy/guarded-pool.js";
import { adminScope, runInScope } from "../../eva-agent-service/dist/tenancy/scope.js";
import { KnowledgeEmbeddingService } from "../../eva-agent-service/dist/admin/knowledge-embedding-service.js";
import { KnowledgeDocumentsService } from "../../eva-agent-service/dist/admin/knowledge-documents-service.js";
import { RouterStore } from "../../eva-agent-service/dist/router/store.js";
import { RouterEmbeddings } from "../../eva-agent-service/dist/router/embeddings.js";
import { EmbeddingVersionStore } from "../../eva-agent-service/dist/router/embedding-versions.js";
import { EmbeddingService } from "../../eva-agent-service/dist/router/embedding-service.js";
import { LlmRouterClient } from "../../eva-agent-service/dist/router/client.js";
import { QdrantClient } from "../../eva-agent-service/dist/knowledge/qdrant-client.js";
import { KnowledgeVectorStore } from "../../eva-agent-service/dist/knowledge/vector-store.js";
import { KnowledgeIngestWorker } from "../../eva-agent-service/dist/knowledge/lifecycle.js";
import { KnowledgeIndexer, knowledgeIndexScheduler } from "../../eva-agent-service/dist/knowledge/indexer.js";
import { KnowledgeMaintenance } from "../../eva-agent-service/dist/knowledge/maintenance.js";
import { KnowledgeSearch } from "../../eva-agent-service/dist/knowledge/search.js";
import { CoreToolFactory } from "../../eva-agent-service/dist/tools/core-tools.js";
import { recordJobIntent } from "../../eva-agent-service/dist/jobs/job-outbox.js";

assert.equal(process.env.KNOWLEDGE_INTEGRATION_TEST, "true", "только изолированная CI-база");
const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString, "нужен DATABASE_URL изолированной базы");
const raw = new pg.Pool({ connectionString });
const pool = guardPool(raw);
const db = new Database(connectionString);
const root = await mkdtemp(join(tmpdir(), "eva-kb-ci-"));
const providerId = randomUUID();
const ownDocuments = [];
const ownCollections = [];
const ownVersions = [];
const ownUsers = [];
const master = "ci-knowledge-master-key-for-fixtures-only";
const routerStore = new RouterStore(pool, master);
const qdrant = new QdrantClient({ url: process.env.QDRANT_TEST_URL ?? "http://127.0.0.1:6333", apiKey: "ci-qdrant-key" });
const store = new KnowledgeVectorStore(qdrant);
const admin = async (work) => await runInScope(adminScope({ actor: "ci", role: "owner", auditId: "kb-ci", route: "knowledge-lifecycle" }), work);
const outbox = { record: recordJobIntent };
const indexJobs = knowledgeIndexScheduler(outbox, () => true);

const fixtureFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const dimension = body.model === "ci-psychology-8" ? 8 : body.model === "ci-psychology-12" ? 12 : 0;
  assert.ok(dimension, "используется модель конкретной версии");
  return new Response(JSON.stringify({ data: body.input.map((_text, index) => ({ index,
    embedding: Array.from({ length: dimension }, (_, i) => i === (dimension === 8 ? 0 : 1) ? 1 : 0),
  })) }));
};
const embedding = new EmbeddingService(new RouterEmbeddings(routerStore, { model: "ci-psychology-8", dimension: 8, fetch: fixtureFetch }), new EmbeddingVersionStore(pool));
// Канонический клиент и канонический EmbeddingService: transport заменён,
// маршрутизация модели по версии и реестр провайдера остаются настоящими.
const router = new LlmRouterClient("http://ci-router", "ci", async (_url, init) => {
  const body = JSON.parse(init.body);
  const result = await embedding.embed(body.model, body.input);
  return new Response(JSON.stringify({ data: result.vectors.map((vector, index) => ({ index, embedding: vector })) }));
});
const versions = new KnowledgeEmbeddingService(pool, { request: async (_path, init) => {
  const b = JSON.parse(init.body);
  return await embedding.probe({ providerId: b.provider_id, model: b.model, dimension: b.dimension, requestDimensions: b.request_dimensions });
} });
const documents = new KnowledgeDocumentsService(pool, { uploadsRoot: root, store, uploadsEnabled: true });
const indexer = new KnowledgeIndexer(db, router, store, { enabled: () => true, configured: () => true, batchSize: () => 32, uploadsRoot: root, jobs: indexJobs });
const maintenance = new KnowledgeMaintenance(db, store, indexer, { enabled: () => true, configured: () => true, uploadsRoot: root, outbox, index: indexJobs });

async function job(type, reference) {
  const result = await admin(async () => await pool.query(
    "SELECT envelope FROM job_outbox WHERE job_type = $1 AND envelope->>'payloadRef' = $2 ORDER BY created_at DESC LIMIT 1", [type, String(reference)],
  ));
  assert.ok(result.rows[0], "задание записано в существующий outbox");
  return { envelope: result.rows[0].envelope, signal: new AbortController().signal, attempt: 1, timing: { maxAttempts: 3 } };
}

async function createVersion(model) {
  const probed = await versions.probe({ provider_id: providerId, model });
  assert.equal(probed.ok, true);
  const created = await versions.createVersion({ provider_id: providerId, model });
  ownVersions.push(created.version);
  assert.equal(created.status, "draft");
  // Перечитывается новым экземпляром сервиса: конфигурация не в DOM/кэше.
  const saved = await new KnowledgeEmbeddingService(pool, {}).overview();
  assert.equal(saved.versions.find((v) => v.version === created.version).model, model);
  return created;
}

async function build(version) {
  await admin(async () => await documents.build(version, { full: true }));
  assert.equal((await maintenance.rebuild(await job("knowledge_rebuild", version))).status, "done");
  assert.equal((await pool.query("SELECT status FROM knowledge_embedding_versions WHERE version = $1", [version])).rows[0].status, "ready");
}

const settings = () => ({ enabled: true, mode: "hybrid", vectorBackend: "qdrant", privateEnabled: true, globalEnabled: true, shadow: false, neighbors: 0, rerank: null });
const search = new KnowledgeSearch(db, undefined, { settings, vectors: store, embedVersion: async (text, v, signal) => (await router.embedMany([text], { ...v, signal }))[0] });
const tools = new CoreToolFactory({ routerUrl: "http://ci-router", routerApiKey: "ci" }, {}, {}, search).build(
  (name, _label, _description, _schema, execute) => ({ name, execute }),
);
const tool = tools.find((t) => t.name === "knowledge_search");
const query = "прокрастинация избегание сложных задач эмоциональная регуляция";
const question = "Почему я постоянно откладываю сложные задачи и что с этим делать?";

try {
  assert.equal(Number((await raw.query("SELECT count(*) AS n FROM knowledge_chunks")).rows[0].n), 0, "CI-сценарий требует пустой базы знаний");
  assert.equal(Number((await raw.query("SELECT count(*) AS n FROM knowledge_embedding_versions WHERE status = 'active'")).rows[0].n), 0);
  await db.connect();
  assert.equal(await store.ready(), true);
  await pool.query(`INSERT INTO llm_providers(id, name, protocol, base_url, model, context_window, api_key_encrypted, enabled)
    VALUES ($1, $2, 'openai-compatible', 'http://ci-upstream.invalid', 'ci-chat', 4096, $3, true)`,
  [providerId, `CI knowledge ${providerId}`, new SecretBox(master).encrypt("ci-placeholder")]);
  const overview = await versions.overview();
  assert.ok(overview.providers.some((p) => p.id === providerId));
  assert.doesNotMatch(JSON.stringify(overview), /api_key|ci-placeholder|base_url/u);
  const first = await createVersion("ci-psychology-8");
  await assert.rejects(() => admin(async () => await documents.activate(first.version)), /построенную/u);
  await build(first.version);
  await admin(async () => await documents.activate(first.version, { expected_active_version: null }));
  assert.deepEqual(await store.activeVersions(), { private: first.version, global: first.version });

  const collection = await admin(async () => await documents.createCollection({ code: `ci-psych-${providerId.slice(0, 8)}`, title: "Психология CI" }));
  ownCollections.push(collection.id);
  const uploaded = await admin(async () => await documents.upload({ collectionId: collection.id, name: "Саморегуляция.md", mime: "text/markdown",
    stream: Readable.from([Buffer.from("# Прокрастинация\nПрокрастинация — избегание сложных задач ради краткого облегчения неприятных эмоций. Помогают маленький первый шаг и доброжелательная оценка трудностей.")]) }));
  ownDocuments.push(uploaded.id);
  const worker = new KnowledgeIngestWorker(db, { tempRoot: root, scan: async () => "clean", legacyEmbeddings: () => false,
    embed: async () => { throw new Error("legacy embedding не нужен Qdrant"); }, index: indexJobs });
  await worker.run(await job("knowledge_ingest", uploaded.id));
  const parsed = await admin(async () => await pool.query("SELECT content, embedding FROM knowledge_chunks WHERE document_id = $1 -- tenant: system — фрагменты только CI-загрузки", [uploaded.id]));
  assert.ok(parsed.rows.length);
  assert.ok(parsed.rows.every((c) => c.embedding === null));
  assert.equal((await indexer.run(await job("knowledge_index", uploaded.id))).status, "ready");
  for (const telegram of [-96200001, -96200002]) {
    ownUsers.push(Number((await admin(async () => await pool.query("INSERT INTO users(telegram_id, first_name) VALUES ($1, 'CI') RETURNING id", [telegram]))).rows[0].id));
  }
  const foreignDoc = randomUUID(); ownDocuments.push(foreignDoc);
  await admin(async () => {
    await pool.query("INSERT INTO knowledge_documents(id,user_id,name,mime,content_hash,status,chunk_count) VALUES($1,$2,'Чужой документ CI','text/plain','ci-foreign','ready',1)", [foreignDoc, ownUsers[1]]);
    await pool.query("INSERT INTO knowledge_chunks(document_id,user_id,product_verified,ordinal,content,content_hash,embedding,embedding_model) VALUES($1,$2,false,0,'Прокрастинация: чужой секрет CI','ci-foreign',NULL,'router')", [foreignDoc, ownUsers[1]]);
  });
  await indexer.index(foreignDoc, ownUsers[1]);
  const answer = await tool.execute({ query, user_id: ownUsers[1] }, { userId: ownUsers[0] });
  assert.equal(answer.untrusted, true); assert.equal(answer.degraded, false);
  assert.ok(answer.results.some((hit) => hit.document === "Саморегуляция.md" && hit.base === "shared" && hit.cite.includes("Прокрастинация")));
  assert.ok(answer.results.every((hit) => hit.document !== "Чужой документ CI"));
  // Id Qdrant не разрешает чтение: поддельный payload владельца не
  // проведёт чужой фрагмент через гидратацию PostgreSQL.
  const foreignPoint = (await store.scrollPoints("private", first.version, null, 256)).points[0];
  const stolen = await store.vectorsOf("private", first.version, [Number(foreignPoint.id)]);
  await store.upsert("private", { ...first }, [{ chunkId: Number(foreignPoint.id), vector: stolen.get(Number(foreignPoint.id)), payload: { ...foreignPoint.payload, user_id: String(ownUsers[0]) } }]);
  const isolated = await search.search(ownUsers[0], query);
  assert.ok(isolated.hits.every((hit) => hit.documentId !== foreignDoc));
  await assert.rejects(() => admin(async () => await documents.activate(first.version, { verify_only: true })), /владельцам/u);
  assert.deepEqual(await store.activeVersions(), { private: first.version, global: first.version });
  await indexer.index(foreignDoc, ownUsers[1]);
  await admin(async () => await documents.updateCollection(collection.id, { enabled: false }));
  assert.equal((await search.search(ownUsers[0], query)).hits.length, 0, "выключенная общая коллекция скрыта даже из кэша Qdrant");
  await admin(async () => await documents.updateCollection(collection.id, { enabled: true }));

  const second = await createVersion("ci-psychology-12");
  await build(second.version);
  const switched = await Promise.allSettled([
    admin(async () => await documents.activate(second.version, { expected_active_version: first.version })),
    admin(async () => await documents.activate(second.version, { expected_active_version: first.version })),
  ]);
  assert.equal(switched.filter((r) => r.status === "fulfilled").length, 1, "переключение сериализуется в PostgreSQL");
  assert.equal(switched.filter((r) => r.status === "rejected").length, 1, "устаревшее действие не проходит");
  assert.deepEqual(await store.activeVersions(), { private: second.version, global: second.version });
  assert.equal((await pool.query("SELECT status FROM knowledge_embedding_versions WHERE version=$1", [first.version])).rows[0].status, "retired");
  assert.equal((await search.search(ownUsers[0], question)).degraded, false, "новая модель видна сразу при другой размерности");
  await admin(async () => await documents.activate(first.version, { expected_active_version: second.version }));
  assert.deepEqual(await store.activeVersions(), { private: first.version, global: first.version });

  const { private: privateInfo, global: globalInfo } = await store.describe(first.version);
  assert.equal(privateInfo.size, 8); assert.equal(globalInfo.size, 8);
  // Удаляем производную коллекцию активной версии, PostgreSQL цел.
  // Это реальный отказ Qdrant, а не заранее подставленный degraded.
  await qdrant.deleteCollection(`eva_knowledge_global_v${first.version}`);
  const fallback = await tool.execute({ query }, { userId: ownUsers[0] });
  assert.equal(fallback.degraded, true);
  assert.ok(fallback.results.some((hit) => hit.content.includes("маленький первый шаг")));
  console.log("PASS: registry/probe/persist/build/outbox/first activation/K7/rollback/semantic tool/citations/tenant hydration/disabled collection/real Qdrant fallback");
  console.log("Embedding upstream and AV are fixtures; autonomous Letta tool choice and final prose require the documented live canary.");
} finally {
  await admin(async () => {
    if (ownDocuments.length) {
      await pool.query("DELETE FROM knowledge_uploads WHERE id=ANY($1::uuid[]) -- tenant: system — только CI-загрузки", [ownDocuments]);
      await pool.query("DELETE FROM knowledge_documents WHERE id=ANY($1::uuid[]) -- tenant: system — только CI-документы", [ownDocuments]);
    }
    if (ownCollections.length) await pool.query("DELETE FROM knowledge_collections WHERE id=ANY($1::uuid[])", [ownCollections]);
    if (ownUsers.length) await pool.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [ownUsers]);
    if (ownVersions.length) {
      await store.activate(null);
      for (const v of ownVersions) await store.dropVersion(v);
      await pool.query("DELETE FROM knowledge_embedding_versions WHERE version=ANY($1::integer[])", [ownVersions]);
    }
    await pool.query("DELETE FROM llm_providers WHERE id=$1", [providerId]);
    await pool.query("DELETE FROM job_outbox WHERE envelope->>'payloadRef' = ANY($1::text[]) -- tenant: system — только задания CI-артефактов", [[...ownDocuments, ...ownVersions.map(String)]]);
  });
  await routerStore.close(); await db.close(); await raw.end();
  await rm(root, { recursive: true, force: true });
}
