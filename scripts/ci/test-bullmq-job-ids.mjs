/**
 * Каждый ключ, который публикует job outbox, принимает настоящий BullMQ.
 *
 * Unit-тесты подменяют очередь драйвером в памяти, а он принимает любой
 * jobId. BullMQ отклоняет jobId с двоеточием, если частей не ровно три,
 * поэтому повтор загрузки, индексация, перестройка и сверка базы знаний
 * не публиковались ни разу, а тесты оставались зелёными. Ключи здесь
 * строят те же функции, что и в приложении.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Redis } from "../../eva-agent-service/node_modules/ioredis/built/index.js";

import { BullMqJobDriver } from "../../eva-agent-service/dist/jobs/bullmq-driver.js";
import { buildJobEnvelope } from "../../eva-agent-service/dist/jobs/envelope.js";
import { jobIdempotencyKey } from "../../eva-agent-service/dist/jobs/job-outbox.js";
import { knowledgeIndexScheduler } from "../../eva-agent-service/dist/knowledge/indexer.js";
import { recordKnowledgeIngest } from "../../eva-agent-service/dist/knowledge/lifecycle.js";
import { scheduleKnowledgeRebuild, scheduleKnowledgeReconcile } from "../../eva-agent-service/dist/knowledge/maintenance.js";

// База 15 занята проверкой лимитов; эта проверка чистит свою.
const redis = new Redis(process.env.VALKEY_BULLMQ_TEST_URL ?? "redis://127.0.0.1:6379/14", {
  maxRetriesPerRequest: null,
});
const driver = new BullMqJobDriver(redis);
const prefix = `ci-bullmq-${process.pid}`;

const intents = [];
const outbox = { record: async (_client, intent) => { intents.push(intent); return { idempotencyKey: intent.idempotencyKey, duplicate: false }; } };
const upload = randomUUID();
const document = randomUUID();
const now = Date.now();
await recordKnowledgeIngest(outbox, null, { uploadId: upload, userId: null });
await recordKnowledgeIngest(outbox, null, { uploadId: upload, userId: null, attempt: `retry-${now}` });
await recordKnowledgeIngest(outbox, null, { uploadId: randomUUID(), userId: 42 });
const index = knowledgeIndexScheduler(outbox, () => true);
await index.schedule(null, { documentId: document, userId: null, reason: "ingest" });
await index.schedule(null, { documentId: document, userId: 42, reason: `reindex-${now}` });
await scheduleKnowledgeRebuild(outbox, null, { version: 2, started: now, full: true, after: null });
await scheduleKnowledgeRebuild(outbox, null, { version: 2, started: now, full: false, after: document });
await scheduleKnowledgeReconcile(outbox, null, now);
const envelopes = [
  ...intents.map((intent) => buildJobEnvelope(intent)),
  // Трёхчастный ключ: BullMQ принимал его и до исправления, id не меняется.
  buildJobEnvelope({
    type: "research_run", queue: "research", userId: 42, traceId: document,
    idempotencyKey: jobIdempotencyKey({ type: "research_run", userId: 42, discriminator: document }),
    payloadRef: document, payload: { request_id: document }, deadlineMs: 60_000,
  }),
];
assert.ok(envelopes.some((envelope) => envelope.idempotencyKey.split(":").length > 3), "есть ключи с двоеточием в различителе");

const handles = [];
const consumers = [];
const errors = [];
try {
  await redis.flushdb();
  const received = new Map();
  for (const queue of new Set(envelopes.map((envelope) => envelope.queue))) {
    const handle = driver.open(queue, prefix);
    handles.push(handle);
    for (const envelope of envelopes.filter((item) => item.queue === queue)) {
      const options = { jobId: envelope.idempotencyKey, attempts: 1 };
      assert.deepEqual(await handle.add(envelope.type, envelope, options), { jobId: envelope.idempotencyKey, duplicate: false }, envelope.idempotencyKey);
      // Повторная публикация той же строки outbox второго задания не создаёт.
      assert.deepEqual(await handle.add(envelope.type, envelope, options), { jobId: envelope.idempotencyKey, duplicate: true }, envelope.idempotencyKey);
    }
    consumers.push(driver.consume(queue, prefix, async (data) => {
      received.set(data.idempotencyKey, data);
    }, { concurrency: 1, onError: (error) => { errors.push(error); } }));
  }

  const deadline = Date.now() + 20_000;
  while (received.size < envelopes.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(errors, [], "потребитель работает без ошибок соединения");
  assert.deepEqual([...received.keys()].sort(), envelopes.map((envelope) => envelope.idempotencyKey).sort(), "каждое задание дошло до потребителя");
  for (const envelope of envelopes) assert.deepEqual(received.get(envelope.idempotencyKey), envelope, "конверт доезжает без изменений");
  process.stdout.write(`bullmq job ids: ${envelopes.length} production keys published, deduplicated and consumed\n`);
} finally {
  for (const consumer of consumers) await consumer.close();
  for (const handle of handles) await handle.close();
  await redis.flushdb().catch(() => undefined);
  driver.disconnect();
  await redis.quit();
}
