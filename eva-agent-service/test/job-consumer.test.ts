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
