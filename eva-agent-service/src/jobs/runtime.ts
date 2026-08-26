/**
 * Исполнение фонового задания: сроки, аренда, отмена и остановка.
 *
 * Здесь собраны общие правила, которые иначе каждый обработчик писал бы
 * заново и каждый — по-своему:
 *
 *   1. Задание не выполняется после жёсткого дедлайна. Просроченная
 *      работа не становится полезной оттого, что её всё-таки сделали:
 *      проактивное сообщение «доброе утро» в четыре часа дня хуже, чем
 *      отсутствие сообщения.
 *   2. Мягкий срок и дедлайн прерывают работу через AbortController, а
 *      не «просят завершиться»: обработчик обязан принимать signal и
 *      передавать его во все вызовы, которые его понимают.
 *   3. Потеря аренды прекращает локальную работу немедленно. Аренду
 *      теряет тот, кого сочли пропавшим, и его задание уже могли отдать
 *      другому исполнителю — продолжать значит делать работу дважды.
 *   4. Остановка сервиса не рвёт начатое: `stop` ждёт активные задания и
 *      не зовёт `process.exit`. Выход — дело вызывающего, и до него
 *      должна успеть пройти вся очистка.
 */

import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { type JobEnvelope, parseJobEnvelope } from "./envelope.js";
import type { JobRunHandle, JobRunJournal } from "./job-runs.js";
import {
  type JobFailureClass,
  type JobTimingPolicy,
  classifyJobError,
  timingFor,
} from "./policy.js";
import { withSpan } from "../observability/tracing.js";
import type { QueueRegistry } from "./queue-registry.js";

export interface JobContext {
  envelope: JobEnvelope;
  runId: string;
  attempt: number;
  /** Прерывается по мягкому сроку, дедлайну, потере аренды и отмене. */
  signal: AbortSignal;
  timing: JobTimingPolicy;
  logger: Logger;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export type JobOutcome =
  | { status: "succeeded"; runId: string }
  | { status: "cancelled"; runId: string; reason: "cancelled" | "lease_lost" }
  | {
    status: "failed";
    runId: string | null;
    code: string;
    failureClass: JobFailureClass;
    /** Стоит ли повторять. Постоянный и неопределённый отказ — нет. */
    retry: boolean;
  };

export interface JobRuntimeOptions {
  /** Сколько ждать активные задания при остановке. */
  drainMs?: number;
}

export class JobRuntime {
  private readonly handlers = new Map<string, JobHandler>();
  /** Поправки сроков на тип задания поверх умолчаний его класса. */
  private readonly timings = new Map<string, Partial<JobTimingPolicy>>();
  private readonly active = new Map<string, AbortController>();
  private readonly ownerId = `${process.pid}-${randomUUID()}`;
  private stopping = false;

  constructor(
    private readonly db: Database,
    private readonly registry: QueueRegistry,
    private readonly runs: JobRunJournal,
    private readonly logger: Logger,
    private readonly options: JobRuntimeOptions = {},
  ) {}

  /**
   * Зарегистрировать обработчик типа. Второй обработчик того же типа —
   * ошибка сборки слоя.
   *
   * `timing` задаёт сроки этого типа поверх умолчаний его класса:
   * «пересчитать одну проекцию памяти» и «перестроить весь граф» живут
   * в одной очереди и не могут иметь один дедлайн. Несогласованность
   * сроков между собой проверяет `timingFor` при первом выполнении:
   * класс очереди известен только из конверта.
   */
  register(type: string, handler: JobHandler, timing: Partial<JobTimingPolicy> = {}): void {
    if (this.handlers.has(type)) {
      throw new Error(`Обработчик задания «${type}» уже зарегистрирован`);
    }
    this.handlers.set(type, handler);
    if (Object.keys(timing).length > 0) this.timings.set(type, timing);
  }

  get registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  get activeJobs(): number {
    return this.active.size;
  }

  /**
   * Выполнить одно задание.
   *
   * Метод не бросает: исход возвращается значением. Вызывающий (воркер
   * очереди) решает по `retry`, повторять ли задание, и не обязан
   * разбирать типы ошибок сам — иначе классификация разошлась бы по
   * обработчикам.
   */
  async execute(raw: unknown, attempt = 1): Promise<JobOutcome> {
    const parsed = parseJobEnvelope(raw);
    if (!parsed.ok) {
      // Испорченный конверт не повторяется: повтор вернёт тот же конверт
      // и тот же отказ, и так до исчерпания попыток.
      await this.deadLetter(raw, parsed.code, "permanent");
      return {
        status: "failed",
        runId: null,
        code: parsed.code,
        failureClass: "permanent",
        retry: false,
      };
    }
    const envelope = parsed.envelope;
    const handler = this.handlers.get(envelope.type);
    if (!handler) {
      await this.deadLetter(envelope, "job_handler_missing", "permanent");
      return {
        status: "failed",
        runId: null,
        code: "job_handler_missing",
        failureClass: "permanent",
        retry: false,
      };
    }
    if (this.stopping) {
      // Остановка идёт: новое задание не начинаем, но и не хороним —
      // его возьмёт другая реплика или этот же процесс после старта.
      return {
        status: "failed",
        runId: null,
        code: "job_runtime_stopping",
        failureClass: "transient",
        retry: true,
      };
    }

    const deadline = Date.parse(envelope.deadlineAt);
    if (Number.isFinite(deadline) && deadline <= Date.now()) {
      await this.deadLetter(envelope, "job_deadline_exceeded", "permanent");
      return {
        status: "failed",
        runId: null,
        code: "job_deadline_exceeded",
        failureClass: "permanent",
        retry: false,
      };
    }

    let timing: JobTimingPolicy;
    try {
      timing = timingFor(envelope.queue, this.timings.get(envelope.type));
    } catch (error) {
      // Несогласованные сроки — ошибка сборки слоя, а не занятости
      // внешнего сервиса: повтор вернёт ту же конфигурацию.
      const failure = classifyJobError(error);
      await this.deadLetter(envelope, failure.code, "permanent");
      return {
        status: "failed",
        runId: null,
        code: failure.code,
        failureClass: "permanent",
        retry: false,
      };
    }
    const runId = randomUUID();
    const handle = await this.runs.open({
      runId,
      envelope,
      attempt,
      leaseMs: timing.leaseDurationMs,
      owner: this.ownerId,
    });

    const controller = new AbortController();
    this.active.set(runId, controller);
    let stopReason: "cancelled" | "lease_lost" | null = null;

    const soft = setTimeout(() => controller.abort(new Error("job_soft_timeout")), timing.softTimeoutMs);
    soft.unref();
    const hardMs = Math.max(
      1,
      Math.min(timing.hardDeadlineMs, Number.isFinite(deadline) ? deadline - Date.now() : timing.hardDeadlineMs),
    );
    const hard = setTimeout(() => controller.abort(new Error("job_deadline_exceeded")), hardMs);
    hard.unref();
    const renewal = setInterval(() => {
      // Отказ продления не прерывает задание и не роняет процесс.
      //
      // `renew()` ходит в PostgreSQL, и при недоступности базы промис
      // отклоняется. Из таймера этот отказ не ловит никто, а Node на
      // необработанном отказе завершает процесс — недоступность базы на
      // секунду убивала бы весь сервис посреди чужого хода.
      //
      // Правильное поведение здесь — ничего не делать: аренда истечёт
      // сама, и задание подберёт другой исполнитель. Отменять работу по
      // одной неудавшейся попытке продления нельзя, она может быть
      // единственной сетевой икотой за час.
      void this.runs.renew(handle, this.ownerId, timing.leaseDurationMs)
        .then((state) => {
          if (state.held) return;
          stopReason = state.reason === "cancelled" ? "cancelled" : "lease_lost";
          controller.abort(new Error(`job_${state.reason}`));
        })
        .catch(() => undefined);
    }, timing.leaseRenewIntervalMs);
    renewal.unref();

    try {
      // Трасса продолжается через очередь: идентификаторы приехали в
      // конверте, потому что стек вызовов между постановкой задания и
      // его выполнением не сохраняется — между ними транзакция,
      // публикатор и, возможно, другой процесс.
      await withSpan(
        `job.${envelope.type}`,
        async () => await handler({
          envelope,
          runId,
          attempt,
          signal: controller.signal,
          timing,
          logger: this.logger,
        }),
        {
          attributes: {
            job_type: envelope.type,
            queue: envelope.queue,
            run_id: runId,
            correlation_id: envelope.correlationId,
            causation_id: envelope.causationId,
            attempt,
            schema_version: envelope.schemaVersion,
          },
        },
      );
      await this.runs.succeed(handle);
      return { status: "succeeded", runId };
    } catch (error) {
      if (stopReason) {
        await this.runs.cancelled(handle);
        return { status: "cancelled", runId, reason: stopReason };
      }
      const failure = classifyJobError(error);
      await this.runs.fail(handle, failure.code, failure.failureClass);
      // Неопределённый исход внешней записи не повторяется сам: повтор
      // может оказаться вторым списанием. Такое задание разбирается
      // сверкой, поэтому уходит в DLQ вместе с постоянными отказами.
      const retry = failure.failureClass === "transient" && attempt < timing.maxAttempts;
      if (!retry) await this.deadLetter(envelope, failure.code, failure.failureClass, handle);
      return {
        status: "failed",
        runId,
        code: failure.code,
        failureClass: failure.failureClass,
        retry,
      };
    } finally {
      clearTimeout(soft);
      clearTimeout(hard);
      clearInterval(renewal);
      this.active.delete(runId);
    }
  }

  /**
   * Остановка.
   *
   * Сначала перестаём принимать новые задания, потом ждём активные, и
   * только потом закрываем очереди. `process.exit` здесь не зовётся:
   * выход посреди очистки оставил бы аренду занятой и соединения
   * открытыми, а именно от этого остановка и защищает.
   *
   * По истечении срока ожидания активные задания прерываются: их аренда
   * истечёт, и работу подберёт другой исполнитель.
   */
  async stop(drainMs = this.options.drainMs ?? 8_000): Promise<{ drained: boolean; active: number }> {
    this.stopping = true;
    const deadline = Date.now() + Math.max(0, drainMs);
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const drained = this.active.size === 0;
    if (!drained) {
      for (const controller of this.active.values()) {
        controller.abort(new Error("job_runtime_shutdown"));
      }
      this.logger.warn("Остановка слоя заданий прервала активные задания", {
        active: this.active.size,
      });
    }
    const active = this.active.size;
    await this.registry.close();
    return { drained, active };
  }

  /** Снова принимать задания после остановки — нужно тестам и перезапуску слоя. */
  resume(): void {
    this.stopping = false;
  }

  /**
   * Запись в DLQ. Только безопасные метаданные: очередь, тип, код и
   * контрольная сумма payload. Сам payload не копируется.
   */
  private async deadLetter(
    source: unknown,
    code: string,
    failureClass: JobFailureClass,
    handle?: JobRunHandle,
  ): Promise<void> {
    const envelope = (source && typeof source === "object" ? source : {}) as Partial<JobEnvelope>;
    try {
      await this.db.withSystemScope(
        "jobs.dead_letter",
        async () => await this.db.query(
          `-- tenant: system — мёртвые задания разбираются оператором по
           -- очереди и коду отказа, а не в области конкретного человека
           INSERT INTO job_dead_letters (
             job_id, run_id, queue, job_type, schema_version, user_id,
             error_code, failure_class, attempts, trace_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            typeof envelope.idempotencyKey === "string" ? envelope.idempotencyKey : "unknown",
            handle?.runId ?? null,
            typeof envelope.queue === "string" ? envelope.queue : "maintenance",
            typeof envelope.type === "string" ? envelope.type : "unknown",
            typeof envelope.schemaVersion === "number" ? envelope.schemaVersion : null,
            typeof envelope.userId === "number" ? envelope.userId : null,
            code.slice(0, 120),
            failureClass,
            0,
            typeof envelope.traceId === "string" ? envelope.traceId : null,
          ],
        ),
        { crossUser: true },
      );
    } catch (error) {
      this.logger.warn("Запись в DLQ не удалась", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}
