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
