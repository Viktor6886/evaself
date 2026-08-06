import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { type DeliveryPriority, priorityValue } from "./priority.js";
import { parseRetryAfter, withJitter } from "./retry-after.js";
import type { TelegramRateLimits } from "./telegram-limits.js";

export interface OutboxEnvelope {
  method: string;
  chatId: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  userId?: number;
  /** Ступень очереди. Не указана — выводится из метода. */
  priority?: DeliveryPriority;
  onMetrics?: (metrics: Partial<DeliveryMetrics>) => void;
  /**
   * Идентификатор строки outbox сразу после постановки. Нужен ходу,
   * чтобы сослаться на свою доставку, не разыскивая её отдельным
   * запросом по ключу идемпотентности.
   */
  onEnqueued?: (outboxId: string) => void;
}

export interface DeliveryMetrics {
  outboxInsertMs: number;
  telegramSendMs: number;
}

export interface OutboxTransport {
  deliver(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface OutboxDelivery {
  send(envelope: OutboxEnvelope): Promise<unknown>;
}

interface OutboxRow {
  id: string;
  telegram_method: string;
  payload: Record<string, unknown>;
  attempts: number;
  chat_id: string;
}

export interface ParallelOutboxOptions {
  /** Сколько доставок идёт одновременно. */
  concurrency: number;
  /** Лимиты Telegram, общие для реплик. Без них параллельность запрещена. */
  limits: TelegramRateLimits | null;
}

export class PostgresTelegramOutbox implements OutboxDelivery {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = `${process.pid}-${randomUUID()}`;
  /** Чаты, доставка в которые идёт прямо сейчас. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly transport: OutboxTransport,
    private readonly logger: Logger,
    private readonly options: {
      pollMs: number;
      leaseSeconds: number;
      maxAttempts: number;
      /** Параллельная доставка. `null` — прежний последовательный путь. */
      parallel?: ParallelOutboxOptions | null;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(100, this.options.pollMs));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async send(envelope: OutboxEnvelope): Promise<unknown> {
    const insertStarted = performance.now();
    const idempotencyKey = envelope.idempotencyKey ?? `telegram:${randomUUID()}`;
    // Постановка в outbox принадлежит тому ходу, из которого пришла:
    // области пользователя, если сообщение — часть его диалога, и
    // системной, если сообщение отправляет сам сервис.
    const { rows } = await this.db.withSystemScope(
      "telegram.outbox.enqueue",
      async () => await this.db.query<{ id: string; status: string }>(
      `INSERT INTO telegram_outbox
         (idempotency_key, user_id, chat_id, telegram_method, payload, priority)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         idempotency_key = EXCLUDED.idempotency_key
       RETURNING id, status`,
      [
        idempotencyKey,
        envelope.userId ?? null,
        envelope.chatId,
        envelope.method,
        JSON.stringify(envelope.payload),
        priorityValue(envelope.priority, envelope.method),
      ],
      ),
      { inherit: true },
    );
    envelope.onMetrics?.({
      outboxInsertMs: elapsed(insertStarted),
    });
    const row = rows[0];
    if (row) envelope.onEnqueued?.(row.id);
    if (!row || row.status === "sent") return { queued: false, duplicate: true };
    const claimed = await this.claimById(row.id);
    if (!claimed) return { queued: true, duplicate: true };
    return await this.deliver(claimed, envelope.onMetrics);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.options.parallel) {
        await this.tickParallel(this.options.parallel);
        return;
      }
      for (let processed = 0; processed < 50; processed += 1) {
        const row = await this.claimNext();
        if (!row) break;
        await this.deliver(row);
      }
    } catch (error) {
      this.logger.error("Ошибка Telegram outbox worker", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Параллельный заход.
   *
   * Одновременно доставляются сообщения **разных** чатов. Внутри одного
   * чата порядок сохраняется буквально: чат, доставка в который идёт,
   * из выборки исключается, а строка не берётся, пока у того же чата
   * есть более раннее незавершённое сообщение. Иначе три части одного
   * ответа пришли бы человеку вперемешку — а это хуже, чем медленно.
   */
  private async tickParallel(parallel: ParallelOutboxOptions): Promise<void> {
    const limit = Math.max(1, parallel.concurrency);
    const inFlight = new Set<Promise<void>>();
    for (let round = 0; round < 50; round += 1) {
      while (inFlight.size >= limit) await Promise.race(inFlight);
      // Сколько доставок шло в момент вопроса. Именно этот счёт, а не
      // счёт после ответа: пока запрос выполнялся, доставки могли
      // закончиться, и «пусто» превратилось бы в «больше нечего» — при
      // том что пусто было ровно из-за них.
      const pending = inFlight.size;
      const rows = await this.claimBatch(limit - pending);
      if (rows.length === 0) {
        // Следующие сообщения занятых чатов ждут, пока доставится
        // текущее, и станут доступны, когда оно закончится. Выйти
        // сейчас значило бы отдавать по одному сообщению на чат за
        // такт опроса — для ответа из трёх частей это три такта.
        if (pending === 0) break;
        if (inFlight.size > 0) await Promise.race(inFlight);
        continue;
      }
      for (const row of rows) {
        this.busy.add(row.chat_id);
        const work = (async () => {
          try {
            await this.deliverGuarded(row, parallel);
          } finally {
            this.busy.delete(row.chat_id);
          }
        })();
        const tracked = work.finally(() => inFlight.delete(tracked));
        inFlight.add(tracked);
      }
    }
    await Promise.allSettled(inFlight);
  }

  /**
   * Доставка с оглядкой на лимиты.
   *
   * Занятый лимит — не отказ доставки: строка возвращается в очередь и
   * **не тратит попытку**. Попытка — это разговор с Telegram, а его не
   * было. Считать иначе значит убивать сообщение за то, что бот был
   * занят.
   */
  private async deliverGuarded(row: OutboxRow, parallel: ParallelOutboxOptions): Promise<void> {
    const chatId = Number(row.chat_id);
    const verdict = await parallel.limits?.take(chatId);
    if (verdict && verdict.waitMs > 0) {
      await this.returnToQueue(row, verdict.waitMs);
      this.logger.debug("Доставка отложена лимитом", {
        outboxId: row.id,
        reason: verdict.reason,
        wait_ms: verdict.waitMs,
      });
      return;
    }
    await this.deliver(row, undefined, parallel.limits ?? null);
  }

  /** Вернуть строку в очередь, не израсходовав попытку. */
  private async returnToQueue(row: OutboxRow, delayMs: number): Promise<void> {
    try {
      await this.db.withSystemScope("telegram.outbox.defer", async () => await this.db.query(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_outbox
            SET status = 'retry',
                attempts = GREATEST(0, attempts - 1),
                available_at = now() + make_interval(secs => $2),
                locked_at = NULL,
                locked_by = NULL
          WHERE id = $1 AND locked_by = $3`,
        [row.id, Math.max(0.05, delayMs / 1000), this.workerId],
      ), { crossUser: true });
    } catch (error) {
      // Строка останется в `sending` и вернётся по истечении аренды.
      // Это медленнее, но не теряет сообщение.
      this.logger.warn("Не удалось вернуть доставку в очередь", {
        outboxId: row.id,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  /**
   * Выборка пачкой: приоритет, затем готовность, затем возраст.
   *
   * Два исключения не дают переставить сообщения одного чата: чат, уже
   * занятый этим процессом, и чат, у которого есть более раннее
   * незавершённое сообщение. Второе шире первого — оно защищает и от
   * соседней реплики, потому что смотрит в таблицу, а не в память.
   */
  private async claimBatch(limit: number): Promise<OutboxRow[]> {
    if (limit <= 0) return [];
    const busy = [...this.busy];
    return await this.db.withSystemScope("telegram.outbox.claim.batch", async () =>
      await this.db.transaction(async (client) => {
        await client.query(
          `
            -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
            UPDATE telegram_outbox
              SET status = 'dead',
                  last_error = COALESCE(last_error, 'worker lease expired after final attempt'),
                  locked_at = NULL,
                  locked_by = NULL
            WHERE status = 'sending'
              AND attempts >= $2
              AND locked_at < now() - make_interval(secs => $1)`,
          [Math.max(30, this.options.leaseSeconds), Math.max(1, this.options.maxAttempts)],
        );
        const { rows } = await client.query<OutboxRow & { priority: number }>(
          `
            -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
            SELECT t.id, t.telegram_method, t.payload, t.attempts, t.chat_id, t.priority
              FROM telegram_outbox t
             WHERE t.attempts < $2
               AND (
                 (t.status IN ('pending', 'retry') AND t.available_at <= now())
                 OR (t.status = 'sending' AND t.locked_at < now() - make_interval(secs => $1))
               )
               AND NOT (t.chat_id = ANY($4::bigint[]))
               AND NOT EXISTS (
                 SELECT 1 FROM telegram_outbox earlier
                  WHERE earlier.chat_id = t.chat_id
                    AND earlier.status IN ('pending', 'sending', 'retry')
                    AND (earlier.priority, earlier.id) < (t.priority, t.id)
               )
             ORDER BY t.priority, t.available_at, t.id
             FOR UPDATE OF t SKIP LOCKED
             LIMIT $3`,
          [
            Math.max(30, this.options.leaseSeconds),
            Math.max(1, this.options.maxAttempts),
            limit,
            busy,
          ],
        );
        // Один чат — одна строка за заход: остальные его сообщения
        // подождут, иначе порядок внутри чата снова стал бы случайным.
        const picked: OutboxRow[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          if (seen.has(row.chat_id)) continue;
          seen.add(row.chat_id);
          picked.push(row);
        }
        if (picked.length === 0) return [];
        await client.query(
          `
            -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
            UPDATE telegram_outbox
              SET status = 'sending',
                  attempts = attempts + 1,
                  locked_at = now(),
                  locked_by = $2
            WHERE id = ANY($1::bigint[])`,
          [picked.map((row) => row.id), this.workerId],
        );
        return picked.map((row) => ({ ...row, attempts: row.attempts + 1 }));
      }),
      { crossUser: true },
    );
  }

  private async claimById(id: string): Promise<OutboxRow | null> {
    const { rows } = await this.db.withSystemScope(
      "telegram.outbox.claim",
      async () => await this.db.query<OutboxRow>(
      `
        -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
        UPDATE telegram_outbox
          SET status = 'sending',
              attempts = attempts + 1,
              locked_at = now(),
              locked_by = $2
        WHERE id = $1
          AND status IN ('pending', 'retry')
          AND available_at <= now()
          AND attempts < $3
      RETURNING id, telegram_method, payload, attempts, chat_id`,
      [id, this.workerId, Math.max(1, this.options.maxAttempts)],
      ),
      { crossUser: true },
    );
    return rows[0] ?? null;
  }

  private async claimNext(): Promise<OutboxRow | null> {
    return await this.db.withSystemScope("telegram.outbox.worker", async () =>
      await this.db.transaction(async (client) => {
      await client.query(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_outbox
            SET status = 'dead',
                last_error = COALESCE(last_error, 'worker lease expired after final attempt'),
                locked_at = NULL,
                locked_by = NULL
          WHERE status = 'sending'
            AND attempts >= $2
            AND locked_at < now() - make_interval(secs => $1)`,
        [
          Math.max(30, this.options.leaseSeconds),
          Math.max(1, this.options.maxAttempts),
        ],
      );
      const { rows } = await client.query<OutboxRow>(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          SELECT id, telegram_method, payload, attempts, chat_id
           FROM telegram_outbox
          WHERE attempts < $2
            AND (
              (status IN ('pending', 'retry') AND available_at <= now())
              OR
              (status = 'sending'
                AND locked_at < now() - make_interval(secs => $1))
            )
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [Math.max(30, this.options.leaseSeconds), Math.max(1, this.options.maxAttempts)],
      );
      const row = rows[0];
      if (!row) return null;
      await client.query(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_outbox
            SET status = 'sending',
                attempts = attempts + 1,
                locked_at = now(),
                locked_by = $2
          WHERE id = $1`,
        [row.id, this.workerId],
      );
      return { ...row, attempts: row.attempts + 1 };
      }),
      { crossUser: true },
    );
  }

  private async deliver(
    row: OutboxRow,
    onMetrics?: OutboxEnvelope["onMetrics"],
    limits: TelegramRateLimits | null = null,
  ): Promise<unknown> {
    try {
      const sendStarted = performance.now();
      const result = await this.transport.deliver(row.telegram_method, row.payload);
      const telegramSendMs = elapsed(sendStarted);
      onMetrics?.({ telegramSendMs });
      const messageIds = extractMessageIds(result);
      await this.db.withSystemScope("telegram.outbox.sent", async () =>
        await this.db.query(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_outbox
            SET status = 'sent',
                telegram_message_ids = $2::bigint[],
                last_error = NULL,
                sent_at = now(),
                locked_at = NULL,
                locked_by = NULL
          WHERE id = $1`,
        [row.id, messageIds],
        ),
      { crossUser: true },
    );
      this.logger.debug("Telegram outbox доставлен", {
        outboxId: row.id,
        telegram_send_ms: telegramSendMs,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Пауза, назначенная самим Telegram, сильнее нашего расчёта: он
      // угадывает, а она известна. Попытка при этом не считается
      // израсходованной — разговор состоялся, но ответом было «позже».
      const askedSeconds = parseRetryAfter({
        body: (error as { response?: unknown })?.response ?? error,
        header: (error as { retryAfterHeader?: string | null })?.retryAfterHeader ?? null,
      });
      const throttled = askedSeconds !== null;
      const dead = !throttled && row.attempts >= this.options.maxAttempts;
      const backoffSeconds = throttled
        ? withJitter(askedSeconds)
        : Math.min(300, Math.max(2, 2 ** Math.max(0, row.attempts - 1)));
      if (throttled) {
        await limits?.cooldown(Number(row.chat_id), askedSeconds);
        this.logger.info("Telegram попросил подождать", {
          outboxId: row.id,
          retry_after_seconds: askedSeconds,
          wait_seconds: backoffSeconds,
        });
      }
      await this.db.withSystemScope("telegram.outbox.retry", async () =>
        await this.db.query(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_outbox
            SET status = $2,
                available_at = CASE
                  WHEN $2 = 'retry' THEN now() + make_interval(secs => $3)
                  ELSE available_at
                END,
                -- Отказ по просьбе подождать попытку не расходует:
                -- Telegram не отказал, он назначил время.
                attempts = CASE WHEN $5::boolean THEN GREATEST(0, attempts - 1) ELSE attempts END,
                last_error = $4,
                locked_at = NULL,
                locked_by = NULL
          WHERE id = $1`,
        [row.id, dead ? "dead" : "retry", backoffSeconds, message.slice(0, 2_000), throttled],
        ),
      { crossUser: true },
    );
      this.logger.warn("Доставка Telegram отложена", {
        outboxId: row.id,
        attempt: row.attempts,
        dead,
        message,
      });
      return { queued: !dead, dead };
    }
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

function extractMessageIds(result: unknown): number[] {
  const values = Array.isArray(result) ? result : [result];
  return values
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const value = (item as Record<string, unknown>).message_id;
      const id = typeof value === "number" ? value : Number(value);
      return Number.isSafeInteger(id) ? id : null;
    })
    .filter((id): id is number => id !== null);
}
