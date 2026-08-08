import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { TelegramDeliveryLimiter } from "./telegram-limits.js";

export type DeliveryClass =
  | "crisis"
  | "answer"
  | "command"
  | "payment"
  | "reminder"
  | "typing"
  | "service";

const DELIVERY_PRIORITY: Record<DeliveryClass, number> = {
  crisis: 0,
  answer: 10,
  command: 20,
  payment: 20,
  reminder: 30,
  typing: 40,
  service: 40,
};

export interface OutboxEnvelope {
  method: string;
  chatId: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  userId?: number;
  deliveryClass?: DeliveryClass;
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
  chat_id: string;
  telegram_method: string;
  payload: Record<string, unknown>;
  attempts: number;
  priority: number;
}

export class PostgresTelegramOutbox implements OutboxDelivery {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = `${process.pid}-${randomUUID()}`;

  constructor(
    private readonly db: Database,
    private readonly transport: OutboxTransport,
    private readonly logger: Logger,
    private readonly options: {
      pollMs: number;
      leaseSeconds: number;
      maxAttempts: number;
      parallel?: boolean;
      concurrency?: number;
      batchSize?: number;
      limiter?: TelegramDeliveryLimiter;
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
        DELIVERY_PRIORITY[envelope.deliveryClass ?? "answer"],
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
    if (this.options.parallel) return { queued: true, duplicate: false };
    const claimed = await this.claimById(row.id);
    if (!claimed) return { queued: true, duplicate: true };
    return await this.deliver(claimed, envelope.onMetrics);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.options.parallel) {
        const rows = await this.claimBatch();
        await Promise.allSettled(rows.map(async (row) => await this.deliver(row)));
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
      RETURNING id, chat_id, telegram_method, payload, attempts, priority`,
      [id, this.workerId, Math.max(1, this.options.maxAttempts)],
      ),
      { crossUser: true },
    );
    return rows[0] ?? null;
  }

  async drain(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async claimBatch(): Promise<OutboxRow[]> {
    const leaseSeconds = Math.max(30, this.options.leaseSeconds);
    const maxAttempts = Math.max(1, this.options.maxAttempts);
    const concurrency = Math.max(1, this.options.concurrency ?? 8);
    const batchSize = Math.max(1, Math.min(this.options.batchSize ?? concurrency, concurrency));
    return await this.db.withSystemScope("telegram.outbox.worker_batch", async () =>
      await this.db.transaction(async (client) => {
        await client.query(
          `
            -- tenant: system — sweeper общей durable delivery, не запрос пользователя
            UPDATE telegram_outbox
               SET status = 'dead',
                   last_error = COALESCE(last_error, 'worker lease expired after final attempt'),
                   locked_at = NULL,
                   locked_by = NULL
             WHERE status = 'sending'
               AND attempts >= $2
               AND locked_at < now() - make_interval(secs => $1)`,
          [leaseSeconds, maxAttempts],
        );
        const { rows } = await client.query<OutboxRow>(
          `-- tenant: system — атомарный claim durable outbox между репликами, не запрос пользователя
           WITH candidates AS (
             SELECT id
               FROM telegram_outbox
              WHERE attempts < $2
                AND (
                  (status IN ('pending', 'retry') AND available_at <= now())
                  OR (status = 'sending'
                      AND locked_at < now() - make_interval(secs => $1))
                )
              ORDER BY priority, available_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT $4
           )
           UPDATE telegram_outbox o
              SET status = 'sending', attempts = o.attempts + 1,
                  locked_at = now(), locked_by = $3
             FROM candidates c
            WHERE o.id = c.id
        RETURNING o.id, o.chat_id, o.telegram_method, o.payload,
                  o.attempts, o.priority`,
          [leaseSeconds, maxAttempts, this.workerId, batchSize],
        );
        return rows.sort((left, right) =>
          left.priority - right.priority || Number(left.id) - Number(right.id));
      }),
      { crossUser: true },
    );
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
          SELECT id, chat_id, telegram_method, payload, attempts, priority
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
  ): Promise<unknown> {
    const chatId = Number(row.chat_id);
    if (this.options.limiter && Number.isSafeInteger(chatId)) {
      try {
        const waitMs = await this.options.limiter.reserve(chatId);
        if (waitMs > 0) {
          await this.deferWithoutAttempt(row.id, waitMs);
          return { queued: true, rateLimited: true };
        }
      } catch (error) {
        // Valkey coordinates capacity, PostgreSQL keeps the message. If the
        // limiter is unavailable, fail closed and retry instead of exceeding
        // Telegram's bot-wide limit from every replica independently.
        await this.deferWithoutAttempt(row.id, 1_000);
        this.logger.warn("Telegram limiter недоступен, доставка отложена", {
          outboxId: row.id,
          code: error instanceof Error ? error.name : "unknown_error",
        });
        return { queued: true, rateLimited: true };
      }
    }
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
      const dead = row.attempts >= this.options.maxAttempts;
      const message = error instanceof Error ? error.message : String(error);
      const retryAfterMs = telegramRetryAfterMs(error);
      const jitterMs = retryAfterMs === null ? 0 : Math.floor(Math.random() * 250);
      const backoffSeconds = retryAfterMs === null
        ? Math.min(300, Math.max(2, 2 ** Math.max(0, row.attempts - 1)))
        : Math.max(1, Math.ceil((retryAfterMs + jitterMs) / 1_000));
      if (retryAfterMs !== null && this.options.limiter && Number.isSafeInteger(chatId)) {
        await this.options.limiter.penalize(chatId, retryAfterMs + jitterMs).catch(() => undefined);
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
                attempts = CASE WHEN $5 THEN GREATEST(attempts - 1, 0) ELSE attempts END,
                last_error = $4,
                locked_at = NULL,
                locked_by = NULL
          WHERE id = $1`,
        [
          row.id,
          retryAfterMs !== null ? "retry" : dead ? "dead" : "retry",
          backoffSeconds,
          message.slice(0, 2_000),
          retryAfterMs !== null,
        ],
        ),
      { crossUser: true },
    );
      this.logger.warn("Доставка Telegram отложена", {
        outboxId: row.id,
        attempt: row.attempts,
        dead: retryAfterMs === null && dead,
        retry_after_ms: retryAfterMs,
        message,
      });
      return { queued: retryAfterMs !== null || !dead, dead: retryAfterMs === null && dead };
    }
  }

  private async deferWithoutAttempt(id: string, waitMs: number): Promise<void> {
    await this.db.withSystemScope("telegram.outbox.rate_limit", async () =>
      await this.db.query(
        `-- tenant: system — rate limit только возвращает durable сообщение в ожидание
         UPDATE telegram_outbox
            SET status = 'retry',
                attempts = GREATEST(attempts - 1, 0),
                available_at = now() + make_interval(secs => $2),
                locked_at = NULL,
                locked_by = NULL
          WHERE id = $1 AND locked_by = $3`,
        [id, Math.max(0.001, waitMs / 1_000), this.workerId],
      ),
      { crossUser: true },
    );
  }
}

export function telegramRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : null;
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
