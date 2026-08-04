import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

export interface OutboxEnvelope {
  method: string;
  chatId: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  userId?: number;
  onMetrics?: (metrics: Partial<DeliveryMetrics>) => void;
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
    const { rows } = await this.db.query<{ id: string; status: string }>(
      `INSERT INTO telegram_outbox
         (idempotency_key, user_id, chat_id, telegram_method, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         idempotency_key = EXCLUDED.idempotency_key
       RETURNING id, status`,
      [
        idempotencyKey,
        envelope.userId ?? null,
        envelope.chatId,
        envelope.method,
        JSON.stringify(envelope.payload),
      ],
    );
    envelope.onMetrics?.({
      outboxInsertMs: elapsed(insertStarted),
    });
    const row = rows[0];
    if (!row || row.status === "sent") return { queued: false, duplicate: true };
    const claimed = await this.claimById(row.id);
    if (!claimed) return { queued: true, duplicate: true };
    return await this.deliver(claimed, envelope.onMetrics);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
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
    const { rows } = await this.db.query<OutboxRow>(
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
      RETURNING id, telegram_method, payload, attempts`,
      [id, this.workerId, Math.max(1, this.options.maxAttempts)],
    );
    return rows[0] ?? null;
  }

  private async claimNext(): Promise<OutboxRow | null> {
    return await this.db.transaction(async (client) => {
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
          SELECT id, telegram_method, payload, attempts
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
    });
  }

  private async deliver(
    row: OutboxRow,
    onMetrics?: OutboxEnvelope["onMetrics"],
  ): Promise<unknown> {
    try {
      const sendStarted = performance.now();
      const result = await this.transport.deliver(row.telegram_method, row.payload);
      const telegramSendMs = elapsed(sendStarted);
      onMetrics?.({ telegramSendMs });
      const messageIds = extractMessageIds(result);
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
      );
      this.logger.debug("Telegram outbox доставлен", {
        outboxId: row.id,
        telegram_send_ms: telegramSendMs,
      });
      return result;
    } catch (error) {
      const dead = row.attempts >= this.options.maxAttempts;
      const message = error instanceof Error ? error.message : String(error);
      const backoffSeconds = Math.min(300, Math.max(2, 2 ** Math.max(0, row.attempts - 1)));
      await this.db.query(
        `
          -- tenant: system — durable delivery: строки берутся по id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_outbox
            SET status = $2,
                available_at = CASE
                  WHEN $2 = 'retry' THEN now() + make_interval(secs => $3)
                  ELSE available_at
                END,
                last_error = $4,
                locked_at = NULL,
                locked_by = NULL
          WHERE id = $1`,
        [row.id, dead ? "dead" : "retry", backoffSeconds, message.slice(0, 2_000)],
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
