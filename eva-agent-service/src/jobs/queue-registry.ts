/**
 * Единый реестр очередей.
 *
 * Очередь в BullMQ заводится вызовом конструктора, и ничто в библиотеке
 * не мешает завести её где угодно и как угодно назвать. Через год это
 * означает десяток очередей с похожими именами, из которых половину
 * никто не читает. Поэтому физическая очередь создаётся только здесь и
 * только под именем логического класса.
 *
 * Классов шесть, они закрыты: memory, research, proactive, recovery,
 * evaluation, maintenance. Имена `telegram-ingress` и `agent-runs`
 * запрещены отдельно и явно — durable ingress и ходы агента остаются в
 * PostgreSQL (инварианты 7 и 8), и попытка завести под них очередь
 * должна падать при первом же вызове, а не обнаруживаться на ревью.
 *
 * Ключи живут под общим префиксом `evaself:bullmq`, чтобы очереди
 * делили тот же Valkey с блокировками, лимитами и кэшем, не пересекаясь
 * с ними по именам ключей. Второй Redis не разворачивается.
 */

import type { Logger } from "../logger.js";

export const JOB_QUEUES = [
  "memory",
  "research",
  "proactive",
  "recovery",
  "evaluation",
  "maintenance",
] as const;

export type JobQueueName = (typeof JOB_QUEUES)[number];

/**
 * Имена, которые нельзя завести никогда. Не «не входят в список», а
 * именно запрещены: за каждым стоит инвариант, и отказ должен называть
 * причину, а не «неизвестная очередь».
 */
export const FORBIDDEN_QUEUE_NAMES: ReadonlyMap<string, string> = new Map([
  ["telegram-ingress", "durable ingress Telegram остаётся в PostgreSQL (инвариант 7)"],
  ["telegram_ingress", "durable ingress Telegram остаётся в PostgreSQL (инвариант 7)"],
  ["telegram-outbox", "доставка остаётся в PostgreSQL (инвариант 7)"],
  ["agent-runs", "ход агента не является фоновой задачей (инварианты 7, 8)"],
  ["agent_runs", "ход агента не является фоновой задачей (инварианты 7, 8)"],
  ["turns", "ход агента не является фоновой задачей (инварианты 7, 8)"],
]);

/** Общий префикс ключей в Valkey. Второй Redis не разворачивается. */
export const JOB_KEY_PREFIX = "evaself:bullmq";

export function isJobQueueName(value: string): value is JobQueueName {
  return (JOB_QUEUES as readonly string[]).includes(value);
}

export class JobRegistryError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "JobRegistryError";
  }
}

/** Как задание ставится в очередь. Подмножество опций BullMQ, которым мы пользуемся. */
export interface JobAddOptions {
  /** Идентификатор задания. Совпадение означает «то же самое задание». */
  jobId: string;
  delayMs?: number;
  attempts?: number;
  backoffMs?: number;
  /** Удалить более раннее ожидающее задание с тем же ключом (debounce, keep-last). */
  replacePending?: boolean;
}

export interface JobAddResult {
  jobId: string;
  /** Задание с таким идентификатором уже было: второй эффект не создан. */
  duplicate: boolean;
}

export interface JobSchedulerSpec {
  cron: string;
  timezone: string;
  jobType: string;
  data: unknown;
}

export interface JobSchedulerState {
  key: string;
  cron: string | null;
  timezone: string | null;
}

/**
 * Драйвер очереди. Реализация поверх BullMQ живёт в `bullmq-driver.ts`;
 * тесты подставляют свою и потому не требуют ни Valkey, ни BullMQ.
 */
export interface JobQueueHandle {
  readonly name: JobQueueName;
  add(jobType: string, data: unknown, options: JobAddOptions): Promise<JobAddResult>;
  upsertScheduler(key: string, spec: JobSchedulerSpec): Promise<void>;
  listSchedulers(): Promise<JobSchedulerState[]>;
  removeScheduler(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface JobQueueDriver {
  open(name: JobQueueName, prefix: string): JobQueueHandle;
}

export class QueueRegistry {
  private readonly queues = new Map<JobQueueName, JobQueueHandle>();
  private closed = false;

  constructor(
    private readonly driver: JobQueueDriver,
    private readonly logger: Logger,
    private readonly prefix: string = JOB_KEY_PREFIX,
  ) {}

  /**
   * Получить очередь класса. Повторный вызов возвращает ту же:
   * физическая очередь на класс ровно одна, сколько бы её ни просили.
   */
  queue(name: string): JobQueueHandle {
    if (this.closed) throw new JobRegistryError("job_registry_closed", name);
    const forbidden = FORBIDDEN_QUEUE_NAMES.get(name);
    if (forbidden) throw new JobRegistryError("job_queue_forbidden", `${name} — ${forbidden}`);
    if (!isJobQueueName(name)) {
      throw new JobRegistryError(
        "job_queue_unknown",
        `${name}; допустимы: ${JOB_QUEUES.join(", ")}`,
      );
    }
    const existing = this.queues.get(name);
    if (existing) return existing;
    const handle = this.driver.open(name, this.prefix);
    this.queues.set(name, handle);
    this.logger.debug("Очередь заданий открыта", { queue: name, prefix: this.prefix });
    return handle;
  }

  /** Уже открытые очереди. Реестр не открывает их заранее — только по требованию. */
  get openQueues(): JobQueueName[] {
    return [...this.queues.keys()];
  }

  /**
   * Закрыть все очереди. Отдельные отказы не мешают остальным: при
   * остановке важно закрыть максимум соединений, а не первое из них.
   */
  async close(): Promise<void> {
    this.closed = true;
    const closing = [...this.queues.values()].map(async (handle) => {
      try {
        await handle.close();
      } catch (error) {
        this.logger.warn("Очередь заданий не закрылась", {
          queue: handle.name,
          code: error instanceof Error ? error.name : "unknown_error",
        });
      }
    });
    await Promise.all(closing);
    this.queues.clear();
  }
}
