/**
 * Транзакционный job outbox.
 *
 * Между «решили поставить задание» и «задание в очереди» лежит процесс,
 * который может упасть. Если писать в BullMQ прямо из бизнес-кода, то
 * падение после COMMIT теряет задание, а падение до COMMIT оставляет
 * задание без причины. Поэтому намерение фиксируется в PostgreSQL в той
 * же транзакции, что и бизнес-изменение, а в очередь его переносит
 * отдельный публикатор.
 *
 * Идемпотентность держится на одном ключе: `idempotency_key` строки —
 * он же `jobId` в BullMQ. Повторный публикатор, взявший ту же строку
 * после истёкшей аренды, поставит задание с тем же идентификатором, и
 * второго задания не появится.
 *
 * Отказ Valkey сюда не проникает: `record` пишет только в PostgreSQL, а
 * публикация идёт в фоне. Недоступный брокер задерживает задания, но не
 * превращает вебхук в синхронного исполнителя (требование 10 шага 7).
 */

import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import {
  type JobEnvelope,
  type JobEnvelopeInput,
  buildJobEnvelope,
  parseJobEnvelope,
} from "./envelope.js";
import { classifyJobError, replacesPending, timingFor } from "./policy.js";
import type { QueueRegistry } from "./queue-registry.js";

/** Минимальный контракт клиента транзакции: тот же, что у `Database.transaction`. */
export interface JobOutboxClient {
  query<T = unknown>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface JobIntent extends JobEnvelopeInput {
  /** Отложенный старт: задание не публикуется раньше этого момента. */
  availableAt?: Date;
}

export interface JobRecordResult {
  idempotencyKey: string;
  /** Такое намерение уже записано: второй строки не появилось. */
  duplicate: boolean;
}

interface OutboxRow {
  id: string;
  idempotency_key: string;
  queue: string;
  job_type: string;
  schema_version: number;
  user_id: string | number | null;
  envelope: unknown;
  dedup_key: string | null;
  attempts: number;
}

export interface PublishSummary {
  claimed: number;
  published: number;
  duplicates: number;
  retried: number;
  dead: number;
}

export interface JobOutboxOptions {
  /** Сколько строк публикатор забирает за заход. */
  batchSize?: number;
  /** Аренда публикатора на строку. */
  leaseSeconds?: number;
  /** Сколько раз повторяется временный отказ публикации. */
  maxAttempts?: number;
  /** Период фонового публикатора. */
  pollMs?: number;
}

export class JobOutbox {
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly pollMs: number;
  private readonly workerId = `${process.pid}-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: Database,
    private readonly registry: QueueRegistry,
    private readonly logger: Logger,
    options: JobOutboxOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 32;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.pollMs = options.pollMs ?? 1_000;
  }

  /**
   * Фоновый публикатор.
   *
   * Заходы не накладываются: `ticking` пропускает тик, начавшийся до
   * конца предыдущего. Без этого недоступный брокер, на котором каждая
   * публикация ждёт таймаута, за минуту накопил бы полсотни
   * параллельных заходов по одним и тем же строкам.
   */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(200, this.pollMs));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.publishPending();
    } catch (error) {
      // Отказ публикатора не должен останавливать таймер: строки
      // остаются в PostgreSQL, следующий заход попробует снова.
      this.logger.warn("Заход публикатора заданий не удался", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Записать намерение внутри уже открытой транзакции.
   *
   * Клиент передаётся снаружи намеренно: задание обязано попасть в ту же
   * транзакцию, что и бизнес-изменение. Своя транзакция здесь вернула бы
   * ровно ту проблему, ради которой outbox и существует.
   *
   * Область арендатора не открывается: её объявил тот, кто открыл
   * транзакцию. Запись без объявленной области отклонит граница.
   */
  async record(client: JobOutboxClient, intent: JobIntent): Promise<JobRecordResult> {
    const envelope = buildJobEnvelope(intent);
    const { rows } = await client.query<{ idempotency_key: string; inserted: boolean }>(
      `INSERT INTO job_outbox (
         idempotency_key, queue, job_type, schema_version, user_id,
         envelope, dedup_key, trace_id, available_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, COALESCE($9::timestamptz, now()))
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key, true AS inserted`,
      [
        envelope.idempotencyKey,
        envelope.queue,
        envelope.type,
        envelope.schemaVersion,
        envelope.userId,
        JSON.stringify(envelope),
        envelope.dedupKey,
        envelope.traceId,
        intent.availableAt ? intent.availableAt.toISOString() : null,
      ],
    );
    return {
      idempotencyKey: envelope.idempotencyKey,
      duplicate: rows.length === 0,
    };
  }

  /**
   * Опубликовать всё, что готово.
   *
   * Строка забирается арендой, а не пометкой «в работе»: процесс,
   * упавший между claim и публикацией, иначе оставил бы её занятой
   * навсегда. По истечении аренды строку возьмёт другой публикатор, и
   * повторная публикация второго задания не создаст.
   */
  async publishPending(limit = this.batchSize): Promise<PublishSummary> {
    const summary: PublishSummary = {
      claimed: 0,
      published: 0,
      duplicates: 0,
      retried: 0,
      dead: 0,
    };
    const rows = await this.claim(limit);
    summary.claimed = rows.length;
    for (const row of rows) {
      const parsed = parseJobEnvelope(row.envelope);
      if (!parsed.ok) {
        // Испорченный или незнакомый конверт не повторяется: повтор дал
        // бы бесконечный цикл, а не восстановление.
        await this.markDead(row, parsed.code, "permanent");
        summary.dead += 1;
        continue;
      }
      const envelope = parsed.envelope;
      try {
        const queue = this.registry.queue(envelope.queue);
        const timing = timingFor(envelope.queue);
        const result = await queue.add(envelope.type, envelope, {
          jobId: envelope.idempotencyKey,
          attempts: timing.maxAttempts,
          backoffMs: timing.backoffMs,
          replacePending: replacesPending(envelope.dedupMode),
        });
        await this.markPublished(row);
        summary.published += 1;
        if (result.duplicate) summary.duplicates += 1;
      } catch (error) {
        const failure = classifyJobError(error);
        // Постоянный отказ публикации — это отказ самого задания
        // (запрещённая очередь, неверные сроки), а не занятости брокера.
        if (failure.failureClass === "permanent" || row.attempts >= this.maxAttempts) {
          await this.markDead(row, failure.code, failure.failureClass);
          summary.dead += 1;
          continue;
        }
        await this.reschedule(row, failure.code);
        summary.retried += 1;
      }
    }
    return summary;
  }

  /**
   * Забрать готовые строки.
   *
   * `SKIP LOCKED` — чтобы два публикатора не ждали друг друга на одной
   * строке; аренда — чтобы упавший публикатор не держал её вечно.
   */
  private async claim(limit: number): Promise<OutboxRow[]> {
    return await this.db.withSystemScope(
      "jobs.outbox.publish",
      async () => {
        const { rows } = await this.db.query<OutboxRow>(
          `-- tenant: system — публикатор забирает готовые задания всех
           -- пользователей сразу, как inbox и outbox доставки
           UPDATE job_outbox
              SET status = 'publishing',
                  attempts = attempts + 1,
                  lease_until = now() + make_interval(secs => $2),
                  lease_owner = $3
            WHERE id IN (
              SELECT id FROM job_outbox
               WHERE status IN ('pending', 'publishing')
                 AND available_at <= now()
                 AND (lease_until IS NULL OR lease_until < now())
               ORDER BY available_at, id
               FOR UPDATE SKIP LOCKED
               LIMIT $1
            )
            RETURNING id, idempotency_key, queue, job_type, schema_version,
                      user_id, envelope, dedup_key, attempts`,
          [limit, this.leaseSeconds, this.workerId],
        );
        return rows;
      },
      { crossUser: true },
    );
  }

  private async markPublished(row: OutboxRow): Promise<void> {
    await this.db.withSystemScope(
      "jobs.outbox.published",
      async () => await this.db.query(
        `-- tenant: system — строка адресуется своим первичным ключом,
         -- владелец уже проверен при claim
         UPDATE job_outbox
            SET status = 'published',
                published_at = now(),
                lease_until = NULL,
                lease_owner = NULL,
                error_code = NULL
          WHERE id = $1`,
        [row.id],
      ),
      { crossUser: true },
    );
  }

  /** Временный отказ: строка возвращается в очередь с экспоненциальной паузой. */
  private async reschedule(row: OutboxRow, code: string): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(row.attempts, 8));
    await this.db.withSystemScope(
      "jobs.outbox.retry",
      async () => await this.db.query(
        `-- tenant: system — строка адресуется своим первичным ключом,
         -- владелец уже проверен при claim
         UPDATE job_outbox
            SET status = 'pending',
                available_at = now() + make_interval(secs => $2),
                lease_until = NULL,
                lease_owner = NULL,
                error_code = $3
          WHERE id = $1`,
        [row.id, delaySeconds, code.slice(0, 120)],
      ),
      { crossUser: true },
    );
    this.logger.warn("Публикация задания отложена", {
      queue: row.queue,
      type: row.job_type,
      attempts: row.attempts,
      code,
    });
  }

  /**
   * Мёртвое задание: строка закрывается и попадает в DLQ.
   *
   * В DLQ уходят только очередь, тип, код и трасса — по ним отказ
   * разбирается. Конверт не копируется: он содержит идентификаторы
   * пользователя, а мёртвые задания живут долго.
   */
  private async markDead(row: OutboxRow, code: string, failureClass: string): Promise<void> {
    await this.db.withSystemScope(
      "jobs.outbox.dead",
      async () => {
        await this.db.query(
          `-- tenant: system — строка адресуется своим первичным ключом,
           -- владелец уже проверен при claim
           UPDATE job_outbox
              SET status = 'dead',
                  lease_until = NULL,
                  lease_owner = NULL,
                  error_code = $2
            WHERE id = $1`,
          [row.id, code.slice(0, 120)],
        );
        await this.db.query(
          `INSERT INTO job_dead_letters (
             job_id, queue, job_type, schema_version, user_id,
             error_code, failure_class, attempts
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            row.idempotency_key,
            row.queue,
            row.job_type,
            row.schema_version,
            row.user_id,
            code.slice(0, 120),
            failureClass,
            row.attempts,
          ],
        );
      },
      { crossUser: true },
    );
    this.logger.error("Задание признано мёртвым", {
      queue: row.queue,
      type: row.job_type,
      attempts: row.attempts,
      code,
    });
  }
}

/** Ключ идемпотентности задания: тип, арендатор и различитель намерения. */
export function jobIdempotencyKey(input: {
  type: string;
  userId: number | null;
  discriminator: string;
}): string {
  const tenant = input.userId === null ? "system" : `u${input.userId}`;
  return `${input.type}:${tenant}:${input.discriminator}`;
}

export type { JobEnvelope };
