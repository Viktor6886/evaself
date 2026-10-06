/**
 * Жизненный цикл на настоящих PostgreSQL и Qdrant, той же схемe и
 * сервисах, что в приложении. Подменяется только embedding-upstream
 * (детерминированный провайдер без внешних ключей) и антивирус.
 * Выбор инструмента и естественный ответ Letta здесь не имитируются:
 * это отдельный canary с настроенным LLM, см. docs/knowledge-base.md.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { Database } from "../../eva-agent-service/dist/db.js";
import { SecretBox } from "../../eva-agent-service/dist/llm.js";
import { guardPool } from "../../eva-agent-service/dist/tenancy/guarded-pool.js";
import { adminScope, runInScope } from "../../eva-agent-service/dist/tenancy/scope.js";
import { KnowledgeEmbeddingService } from "../../eva-agent-service/dist/admin/knowledge-embedding-service.js";
import { KnowledgeDocumentsService } from "../../eva-agent-service/dist/admin/knowledge-documents-service.js";
import { applyManagedRuntimeConfig, readKnowledgeUploadsSetting } from "../../eva-agent-service/dist/admin/managed-runtime-config.js";
import { loadConfig } from "../../eva-agent-service/dist/config.js";
import { RouterStore } from "../../eva-agent-service/dist/router/store.js";
import { RouterEmbeddings } from "../../eva-agent-service/dist/router/embeddings.js";
import { EmbeddingVersionStore } from "../../eva-agent-service/dist/router/embedding-versions.js";
import { EmbeddingService } from "../../eva-agent-service/dist/router/embedding-service.js";
import { LlmRouterClient } from "../../eva-agent-service/dist/router/client.js";
import { QdrantClient } from "../../eva-agent-service/dist/knowledge/qdrant-client.js";
import { KnowledgeVectorStore } from "../../eva-agent-service/dist/knowledge/vector-store.js";
import { KnowledgeIngestWorker, KnowledgeUploadService } from "../../eva-agent-service/dist/knowledge/lifecycle.js";
import { KnowledgeIndexer, knowledgeIndexScheduler } from "../../eva-agent-service/dist/knowledge/indexer.js";
import { KnowledgeMaintenance } from "../../eva-agent-service/dist/knowledge/maintenance.js";
import { KnowledgeSearch } from "../../eva-agent-service/dist/knowledge/search.js";
import { legacyCandidates } from "../../eva-agent-service/dist/knowledge/search-queries.js";
import { withKnowledgeIndexWrite } from "../../eva-agent-service/dist/knowledge/version-validation.js";
import { CoreToolFactory } from "../../eva-agent-service/dist/tools/core-tools.js";
import { recordJobIntent } from "../../eva-agent-service/dist/jobs/job-outbox.js";

assert.equal(process.env.KNOWLEDGE_INTEGRATION_TEST, "true", "только изолированная CI-база");
const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString, "нужен DATABASE_URL изолированной базы");
const qdrantContainer = process.env.QDRANT_TEST_CONTAINER;
assert.match(qdrantContainer ?? "", /^[a-f0-9]{12,64}$/u, "нужен id контейнера Qdrant только этой CI-job");
const docker = promisify(execFile);
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

let beforeEmbeddingResponse = async () => {};
const fixtureFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const dimension = body.model === "ci-psychology-8" ? 8 : body.model === "ci-psychology-12" ? 12 : 0;
  assert.ok(dimension, "используется модель конкретной версии");
  await beforeEmbeddingResponse();
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
const uploadSettingKey = "runtime.knowledge_uploads_enabled";
const originalUploadSetting = (await pool.query("SELECT value_json FROM system_settings WHERE key=$1", [uploadSettingKey])).rows[0];
const uploadOptions = { uploadsRoot: root, store, uploadsEnabled: async () => await readKnowledgeUploadsSetting(pool, false), uploadsWorkerEnabled: true };
const documents = new KnowledgeDocumentsService(pool, uploadOptions);
async function setUploads(enabled) {
  await pool.query("INSERT INTO system_settings(key,value_json) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json", [uploadSettingKey, JSON.stringify(enabled)]);
}
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
  await setUploads(false);
  assert.equal((await admin(async () => await documents.indexOverview())).uploads_enabled, false);
  await assert.rejects(() => admin(async () => await documents.upload({ collectionId: collection.id, name: "непринято.md", mime: "text/markdown", stream: Readable.from([Buffer.from("флаг выключен")]) })), /Включить загрузку/u);
  await setUploads(true);
  assert.equal((await admin(async () => await new KnowledgeDocumentsService(pool, uploadOptions).indexOverview())).uploads_enabled, true, "перезапуск не потерял серверную настройку");
  const runtime = loadConfig({ EVA_KNOWLEDGE_UPLOADS: "false" });
  await applyManagedRuntimeConfig(runtime, db);
  assert.equal(runtime.knowledgeUploadsEnabled, true, "агент продолжил использовать выключенный bootstrap");
  const uploaded = await admin(async () => await documents.upload({ collectionId: collection.id, name: "Саморегуляция.md", mime: "text/markdown",
    stream: Readable.from([Buffer.from("# Прокрастинация\nПрокрастинация — избегание сложных задач ради краткого облегчения неприятных эмоций. Помогают маленький первый шаг и доброжелательная оценка трудностей.")]) }));
  ownDocuments.push(uploaded.id);
  const worker = new KnowledgeIngestWorker(db, { tempRoot: root, scan: async () => "clean", legacyEmbeddings: () => false,
    embed: async () => { throw new Error("legacy embedding не нужен Qdrant"); }, index: indexJobs });
  // Старый consumer закрывал просроченное задание, оставляя queued в PG.
  // Recovery возвращает кнопку повтора, а запоздалый отказ старого задания
  // не портит новый retry и уже готовый документ.
  const expired = (await job("knowledge_ingest", uploaded.id)).envelope;
  expired.deadlineAt = new Date(Date.now() - 60_000).toISOString();
  await admin(async () => await pool.query("UPDATE job_outbox SET envelope=$2::jsonb WHERE idempotency_key=$1",
    [expired.idempotencyKey, JSON.stringify(expired)]));
  assert.equal(await worker.recoverExpiredUploads(), 1);
  const uploadState = async () => (await admin(async () => await pool.query(
    "SELECT status,error_code FROM knowledge_uploads WHERE id=$1 AND user_id IS NULL", [uploaded.id]))).rows[0];
  assert.deepEqual(await uploadState(), { status: "failed", error_code: "job_deadline_exceeded" });
  await admin(async () => await documents.retryUpload(uploaded.id));
  await worker.reject(expired, "job_deadline_exceeded");
  assert.equal((await uploadState()).status, "queued", "старое задание не меняет новый retry");
  assert.equal(await worker.recoverExpiredUploads(), 0, "новая попытка ещё не просрочена");
  await worker.reject((await job("knowledge_ingest", uploaded.id)).envelope, "job_deadline_exceeded");
  assert.equal((await uploadState()).status, "failed", "отказ до handler становится виден в панели");
  // Повтор, который публикатор так и не поставил в очередь (до исправления
  // jobId так кончался каждый «Повторить»): recovery даёт понятный код.
  await admin(async () => await documents.retryUpload(uploaded.id));
  const unpublished = (await job("knowledge_ingest", uploaded.id)).envelope;
  assert.ok(unpublished.idempotencyKey.split(":").length > 3, "ключ повтора несёт двоеточие в различителе");
  await admin(async () => await pool.query("UPDATE job_outbox SET status='dead', error_code='Error' WHERE idempotency_key=$1", [unpublished.idempotencyKey]));
  assert.equal(await worker.recoverExpiredUploads(), 1);
  assert.deepEqual(await uploadState(), { status: "failed", error_code: "job_publish_failed" });
  await admin(async () => await documents.retryUpload(uploaded.id));
  await worker.run(await job("knowledge_ingest", uploaded.id));
  await worker.reject((await job("knowledge_ingest", uploaded.id)).envelope, "job_deadline_exceeded");
  assert.equal((await uploadState()).status, "ready", "поздний отказ не портит готовый документ");
  const parsed = await admin(async () => await pool.query("SELECT content, embedding FROM knowledge_chunks WHERE document_id = $1 -- tenant: system — фрагменты только CI-загрузки", [uploaded.id]));
  assert.ok(parsed.rows.length);
  assert.ok(parsed.rows.every((c) => c.embedding === null));
  assert.equal((await indexer.run(await job("knowledge_index", uploaded.id))).status, "ready");
  // Исторический общий материал без коллекции не должен появляться
  // в поиске, ломать full rebuild или занижать прогресс готового индекса.
  const unscoped = randomUUID(); ownDocuments.push(unscoped);
  await admin(async () => {
    await pool.query("INSERT INTO knowledge_documents(id,user_id,product_verified,name,mime,content_hash,status,chunk_count) VALUES($1,NULL,true,'Без коллекции CI','text/plain','ci-unscoped','ready',1)", [unscoped]);
    await pool.query("INSERT INTO knowledge_chunks(document_id,user_id,product_verified,ordinal,content,content_hash,embedding,embedding_model) VALUES($1,NULL,true,0,'Прокрастинация: скрытый материал без коллекции','ci-unscoped',NULL,'router')", [unscoped]);
  });
  for (const telegram of [-96200001, -96200002]) {
    ownUsers.push(Number((await admin(async () => await pool.query("INSERT INTO users(telegram_id, first_name) VALUES ($1, 'CI') RETURNING id", [telegram]))).rows[0].id));
  }
  const privateUpload = await new KnowledgeUploadService(db, outbox, root).createFromStream(-96200001, {
    name: "Recovery tenant.txt", mime: "text/plain", stream: Readable.from([Buffer.from("Private recovery fixture")]),
  });
  ownDocuments.push(privateUpload.id);
  const privateEnvelope = (await job("knowledge_ingest", privateUpload.id)).envelope;
  const privateState = async () => (await admin(async () => await pool.query(
    "SELECT status FROM knowledge_uploads WHERE id=$1 AND user_id=$2", [privateUpload.id, ownUsers[0]]))).rows[0].status;
  await worker.reject({ ...privateEnvelope, userId: ownUsers[1] }, "job_deadline_exceeded");
  assert.equal(await privateState(), "queued", "подмена владельца не меняет чужую загрузку");
  privateEnvelope.deadlineAt = new Date(Date.now() - 60_000).toISOString();
  await admin(async () => {
    await pool.query("UPDATE job_outbox SET envelope=$2::jsonb WHERE idempotency_key=$1", [privateEnvelope.idempotencyKey, JSON.stringify(privateEnvelope)]);
    await pool.query(`INSERT INTO job_runs(run_id,job_id,queue,job_type,schema_version,user_id,payload_checksum,status,lease_until,timezone)
      VALUES($1,$2,'memory','knowledge_ingest',1,$3,'ci','running',now()+interval '5 minutes','UTC')`,
    [randomUUID(), privateEnvelope.idempotencyKey, ownUsers[0]]);
  });
  assert.equal(await worker.recoverExpiredUploads(), 0, "действующая аренда защищает работу другой реплики");
  await admin(async () => await pool.query("DELETE FROM job_runs WHERE job_id=$1 AND user_id=$2", [privateEnvelope.idempotencyKey, ownUsers[0]]));
  assert.equal(await worker.recoverExpiredUploads(), 1);
  assert.equal(await privateState(), "failed");
  // Проверяется и пользовательская область reject, не только системная.
  await admin(async () => await pool.query("UPDATE knowledge_uploads SET status='queued' WHERE id=$1 AND user_id=$2", [privateUpload.id, ownUsers[0]]));
  await worker.reject(privateEnvelope, "job_deadline_exceeded");
  assert.equal(await privateState(), "failed");
  const foreignDoc = randomUUID(); ownDocuments.push(foreignDoc);
  await admin(async () => {
    await pool.query("INSERT INTO knowledge_documents(id,user_id,name,mime,content_hash,status,chunk_count) VALUES($1,$2,'Чужой документ CI','text/plain','ci-foreign','ready',1)", [foreignDoc, ownUsers[1]]);
    await pool.query("INSERT INTO knowledge_chunks(document_id,user_id,product_verified,ordinal,content,content_hash,embedding,embedding_model) VALUES($1,$2,false,0,'Прокрастинация: чужой секрет CI','ci-foreign',NULL,'router')", [foreignDoc, ownUsers[1]]);
  });
  await indexer.index(foreignDoc, ownUsers[1]);
  const indexOverview = await admin(async () => await documents.indexOverview());
  assert.equal(indexOverview.scopes.global.documents, 1);
  assert.equal(indexOverview.versions.find((v) => v.version === first.version).progress, 1);
  const racedDoc = randomUUID(); ownDocuments.push(racedDoc);
  await admin(async () => {
    await pool.query("INSERT INTO knowledge_documents(id,user_id,name,mime,content_hash,status,chunk_count) VALUES($1,$2,'Удаление во время embeddings','text/plain','ci-race','ready',1)", [racedDoc, ownUsers[0]]);
    await pool.query("INSERT INTO knowledge_chunks(document_id,user_id,product_verified,ordinal,content,content_hash,embedding,embedding_model) VALUES($1,$2,false,0,'Прокрастинация: гонка удаления CI','ci-race',NULL,'router')", [racedDoc, ownUsers[0]]);
  });
  beforeEmbeddingResponse = async () => {
    beforeEmbeddingResponse = async () => {};
    await admin(async () => await pool.query("DELETE FROM knowledge_documents WHERE id=$1 AND user_id=$2", [racedDoc, ownUsers[0]]));
  };
  await assert.rejects(() => indexer.index(racedDoc, ownUsers[0]), /knowledge_document_changed/u);
  assert.equal(await store.documentPoints("private", first.version, racedDoc), 0, "устаревшая загрузка не создала точки-сироты");
  const answer = await tool.execute({ query, user_id: ownUsers[1] }, { userId: ownUsers[0] });
  assert.equal(answer.untrusted, true); assert.equal(answer.degraded, false);
  // Общая база — справочные знания Евы: текст есть, происхождения нет.
  assert.ok(answer.results.some((hit) => hit.content.includes("маленький первый шаг")
    && !["document", "base", "cite", "pages", "section"].some((key) => key in hit)));
  assert.ok(answer.results.every((hit) => !["Чужой документ CI", "Без коллекции CI"].includes(hit.document)));
  assert.ok(answer.results.every((hit) => !/чужой секрет CI|скрытый материал без коллекции/u.test(hit.content)));
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
  // Построение, чья порция не попала в очередь (так кончалось каждое
  // «Построить индекс» до исправления jobId): версия не «строится» вечно.
  const secondState = async () => (await pool.query("SELECT status, error_code FROM knowledge_embedding_versions WHERE version=$1", [second.version])).rows[0];
  await admin(async () => await documents.build(second.version, { full: true }));
  const stalled = (await job("knowledge_rebuild", second.version)).envelope;
  assert.ok(stalled.idempotencyKey.split(":").length > 3, "ключ порции несёт двоеточие в различителе");
  assert.equal(await maintenance.recoverStalledBuilds(), 0, "живое построение не трогается");
  await admin(async () => await pool.query("UPDATE job_outbox SET status='dead', error_code='Error' WHERE idempotency_key=$1", [stalled.idempotencyKey]));
  assert.equal(await maintenance.recoverStalledBuilds(), 1);
  assert.deepEqual(await secondState(), { status: "failed", error_code: "job_publish_failed" });
  assert.equal((await admin(async () => await documents.indexOverview())).versions.find((v) => v.version === second.version).building, false,
    "панель снова показывает кнопку построения");
  await admin(async () => await documents.build(second.version, { full: true }));
  await maintenance.rejectRebuild(stalled, "job_deadline_exceeded");
  assert.deepEqual(await secondState(), { status: "building", error_code: null }, "отказ старой порции не трогает новое построение");
  await build(second.version);
  // Документ, загруженный, пока индексировать было некуда, оставался
  // «ждёт индексации» и после построения версии. Полная проверка при
  // активации доказывает, что его векторы в Qdrant есть, — она и закрывает
  // статус. Материал без коллекции проверку не проходит и готовым не становится.
  const indexState = async (id) => (await admin(async () => await pool.query(
    "SELECT index_status, indexed_version FROM knowledge_documents WHERE id=$1 AND user_id IS NULL", [id]))).rows[0];
  await admin(async () => await pool.query(
    "UPDATE knowledge_documents SET index_status='pending', indexed_version=NULL WHERE id=$1 AND user_id IS NULL", [uploaded.id]));
  // Новая версия, чья прежняя ещё жива: прежнюю снимает задание индексации
  // новой, поэтому активация ставит его, а не объявляет замену готовой.
  const replacement = randomUUID(); ownDocuments.push(replacement);
  await admin(async () => await pool.query(
    "INSERT INTO knowledge_documents(id,user_id,product_verified,collection_id,name,mime,content_hash,status,chunk_count,replaces_document_id,source) VALUES($1,NULL,true,$2,'Саморегуляция v2.md','text/markdown','ci-replacement','ready',0,$3,'admin')",
    [replacement, collection.id, uploaded.id]));
  const switched = await Promise.allSettled([
    admin(async () => await documents.activate(second.version, { expected_active_version: first.version })),
    admin(async () => await documents.activate(second.version, { expected_active_version: first.version })),
  ]);
  assert.equal(switched.filter((r) => r.status === "fulfilled").length, 1, "переключение сериализуется в PostgreSQL");
  assert.equal(switched.filter((r) => r.status === "rejected").length, 1, "устаревшее действие не проходит");
  assert.deepEqual(await store.activeVersions(), { private: second.version, global: second.version });
  assert.deepEqual(await indexState(uploaded.id), { index_status: "ready", indexed_version: second.version }, "активация закрывает «ждёт индексации»");
  assert.equal((await indexState(unscoped)).index_status, "pending", "непроверенный материал не объявлен проиндексированным");
  assert.equal((await indexState(replacement)).index_status, "pending", "замена с живой прежней версией не объявлена готовой");
  assert.equal((await job("knowledge_index", replacement)).envelope.payload.reason.startsWith(`activate-${second.version}-`), true,
    "замену доводит её задание индексации");
  await admin(async () => await pool.query("DELETE FROM knowledge_documents WHERE id=$1 AND user_id IS NULL", [replacement]));
  // Прежний режим поиска отдаёт признак общей базы: по нему модель
  // получает фрагмент без названия документа.
  const legacy = await legacyCandidates(db, { userId: ownUsers[0], privateEnabled: true, globalEnabled: true }, "Прокрастинация", 10, null);
  assert.ok(legacy.some((row) => row.document_id === uploaded.id && row.global === true), "legacy помечает фрагмент общей базы");
  // «Удалить» у неудавшейся загрузки: запись и исходный файл; разобранную
  // загрузку так не удалить — она уходит вместе со своим документом.
  const doomed = await admin(async () => await documents.upload({ collectionId: collection.id, name: "Неудачная загрузка.txt", mime: "text/plain",
    stream: Readable.from([Buffer.from("Загрузка, которая не разобралась")]) }));
  ownDocuments.push(doomed.id);
  await admin(async () => await pool.query("UPDATE knowledge_uploads SET status='failed', error_code='document_antivirus_unavailable' WHERE id=$1 AND user_id IS NULL", [doomed.id]));
  await assert.rejects(() => admin(async () => await documents.deleteUpload(uploaded.id)), /неудавшуюся или отменённую/u);
  assert.deepEqual(await admin(async () => await documents.deleteUpload(doomed.id)), { deleted: doomed.id });
  assert.equal((await admin(async () => await pool.query("SELECT 1 FROM knowledge_uploads WHERE id=$1 AND user_id IS NULL", [doomed.id]))).rows.length, 0);
  await assert.rejects(() => stat(join(root, "global", doomed.id)), { code: "ENOENT" }, "исходный файл удалён");
  assert.equal((await pool.query("SELECT status FROM knowledge_embedding_versions WHERE version=$1", [first.version])).rows[0].status, "retired");
  assert.equal((await search.search(ownUsers[0], question)).degraded, false, "новая модель видна сразу при другой размерности");
  await admin(async () => await documents.activate(first.version, { expected_active_version: second.version }));
  assert.deepEqual(await store.activeVersions(), { private: first.version, global: first.version });

  const { private: privateInfo, global: globalInfo } = await store.describe(first.version);
  assert.equal(privateInfo.size, 8); assert.equal(globalInfo.size, 8);
  let releaseWriter;
  let writerEntered;
  const released = new Promise((resolve) => { releaseWriter = resolve; });
  const entered = new Promise((resolve) => { writerEntered = resolve; });
  const writer = withKnowledgeIndexWrite(db, async () => { writerEntered(); await released; });
  await entered;
  try {
    await assert.rejects(() => admin(async () => await documents.activate(first.version, { verify_only: true })),
      (error) => error.statusCode === 409 && error.details?.code === "knowledge_activation_busy");
    assert.deepEqual(await store.activeVersions(), { private: first.version, global: first.version });
  } finally { releaseWriter(); await writer; }
  await admin(async () => await documents.activate(first.version, { verify_only: true }));
  // Приостанавливается только service-контейнер изолированной CI-job.
  // Запрос идёт настоящим клиентом и получает реальный network timeout.
  await docker("docker", ["pause", qdrantContainer], { timeout: 20_000 });
  try {
    const unavailable = await tool.execute({ query }, { userId: ownUsers[0] });
    assert.equal(unavailable.degraded, true);
    assert.ok(unavailable.results.some((hit) => hit.content.includes("маленький первый шаг")));
  } finally {
    await docker("docker", ["unpause", qdrantContainer], { timeout: 20_000 });
  }
  assert.equal((await search.search(ownUsers[0], question)).degraded, false, "после восстановления Qdrant снова используется");
  // Удаляем производную коллекцию активной версии, PostgreSQL цел.
  // Это реальный отказ Qdrant, а не заранее подставленный degraded.
  await qdrant.deleteCollection(`eva_knowledge_global_v${first.version}`);
  const fallback = await tool.execute({ query }, { userId: ownUsers[0] });
  assert.equal(fallback.degraded, true);
  assert.ok(fallback.results.some((hit) => hit.content.includes("маленький первый шаг")));
  console.log("PASS: registry/probe/persist/build/outbox/first activation/K7/rollback/upload setting persistence/live admission/semantic tool/citations/tenant hydration/disabled collection/paused Qdrant fallback/recovery/missing collection fallback");
  console.log("Embedding upstream and AV are fixtures; autonomous Letta tool choice and final prose require the documented live canary.");
} finally {
  if (originalUploadSetting) await setUploads(originalUploadSetting.value_json);
  else await pool.query("DELETE FROM system_settings WHERE key=$1", [uploadSettingKey]);
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
