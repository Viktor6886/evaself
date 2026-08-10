/**
 * Повторяющиеся расписания.
 *
 * Инвариант 9: на одно назначение — один планировщик. BullMQ умеет
 * хранить расписание сам, но его копия живёт в Valkey, а Valkey — не
 * источник истины (инвариант 2). Потеря тома означала бы тихое
 * исчезновение периодических заданий: сервис работает, ничего не
 * падает, просто ночная работа больше не приходит. Поэтому каноническая
 * копия лежит в `job_schedules`, а в очереди она только отражается.
 *
 * Сверка при старте двусторонняя. Расписание, которого нет в очереди,
 * создаётся; расписание, которого нет в PostgreSQL, из очереди
 * убирается — иначе снятое расписание продолжало бы срабатывать из
 * прежнего состояния Valkey, и второй планировщик появился бы сам собой.
 */

import type { Logger } from "../logger.js";
import type { Database } from "../db.js";
import { type JobScalar, assertSafePayload } from "./envelope.js";
import type { DedupMode } from "./policy.js";
import { type JobQueueName, type QueueRegistry, isJobQueueName } from "./queue-registry.js";

export interface JobSchedule {
  code: string;
  queue: JobQueueName;
  jobType: string;
  schemaVersion: number;
  cron: string;
  timezone: string;
  dedupMode: DedupMode;
  payload: Record<string, JobScalar>;
  payloadRef: string | null;
}

export interface ReconcileSummary {
  /** Расписаний в PostgreSQL, включённых. */
  expected: number;
  /** Создано в очереди заново — их там не было. */
  restored: number;
  /** Обновлено: cron или зона отличались от канонических. */
  updated: number;
  /** Удалено из очереди: в PostgreSQL их нет. */
  removed: number;
  /** Пропущено: строка не прошла проверку и в очередь не попала. */
  rejected: number;
}

interface ScheduleRow {
  code: string;
  queue: string;
  job_type: string;
  schema_version: number;
  cron: string;
  timezone: string;
  dedup_mode: string;
  payload: unknown;
  payload_ref: string | null;
}

const DEDUP_MODES: ReadonlySet<string> = new Set([
  "simple",
  "throttle",
  "debounce",
  "keep_last_if_active",
]);

export class JobScheduleRegistry {
  constructor(
    private readonly db: Database,
    private readonly registry: QueueRegistry,
    private readonly logger: Logger,
  ) {}

  /** Включённые расписания из PostgreSQL. Это и есть канонический список. */
  async load(): Promise<JobSchedule[]> {
    const { rows } = await this.db.withSystemScope(
      "jobs.schedules.load",
      async () => await this.db.query<ScheduleRow>(
        `SELECT code, queue, job_type, schema_version, cron, timezone,
                dedup_mode, payload, payload_ref
           FROM job_schedules
          WHERE enabled = true
          ORDER BY code`,
      ),
    );
    const schedules: JobSchedule[] = [];
    for (const row of rows) {
      const schedule = this.parse(row);
      if (schedule) schedules.push(schedule);
    }
    return schedules;
  }

  /**
   * Строка расписания приходит из базы, куда её кладёт человек через
   * админку. Поэтому она проверяется так же строго, как конверт: чужая
   * очередь, незнакомый режим дедупликации или payload с текстом внутрь
   * очереди не попадают.
   */
  private parse(row: ScheduleRow): JobSchedule | null {
    if (!isJobQueueName(row.queue)) {
      this.logger.error("Расписание указывает неизвестную очередь", {
        code: row.code,
        queue: row.queue,
      });
      return null;
    }
    if (!DEDUP_MODES.has(row.dedup_mode)) {
      this.logger.error("Расписание указывает неизвестный режим дедупликации", {
        code: row.code,
        mode: row.dedup_mode,
      });
      return null;
    }
    const payload = (row.payload ?? {}) as Record<string, JobScalar>;
    try {
      assertSafePayload(payload);
    } catch (error) {
      this.logger.error("Payload расписания отклонён", {
        code: row.code,
        reason: error instanceof Error ? error.name : "unknown_error",
      });
      return null;
    }
    return {
      code: row.code,
      queue: row.queue,
      jobType: row.job_type,
      schemaVersion: row.schema_version,
      cron: row.cron,
      timezone: row.timezone,
      dedupMode: row.dedup_mode as DedupMode,
      payload,
      payloadRef: row.payload_ref,
    };
  }

  /**
   * Сверить очередь с PostgreSQL.
   *
   * Ключ планировщика в BullMQ — код расписания: он же первичный ключ в
   * PostgreSQL, и по нему две стороны сопоставляются без отдельной
   * таблицы соответствий.
   */
  async reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      expected: 0,
      restored: 0,
      updated: 0,
      removed: 0,
      rejected: 0,
    };
    const rows = await this.db.withSystemScope(
      "jobs.schedules.reconcile",
      async () => await this.db.query<ScheduleRow>(
        `SELECT code, queue, job_type, schema_version, cron, timezone,
                dedup_mode, payload, payload_ref
           FROM job_schedules
          WHERE enabled = true
          ORDER BY code`,
      ),
    ).then((result) => result.rows);

    const expected = new Map<JobQueueName, JobSchedule[]>();
    for (const row of rows) {
      const schedule = this.parse(row);
      if (!schedule) {
        summary.rejected += 1;
        continue;
      }
      summary.expected += 1;
      const list = expected.get(schedule.queue) ?? [];
      list.push(schedule);
      expected.set(schedule.queue, list);
    }

    // Очередь просматривается по всем классам, а не только по тем, для
    // которых есть расписания: лишний планировщик живёт именно там, где
    // расписаний уже не осталось.
    const queues = new Set<JobQueueName>([...expected.keys(), ...this.registry.openQueues]);
    for (const name of queues) {
      const queue = this.registry.queue(name);
      const existing = new Map((await queue.listSchedulers()).map((item) => [item.key, item]));
      for (const schedule of expected.get(name) ?? []) {
        const current = existing.get(schedule.code);
        existing.delete(schedule.code);
        if (!current) {
          await queue.upsertScheduler(schedule.code, this.specOf(schedule));
          summary.restored += 1;
          this.logger.warn("Расписание восстановлено в очереди", {
            code: schedule.code,
            queue: name,
          });
          continue;
        }
        if (current.cron !== schedule.cron || current.timezone !== schedule.timezone) {
          // Канонической считается PostgreSQL: правка расписания в базе
          // обязана дойти до очереди, а не остаться намерением.
          await queue.upsertScheduler(schedule.code, this.specOf(schedule));
          summary.updated += 1;
        }
      }
      for (const orphan of existing.keys()) {
        await queue.removeScheduler(orphan);
        summary.removed += 1;
        this.logger.warn("Из очереди убрано расписание без канонической строки", {
          code: orphan,
          queue: name,
        });
      }
    }

    if (summary.expected > 0) {
      await this.db.withSystemScope(
        "jobs.schedules.synced",
        async () => await this.db.query(
          `UPDATE job_schedules SET last_synced_at = now() WHERE enabled = true`,
        ),
      );
    }
    return summary;
  }

  private specOf(schedule: JobSchedule) {
    return {
      cron: schedule.cron,
      timezone: schedule.timezone,
      jobType: schedule.jobType,
      // В шаблон задания идёт только то, что разрешено конверту: код
      // расписания, версия схемы и безопасный payload.
      data: {
        scheduleCode: schedule.code,
        schemaVersion: schedule.schemaVersion,
        payloadRef: schedule.payloadRef,
        payload: schedule.payload,
      },
    };
  }
}
