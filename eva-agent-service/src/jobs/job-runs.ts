/**
 * Канонический журнал запусков заданий.
 *
 * Очередь в Valkey знает, что задание есть. Она не знает, выполнялось ли
 * оно, сколько раз, чем кончилось и кто держит его прямо сейчас — а без
 * этого нельзя ни отменить задание, ни отличить «висит» от «идёт
 * медленно», ни восстановить работу после падения процесса. Поэтому
 * запуск живёт в PostgreSQL (инвариант 1), а очередь остаётся
 * восстановимым операционным состоянием (инвариант 2).
 *
 * Аренда, а не флаг «выполняется». Процесс, убитый SIGKILL, флаг не
 * снимет, и задание останется «выполняющимся» навсегда. Аренда истекает
 * сама, и запуск с истёкшей арендой честно называется потерянным.
 */

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { type JobEnvelope, payloadChecksum } from "./envelope.js";
import type { JobFailureClass } from "./policy.js";

export interface JobRunHandle {
  runId: string;
  jobId: string;
  userId: number | null;
  queue: string;
  type: string;
  recorded: boolean;
}

/** Что вернуло продление аренды. */
export type LeaseRenewal =
  /** Аренда наша, работа продолжается. */
  | { held: true; cancelRequested: boolean }
  /** Аренду потеряли или запуск отменён: локальная работа прекращается. */
  | { held: false; reason: "lost" | "cancelled" | "unknown" };

export class JobRunJournal {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /**
   * Область арендатора для строки запуска.
   *
   * У системного задания владельца нет — такая строка по смыслу общая, и
   * обращение к ней объявляется системной областью. У пользовательского
   * владелец есть, и он называется в каждом запросе.
   */
  private scoped<T>(userId: number | null, label: string, work: () => Promise<T>): Promise<T> {
    if (userId === null) {
      return this.db.withSystemScope(label, work, { crossUser: true, inherit: false });
    }
    return this.db.withUserScope({ userId, label, inherit: true }, async () => await work());
  }

  /**
   * Условие владельца для запроса по `run_id`.
   *
   * Первичного ключа границе арендатора мало: запрос обязан называть
   * владельца, иначе тот же `run_id`, полученный откуда угодно, вычитал
   * бы чужую строку. У системного задания владельца нет, и это тоже
   * условие, а не его отсутствие.
   */
  private owner(userId: number | null, index: number): { clause: string; values: unknown[] } {
    return userId === null
      ? { clause: "user_id IS NULL", values: [] }
      : { clause: `user_id = $${index}`, values: [userId] };
  }

  /** Открыть запуск. Возвращает handle даже при отказе записи: журнал не отменяет работу. */
  async open(input: {
    runId: string;
    envelope: JobEnvelope;
    attempt: number;
    leaseMs: number;
    owner: string;
    scheduleCode?: string | null;
  }): Promise<JobRunHandle> {
    const { envelope } = input;
    const handle: JobRunHandle = {
      runId: input.runId,
      jobId: envelope.idempotencyKey,
      userId: envelope.userId,
      queue: envelope.queue,
      type: envelope.type,
      recorded: false,
    };
    try {
      await this.scoped(envelope.userId, "jobs.run.open", async () => await this.db.query(
        `INSERT INTO job_runs (
           run_id, job_id, queue, job_type, schema_version, user_id,
           payload_checksum, status, attempt, lease_until, lease_owner,
           schedule_code, timezone, trace_id, parent_trace_id, dedup_key
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, 'running', $8, now() + make_interval(secs => $9), $10,
           $11, $12, $13, $14, $15
         )
         ON CONFLICT (run_id) DO NOTHING`,
        [
          input.runId,
          envelope.idempotencyKey,
          envelope.queue,
          envelope.type,
          envelope.schemaVersion,
          envelope.userId,
          payloadChecksum(envelope),
          input.attempt,
          Math.ceil(input.leaseMs / 1000),
          input.owner,
          input.scheduleCode ?? null,
          envelope.timezone,
          envelope.traceId,
          envelope.causationId,
          // Ключ дедупликации в журнале отвечает на вопрос «почему одно и
          // то же задание выполнялось дважды»: без него два запуска
          // выглядят просто двумя разными.
          envelope.dedupKey,
        ],
      ));
      handle.recorded = true;
    } catch (error) {
      this.warn("Запуск задания не записан", error, { queue: envelope.queue });
    }
    return handle;
  }

  /**
   * Продлить аренду.
   *
   * Продление условное: `lease_owner = $2` означает «аренда всё ещё
   * наша». Если запуск подобрало восстановление и отдало другому
   * исполнителю, продление ничего не обновит, и наш исполнитель обязан
   * остановиться — иначе два процесса делали бы одну работу.
   *
   * Тем же запросом читается требование отмены: отдельный поход в базу
   * ради него удваивал бы нагрузку на самый частый запрос слоя.
   */
  async renew(handle: JobRunHandle, owner: string, leaseMs: number): Promise<LeaseRenewal> {
    if (!handle.recorded) return { held: true, cancelRequested: false };
    try {
      const scope = this.owner(handle.userId, 4);
      return await this.scoped(handle.userId, "jobs.run.renew", async () => {
        const { rows } = await this.db.query<{ cancel_requested: boolean }>(
          `-- tenant: by user_id — условие владельца подставляет owner():
           -- user_id = $N для задания человека, user_id IS NULL для
           -- системного; значение сверяет граница арендатора
           UPDATE job_runs
              SET lease_until = now() + make_interval(secs => $3)
            WHERE run_id = $1
              AND lease_owner = $2
              AND ${scope.clause}
              AND status = 'running'
              AND cancel_requested = false
            RETURNING cancel_requested`,
          [handle.runId, owner, Math.ceil(leaseMs / 1000), ...scope.values],
        );
        if (rows.length > 0) return { held: true, cancelRequested: false } as LeaseRenewal;
        const probe = this.owner(handle.userId, 2);
        const state = await this.db.query<{ status: string; cancel_requested: boolean }>(
          `-- tenant: by user_id — условие владельца подставляет owner():
           -- user_id = $N для задания человека, user_id IS NULL для
           -- системного; значение сверяет граница арендатора
           SELECT status, cancel_requested FROM job_runs
            WHERE run_id = $1 AND ${probe.clause}`,
          [handle.runId, ...probe.values],
        );
        const row = state.rows[0];
        if (!row) return { held: false, reason: "unknown" } as LeaseRenewal;
        if (row.cancel_requested) return { held: false, reason: "cancelled" } as LeaseRenewal;
        return { held: false, reason: "lost" } as LeaseRenewal;
      });
    } catch (error) {
      this.warn("Аренда запуска не продлена", error, { runId: handle.runId });
      // Отказ базы не означает потерю аренды: она ещё действует до конца
      // срока, и прекращать работу из-за одного неудачного запроса рано.
      return { held: true, cancelRequested: false };
    }
  }

  async succeed(handle: JobRunHandle): Promise<void> {
    await this.finish(handle, "succeeded", null, null);
  }

  async fail(
    handle: JobRunHandle,
    code: string,
    failureClass: JobFailureClass,
  ): Promise<void> {
    await this.finish(handle, "failed", code, failureClass);
  }

  async cancelled(handle: JobRunHandle): Promise<void> {
    await this.finish(handle, "cancelled", "cancelled", null);
  }

  private async finish(
    handle: JobRunHandle,
    status: "succeeded" | "failed" | "cancelled",
    code: string | null,
    failureClass: JobFailureClass | null,
  ): Promise<void> {
    if (!handle.recorded) return;
    const scope = this.owner(handle.userId, 5);
    try {
      await this.scoped(handle.userId, "jobs.run.finish", async () => await this.db.query(
        `-- tenant: by user_id — условие владельца подставляет owner():
           -- user_id = $N для задания человека, user_id IS NULL для
           -- системного; значение сверяет граница арендатора
           UPDATE job_runs
            SET status = $2,
                error_code = $3,
                failure_class = $4,
                lease_until = NULL,
                finished_at = now()
          WHERE run_id = $1 AND ${scope.clause}`,
        [handle.runId, status, code?.slice(0, 120) ?? null, failureClass, ...scope.values],
      ));
    } catch (error) {
      this.warn("Итог запуска не записан", error, { runId: handle.runId });
    }
  }

  /**
   * Попросить отмену. Токен отдаётся вызывающему: отменяющая сторона
   * может убедиться, что остановила именно тот запуск, о котором знала.
   */
  async requestCancel(runId: string, userId: number | null, token: string): Promise<boolean> {
    const scope = this.owner(userId, 3);
    try {
      return await this.scoped(userId, "jobs.run.cancel", async () => {
        const { rows } = await this.db.query<{ run_id: string }>(
          `-- tenant: by user_id — условие владельца подставляет owner():
           -- user_id = $N для задания человека, user_id IS NULL для
           -- системного; значение сверяет граница арендатора
           UPDATE job_runs
              SET cancel_requested = true, cancel_token = $2
            WHERE run_id = $1 AND ${scope.clause} AND status = 'running'
            RETURNING run_id`,
          [runId, token, ...scope.values],
        );
        return rows.length > 0;
      });
    } catch (error) {
      this.warn("Отмена запуска не записана", error, { runId });
      return false;
    }
  }

  /** Cancel the active run identified by its durable ingress correlation id. */
  async requestCancelByCorrelation(correlationId: string, userId: number, token: string): Promise<boolean> {
    try {
      return await this.scoped(userId, "jobs.run.cancel-correlation", async () => {
        const { rows } = await this.db.query<{ run_id: string }>(
          `-- tenant: by user_id — cancellation is bound to the verified owner
           UPDATE job_runs SET cancel_requested=true,cancel_token=$3
            WHERE run_id=(SELECT run_id FROM job_runs WHERE user_id=$1 AND correlation_id=$2 AND status='running' ORDER BY started_at DESC LIMIT 1)
              AND user_id=$1 AND status='running' RETURNING run_id`,
          [userId, correlationId, token],
        );
        return rows.length > 0;
      });
    } catch (error) { this.warn("Отмена запуска по correlation id не записана", error, { correlationId }); return false; }
  }

  /**
   * Закрыть запуски с истёкшей арендой.
   *
   * `lost` — отдельный статус, а не `failed`: отказа не было, был
   * пропавший исполнитель. Разница видна в разборе и не превращает
   * перезапуск процесса в статистику отказов.
   */
  async sweepLost(limit = 50): Promise<number> {
    try {
      const { rows } = await this.db.withSystemScope(
        "jobs.run.sweep",
        async () => await this.db.query<{ run_id: string }>(
          `-- tenant: system — потерянные запуски ищутся сразу по всем
           -- пользователям, как и восстановление ходов
           UPDATE job_runs
              SET status = 'lost', finished_at = now(), lease_until = NULL
            WHERE run_id IN (
              SELECT run_id FROM job_runs
               WHERE status = 'running'
                 AND lease_until IS NOT NULL
                 AND lease_until < now()
               ORDER BY lease_until
               FOR UPDATE SKIP LOCKED
               LIMIT $1
            )
            RETURNING run_id`,
          [limit],
        ),
        { crossUser: true },
      );
      return rows.length;
    } catch (error) {
      this.warn("Не удалось закрыть потерянные запуски", error, {});
      return 0;
    }
  }

  private warn(message: string, error: unknown, context: Record<string, unknown>): void {
    this.logger.warn(message, {
      ...context,
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
