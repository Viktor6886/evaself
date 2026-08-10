/**
 * Сборка слоя фоновых заданий.
 *
 * Одна точка входа: сервис получает собранный слой или не получает
 * ничего. Промежуточного состояния «реестр есть, журнала нет» не
 * существует — оно означало бы задания без канонической записи.
 *
 * Флаг выключен — слой не собирается вовсе. Намерения при этом всё равно
 * можно записывать в `job_outbox`: запись идёт в PostgreSQL, ничего не
 * знает про Valkey и после включения флага будет опубликована. Это же
 * свойство отвечает на требование 10 шага: недоступный Valkey задерживает
 * публикацию, но не превращает вебхук в синхронного исполнителя.
 */

import type { Redis } from "ioredis";

import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { BullMqJobDriver } from "./bullmq-driver.js";
import { JobOutbox } from "./job-outbox.js";
import { JobRunJournal } from "./job-runs.js";
import { QueueRegistry } from "./queue-registry.js";
import { JobRuntime } from "./runtime.js";
import { JobScheduleRegistry } from "./schedules.js";

export interface JobLayer {
  registry: QueueRegistry;
  outbox: JobOutbox;
  runs: JobRunJournal;
  runtime: JobRuntime;
  schedules: JobScheduleRegistry;
  /** Сверка расписаний и запуск публикатора. */
  start(): Promise<void>;
  /** Остановка без `process.exit`: сначала drain, потом закрытие соединений. */
  stop(drainMs: number): Promise<void>;
}

export function buildJobLayer(
  config: Config,
  db: Database,
  redis: Redis,
  logger: Logger,
): JobLayer {
  const driver = new BullMqJobDriver(redis);
  const registry = new QueueRegistry(driver, logger);
  const runs = new JobRunJournal(db, logger);
  const runtime = new JobRuntime(db, registry, runs, logger);
  const schedules = new JobScheduleRegistry(db, registry, logger);
  const outbox = new JobOutbox(db, registry, logger, {
    batchSize: config.jobOutboxBatchSize,
    pollMs: config.jobOutboxPollMs,
  });

  return {
    registry,
    outbox,
    runs,
    runtime,
    schedules,
    async start(): Promise<void> {
      // Сверка идёт до публикатора: расписание, потерянное вместе с
      // томом Valkey, должно вернуться раньше, чем слой начнёт работу.
      const summary = await schedules.reconcile();
      logger.info("Расписания заданий сверены", { ...summary });
      outbox.start();
    },
    async stop(drainMs: number): Promise<void> {
      outbox.stop();
      // `runtime.stop` закрывает очереди реестра сам; соединения
      // драйвера отпускаются после него, чтобы закрытие очередей успело
      // отправить свои команды.
      await runtime.stop(drainMs);
      driver.disconnect();
    },
  };
}

export { JobOutbox, JobRunJournal, JobRuntime, JobScheduleRegistry, QueueRegistry };
