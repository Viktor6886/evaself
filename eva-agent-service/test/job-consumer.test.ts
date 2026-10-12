/**
 * Потребитель очередей BullMQ.
 *
 * Без него задания, поставленные публикатором, лежали в Valkey вечно:
 * OSINT-исследование оставалось «в очереди» навсегда. Здесь — перевод
 * исхода `JobRuntime` на язык BullMQ и жизненный цикл потребителя в
 * реестре.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { JobRetryError, jobProcessor } from "../dist/jobs/consumer.js";
import { bullJobId } from "../dist/jobs/bullmq-driver.js";
import { QueueRegistry } from "../dist/jobs/queue-registry.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("processor: повторяемый отказ — бросок, остальное закрывает задание", async () => {
  const attempts: number[] = [];
  const outcomes = [
    { status: "succeeded", runId: "r1" },
    { status: "failed", runId: "r2", code: "job_timeout", failureClass: "transient", retry: true },
    { status: "failed", runId: "r3", code: "job_handler_missing", failureClass: "permanent", retry: false },
    { status: "cancelled", runId: "r4", reason: "lease_lost" },
  ];
  const processor = jobProcessor({
    execute: async (_data: unknown, attempt?: number) => {
      attempts.push(attempt ?? 0);
      return outcomes.shift() as never;
    },
  });
  await processor({}, 0);
  await assert.rejects(processor({}, 1), (error: unknown) =>
    error instanceof JobRetryError && error.code === "job_timeout");
  await processor({}, 2);
  await processor({}, 0);
  // Номер попытки — израсходованные попытки плюс текущая.
  assert.deepEqual(attempts, [1, 2, 3, 1]);
});

test("processor: отказ до обработчика обновляет бизнес-статус; ошибка записи повторяется", async () => {
  const data = { upload: "id" };
  const outcomes = [
    { status: "failed", runId: null, code: "job_deadline_exceeded", failureClass: "permanent", retry: false },
    { status: "failed", runId: "ran", code: "Error", failureClass: "transient", retry: false },
    { status: "failed", runId: null, code: "job_runtime_stopping", failureClass: "transient", retry: true },
  ];
  const rejected: unknown[] = [];
  const processor = jobProcessor({ execute: async () => outcomes.shift() as never }, async (value, code) => {
    rejected.push({ value, code });
  });
  await processor(data, 0);
  await processor(data, 4);
  await assert.rejects(processor(data, 0), JobRetryError);
  assert.deepEqual(rejected, [{ value: data, code: "job_deadline_exceeded" }]);

  let writes = 0;
  const retry = jobProcessor({ execute: async () => ({ status: "failed", runId: null,
    code: "job_deadline_exceeded", failureClass: "permanent", retry: false }) }, async () => {
    if (++writes === 1) throw new Error("database unavailable");
  });
  await assert.rejects(retry(data, 0), /database unavailable/u);
  await retry(data, 1);
  assert.equal(writes, 2);
});

/**
 * BullMQ отклоняет jobId с двоеточием, если частей не ровно три. Повтор
 * загрузки, индексация, перестройка и сверка базы знаний несут двоеточие
 * в различителе и не публиковались ни разу (проверка на настоящем
 * BullMQ — scripts/ci/test-bullmq-job-ids.mjs).
 */
test("jobId BullMQ: принятые ключи не меняются, остальные — без двоеточий и обратимо", () => {
  const upload = "0b0e5a62-3d2f-4f7c-9a55-6a9e3a1f0c11";
  for (const kept of [`knowledge_ingest:system:${upload}`, `research_run:u42:${upload}`, "plain-key"]) {
    assert.equal(bullJobId(kept), kept, "задание, уже стоящее в очереди, не задваивается");
  }
  for (const key of [
    `knowledge_ingest:system:${upload}:retry-1759686000000`,
    `knowledge_index:u42:${upload}:ingest`,
    "knowledge_rebuild:system:v2:1759686000000:start",
    "knowledge_reconcile:system:manual:1759686000000",
    "a:b",
  ]) {
    const id = bullJobId(key);
    assert.ok(!id.includes(":"), id);
    assert.equal(decodeURIComponent(id), key);
    assert.equal(bullJobId(key), id, "один ключ — один id при каждой публикации");
  }
  // «%» кодируется всегда: ключ с ним не совпадёт с закодированным другим.
  assert.notEqual(bullJobId("a:b:c%3Ad"), bullJobId("a:b:c:d"));
  assert.notEqual(bullJobId("a%3Ab"), bullJobId("a:b"));
  assert.equal(decodeURIComponent(bullJobId("a:b:c%3Ad")), "a:b:c%3Ad");
});

function fakeDriver(withConsumer: boolean) {
  const events: string[] = [];
  const driver = {
    events,
    open(name: string) {
      return {
        name,
        async add() { return { jobId: "x", duplicate: false }; },
        async upsertScheduler() {},
        async listSchedulers() { return []; },
        async removeScheduler() { return false; },
        async close() { events.push(`queue.close:${name}`); },
      };
    },
    ...(withConsumer ? {
      consume(name: string, prefix: string, _processor: unknown, options: { concurrency: number }) {
        events.push(`consume:${name}:${prefix}:${options.concurrency}`);
        return {
          name,
          async pause() { events.push(`pause:${name}`); },
          async close() { events.push(`consumer.close:${name}`); },
        };
      },
    } : {}),
  };
  return driver;
}

test("реестр: один потребитель на класс, пауза и закрытие раньше очередей", async () => {
  const driver = fakeDriver(true);
  const registry = new QueueRegistry(driver as never, logger as never);
  const processor = async () => {};
  const first = registry.consume("research", processor, 2);
  const again = registry.consume("research", processor, 5);
  assert.ok(first && first === again, "повторный вызов возвращает того же потребителя");
  assert.deepEqual(registry.consumedQueues, ["research"]);
  assert.throws(() => registry.consume("agent-runs", processor, 1), /job_queue_forbidden/);
  await registry.pauseConsumers();
  await registry.close();
  assert.deepEqual(driver.events, [
    "consume:research:evaself:bullmq:2",
    "pause:research",
    "consumer.close:research",
    "queue.close:research",
  ]);
});

test("реестр: драйвер без потребителя — очередь есть, потребителя нет", () => {
  const registry = new QueueRegistry(fakeDriver(false) as never, logger as never);
  assert.equal(registry.consume("research", async () => {}, 1), null);
  assert.deepEqual(registry.openQueues, ["research"]);
});

/**
 * Обработчик без потребителя — задание, которое никто не заберёт. Так
 * было с OSINT (#371), и так же оставались `queued` загрузки в базу
 * знаний: публикатор ставил их в очередь `memory`, а слушала сервис одна
 * `research`.
 */
async function layerConsumers(flags: Record<string, boolean>, initiative = false) {
  const { buildJobLayer } = await import("../dist/jobs/index.js");
  const driver = fakeDriver(true);
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    withSystemScope: async (_label: string, run: () => Promise<unknown>) => await run(),
    withUserScope: async (_scope: unknown, run: () => Promise<unknown>) => await run(),
    transaction: async (run: (client: unknown) => Promise<unknown>) => await run({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const config = {
    jobOutboxBatchSize: 10, jobOutboxPollMs: 60_000, routerUrl: "http://router.invalid", routerApiKey: "",
    searxngUrl: "http://searx.invalid", crawl4aiUrl: "http://crawl.invalid", crawl4aiToken: "", osintWorkerUrl: "http://osint.invalid", osintWorkerToken: "",
    osintHarvesterUrl: "http://harvester.invalid", osintSpiderfootUrl: "http://spiderfoot.invalid", osintEnabled: false, retentionEnforcementEnabled: false,
    jobsMirrorMode: false, checkinMorningHour: 9, checkinEveningHour: 21,
    knowledgeUploadsEnabled: false, researchOrchestratorEnabled: false,
    bullmqMaintenanceEnabled: false, bullmqProactiveEnabled: false,
    ...flags,
  };
  const layer = buildJobLayer(config as never, db as never, {} as never, logger as never, {
    letta: {} as never, purposes: {} as never, runtimeContext: {} as never, lock: {} as never, outbox: {} as never,
    driver: driver as never,
    ...(initiative ? { initiative: { tick: async () => undefined } } : {}),
  });
  await layer.start();
  await layer.stop(0);
  return driver.events.filter((event) => event.startsWith("consume:")).sort();
}

test("слой заданий: у каждой очереди с обработчиками есть потребитель", async () => {
  // Удаление, переиндексация и сверка базы знаний ставятся и при
  // выключенных загрузках — их очередь потребляется всегда.
  assert.deepEqual(await layerConsumers({}), [
    "consume:memory:evaself:bullmq:1",
    "consume:research:evaself:bullmq:2",
  ], "OSINT и обслуживание базы знаний регистрируются всегда");
  assert.deepEqual(await layerConsumers({
    knowledgeUploadsEnabled: true, bullmqMaintenanceEnabled: true, bullmqProactiveEnabled: true,
  }, true), [
    "consume:maintenance:evaself:bullmq:1",
    "consume:memory:evaself:bullmq:1",
    // Четыре вида инициативы плюс окно — каждому своё место.
    "consume:proactive:evaself:bullmq:5",
    "consume:research:evaself:bullmq:2",
  ]);
  // Ступень зеркала: окно инициативы не регистрируется, и места ему нет.
  assert.ok((await layerConsumers({ bullmqProactiveEnabled: true, jobsMirrorMode: true }, true))
    .includes("consume:proactive:evaself:bullmq:4"));
});

/**
 * Задание базы знаний, не дошедшее до обработчика, не оставляет запись
 * «в очереди» или «строится» до перезапуска: загрузка и построение версии
 * получают код отказа и кнопку повтора. Два пути: публикатор признал
 * строку мёртвой, или срок истёк, пока задание ждало в очереди.
 */
test("слой заданий: не дошедшие до обработчика задания базы знаний закрывают свои записи", async () => {
  const { buildJobLayer } = await import("../dist/jobs/index.js");
  const { buildJobEnvelope } = await import("../dist/jobs/envelope.js");
  const { recordKnowledgeIngest } = await import("../dist/knowledge/lifecycle.js");
  const { scheduleKnowledgeRebuild } = await import("../dist/knowledge/maintenance.js");
  const intents: Array<Record<string, unknown>> = [];
  const stub = { record: async (_client: unknown, intent: Record<string, unknown>) => { intents.push(intent); return { idempotencyKey: "", duplicate: false }; } };
  const upload = "0b0e5a62-3d2f-4f7c-9a55-6a9e3a1f0c11";
  await recordKnowledgeIngest(stub as never, null as never, { uploadId: upload, userId: null, attempt: "retry-1" });
  await scheduleKnowledgeRebuild(stub as never, null as never, { version: 3, started: 1759686000000, full: true, after: null });
  const [ingest, rebuild] = intents.map((intent) => buildJobEnvelope(intent as never));
  const research = buildJobEnvelope({ type: "research_run", queue: "research", userId: 42, traceId: "t", idempotencyKey: "research_run:u42:r1", deadlineMs: 60_000 });
  const row = (envelope: typeof ingest, id: string) => ({ id, idempotency_key: envelope!.idempotencyKey, queue: envelope!.queue,
    job_type: envelope!.type, schema_version: envelope!.schemaVersion, user_id: envelope!.userId, envelope, dedup_key: null, attempts: 8 });
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  let claimed = false;
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (/SET status = 'publishing'/u.test(sql)) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return { rows: [row(ingest, "row-1"), row(rebuild, "row-2"), row(research, "row-3")], rowCount: 3 };
      }
      if (/^\s*UPDATE knowledge_(uploads|embedding_versions)/u.test(sql) && !/FROM \(/u.test(sql)) writes.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    withSystemScope: async (_label: string, run: () => Promise<unknown>) => await run(),
    withUserScope: async (_scope: unknown, run: () => Promise<unknown>) => await run(),
    transaction: async (run: (client: unknown) => Promise<unknown>) => await run({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const driver = fakeDriver(true);
  const open = driver.open.bind(driver);
  // Так BullMQ отвечал на ключ с двоеточием в различителе: восемь попыток — и dead.
  driver.open = (queue: string) => ({ ...open(queue), async add() { throw new Error("Custom Id cannot contain :"); } }) as never;
  let processor: ((data: unknown, attemptsMade: number) => Promise<void>) | null = null;
  const consume = driver.consume.bind(driver);
  driver.consume = (name: string, prefix: string, run: unknown, options: { concurrency: number }) => {
    if (name === "memory") processor = run as never;
    return consume(name, prefix, run, options);
  };
  const config = {
    jobOutboxBatchSize: 10, jobOutboxPollMs: 60_000, routerUrl: "http://router.invalid", routerApiKey: "",
    searxngUrl: "http://searx.invalid", crawl4aiUrl: "http://crawl.invalid", crawl4aiToken: "", osintWorkerUrl: "http://osint.invalid", osintWorkerToken: "",
    osintHarvesterUrl: "http://harvester.invalid", osintSpiderfootUrl: "http://spiderfoot.invalid", osintEnabled: false, retentionEnforcementEnabled: false,
    jobsMirrorMode: false, checkinMorningHour: 9, checkinEveningHour: 21, knowledgeUploadsEnabled: true, researchOrchestratorEnabled: false,
    bullmqMaintenanceEnabled: false, bullmqProactiveEnabled: false,
  };
  const layer = buildJobLayer(config as never, db as never, {} as never, logger as never, {
    letta: {} as never, purposes: {} as never, runtimeContext: {} as never, lock: {} as never, outbox: {} as never, driver: driver as never,
  });
  const summary = await layer.outbox.publishPending();
  assert.equal(summary.dead, 3);
  assert.equal(writes.length, 2, "исследование записей базы знаний не касается");
  assert.match(writes[0]!.sql, /UPDATE knowledge_uploads u/u);
  assert.deepEqual(writes[0]!.values, [upload, null, ingest!.idempotencyKey, "job_publish_failed", "knowledge_ingest"]);
  assert.match(writes[1]!.sql, /UPDATE knowledge_embedding_versions/u);
  assert.deepEqual(writes[1]!.values, [3, 1759686000000, "job_publish_failed"]);

  // Порция перестройки, просроченная в очереди, до обработчика не доходит.
  writes.length = 0;
  await layer.start();
  try {
    assert.ok(processor, "очередь memory потребляется");
    await processor!({ ...rebuild, deadlineAt: new Date(Date.now() - 1_000).toISOString() }, 0);
    assert.deepEqual(writes.map((write) => write.values), [[3, 1759686000000, "job_deadline_exceeded"]]);
  } finally {
    await layer.stop(0);
  }
});

/**
 * Восстановление при старте — по возможности и по отдельности: отказ
 * восстановления загрузок не отменяет восстановление построений и не
 * оставляет процесс без потребителей очередей.
 */
test("слой заданий: отказ одного восстановления не отменяет второе и запуск потребителей", async () => {
  const { buildJobLayer } = await import("../dist/jobs/index.js");
  const driver = fakeDriver(true);
  const recovered: string[] = [];
  const db = {
    query: async (sql: string) => {
      if (/UPDATE knowledge_uploads u/u.test(sql) && /FROM \(/u.test(sql)) throw new Error("database unavailable");
      if (/UPDATE knowledge_embedding_versions v/u.test(sql)) recovered.push("builds");
      return { rows: [], rowCount: 0 };
    },
    withSystemScope: async (_label: string, run: () => Promise<unknown>) => await run(),
    withUserScope: async (_scope: unknown, run: () => Promise<unknown>) => await run(),
    transaction: async (run: (client: unknown) => Promise<unknown>) => await run({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const warnings: string[] = [];
  const layer = buildJobLayer({
    jobOutboxBatchSize: 10, jobOutboxPollMs: 60_000, routerUrl: "http://router.invalid", routerApiKey: "",
    searxngUrl: "http://searx.invalid", crawl4aiUrl: "http://crawl.invalid", crawl4aiToken: "", osintWorkerUrl: "http://osint.invalid", osintWorkerToken: "",
    osintHarvesterUrl: "http://harvester.invalid", osintSpiderfootUrl: "http://spiderfoot.invalid", osintEnabled: false, retentionEnforcementEnabled: false,
    jobsMirrorMode: false, checkinMorningHour: 9, checkinEveningHour: 21, knowledgeUploadsEnabled: true, researchOrchestratorEnabled: false,
    bullmqMaintenanceEnabled: false, bullmqProactiveEnabled: false,
  } as never, db as never, {} as never, { ...logger, warn: (message: string) => { warnings.push(message); } } as never, {
    letta: {} as never, purposes: {} as never, runtimeContext: {} as never, lock: {} as never, outbox: {} as never, driver: driver as never,
  });
  await layer.start();
  await layer.stop(0);
  assert.deepEqual(recovered, ["builds"], "построения восстанавливаются и после отказа загрузок");
  assert.ok(warnings.includes("Восстановление заданий базы знаний не выполнено"));
  assert.ok(driver.events.includes("consume:memory:evaself:bullmq:1"), "потребители запущены");
});
