/**
 * Драйвер очередей поверх BullMQ.
 *
 * Единственное место сервиса, где импортируется `bullmq`. Всё остальное
 * работает с интерфейсом `JobQueueDriver`, поэтому тесты обходятся без
 * Valkey, а замена библиотеки не расходится по десяткам файлов.
 *
 * Соединение: BullMQ получает собственный дубль общего клиента Valkey
 * (`redis.duplicate()`), а не отдельный Redis. Причина в требовании
 * самой библиотеки — блокирующие команды воркера занимают соединение
 * целиком, и делить его с лимитами роутера и блокировками ходов нельзя.
 * Сервер при этом остаётся тот же: второй Redis не разворачивается.
 *
 * `maxRetriesPerRequest: null` — требование BullMQ: команда, брошенная
 * после трёх попыток, для очереди означает потерянное задание, а не
 * ошибку вызова.
 */

import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

import type {
  JobAddOptions,
  JobAddResult,
  JobConsumerHandle,
  JobProcessor,
  JobQueueDriver,
  JobQueueHandle,
  JobQueueName,
  JobSchedulerSpec,
  JobSchedulerState,
} from "./queue-registry.js";

class BullQueueHandle implements JobQueueHandle {
  private readonly queue: Queue;

  constructor(readonly name: JobQueueName, connection: Redis, prefix: string) {
    this.queue = new Queue(name, { connection, prefix });
  }

  /**
   * Поставить задание.
   *
   * Идентификатор задания — ключ идемпотентности из конверта. BullMQ по
   * совпадающему `jobId` второе задание не создаёт, поэтому повторный
   * публикатор второго бизнес-эффекта не вызывает. Предварительная
   * проверка нужна только для честного ответа «это был повтор»: сам
   * факт недублирования обеспечивает не она, а BullMQ.
   */
  async add(jobType: string, data: unknown, options: JobAddOptions): Promise<JobAddResult> {
    const existing = await this.queue.getJob(options.jobId);
    if (existing) {
      if (!options.replacePending) return { jobId: options.jobId, duplicate: true };
      // debounce и keep-last-if-active: актуальнее последнее намерение,
      // и более раннее ожидающее задание снимается. Уже выполняющееся
      // задание снять нельзя — его отмена идёт через токен отмены в
      // журнале запусков, а не через удаление из очереди.
      const removed = await existing.remove({ removeChildren: false }).then(
        () => true,
        () => false,
      );
      if (!removed) return { jobId: options.jobId, duplicate: true };
    }
    await this.queue.add(jobType, data, {
      jobId: options.jobId,
      delay: options.delayMs,
      attempts: options.attempts,
      backoff: options.backoffMs
        ? { type: "exponential", delay: options.backoffMs }
        : undefined,
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 24 * 3_600 },
    });
    return { jobId: options.jobId, duplicate: false };
  }

  async upsertScheduler(key: string, spec: JobSchedulerSpec): Promise<void> {
    await this.queue.upsertJobScheduler(
      key,
      { pattern: spec.cron, tz: spec.timezone },
      { name: spec.jobType, data: spec.data },
    );
  }

  async listSchedulers(): Promise<JobSchedulerState[]> {
    const schedulers = await this.queue.getJobSchedulers();
    return schedulers.map((scheduler) => ({
      key: scheduler.key,
      cron: scheduler.pattern ?? null,
      timezone: scheduler.tz ?? null,
    }));
  }

  async removeScheduler(key: string): Promise<boolean> {
    return await this.queue.removeJobScheduler(key);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

class BullConsumerHandle implements JobConsumerHandle {
  private readonly worker: Worker;

  constructor(
    readonly name: JobQueueName,
    connection: Redis,
    prefix: string,
    processor: JobProcessor,
    options: { concurrency: number; onError: (error: unknown) => void },
  ) {
    this.worker = new Worker(
      name,
      async (job) => await processor(job.data, job.attemptsMade),
      { connection, prefix, concurrency: options.concurrency },
    );
    // Без слушателя `error` событие EventEmitter бросает и роняет процесс:
    // обрыв соединения с Valkey убивал бы весь сервис.
    this.worker.on("error", options.onError);
  }

  async pause(): Promise<void> {
    await this.worker.pause(true);
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}

export class BullMqJobDriver implements JobQueueDriver {
  private readonly connections: Redis[] = [];

  constructor(private readonly redis: Redis) {}

  open(name: JobQueueName, prefix: string): JobQueueHandle {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.connections.push(connection);
    return new BullQueueHandle(name, connection, prefix);
  }

  /**
   * Потребитель получает своё соединение: блокирующее ожидание задания
   * занимает его целиком (см. комментарий в начале файла).
   */
  consume(
    name: JobQueueName,
    prefix: string,
    processor: JobProcessor,
    options: { concurrency: number; onError: (error: unknown) => void },
  ): JobConsumerHandle {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.connections.push(connection);
    return new BullConsumerHandle(name, connection, prefix, processor, options);
  }

  /** Соединения закрываются после очередей: очередь закрывает свои команды сама. */
  disconnect(): void {
    for (const connection of this.connections) connection.disconnect();
    this.connections.length = 0;
  }
}
