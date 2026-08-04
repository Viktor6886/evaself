import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { TelegramUpdate } from "../telegram.js";

export type InboxTerminalStatus = "completed" | "ignored";

export interface InboxResult {
  status: InboxTerminalStatus;
  usageCharged?: boolean;
}

export interface InboxRecord {
  updateId: number;
  payload: TelegramUpdate;
  attempts: number;
  chatId: number | null;
  telegramUserId: number | null;
}

export interface TelegramInbox {
  enqueue(update: TelegramUpdate): Promise<{ accepted: boolean; duplicate: boolean }>;
  claim(workerId: string, leaseSeconds: number, maxAttempts: number): Promise<InboxRecord | null>;
  complete(updateId: number, result: InboxResult): Promise<void>;
  fail(
    updateId: number,
    error: unknown,
    attempts: number,
    maxAttempts: number,
  ): Promise<{ dead: boolean }>;
}

interface InboxRow {
  update_id: string;
  payload: TelegramUpdate;
  attempts: number;
  chat_id: string | null;
  telegram_user_id: string | null;
}

export class PostgresTelegramInbox implements TelegramInbox {
  constructor(private readonly db: Database) {}

  async enqueue(update: TelegramUpdate): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (!Number.isSafeInteger(update.update_id)) {
      return { accepted: false, duplicate: false };
    }
    const message = update.message ?? update.edited_message;
    const isCommand = /^\/[a-z_]+(?:@\w+)?(?:\s|$)/i.test(message?.text?.trim() ?? "");
    const kind = message?.voice || message?.audio
      ? "voice"
      : message?.photo?.length
        ? "image"
        : message?.document
          ? "document"
          : message?.text || message?.caption
            ? "text"
            : "unsupported";
    const { rowCount } = await this.db.query(
      `
        -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
        INSERT INTO telegram_updates
         (update_id, telegram_user_id, chat_id, message_id, message_kind,
          status, billable, payload, available_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7::jsonb, now())
       ON CONFLICT (update_id) DO NOTHING`,
      [
        update.update_id,
        message?.from?.id ?? null,
        message?.chat.id ?? null,
        message?.message_id ?? null,
        kind,
        Boolean(message?.from && !message.from.is_bot && kind !== "unsupported" && !isCommand),
        JSON.stringify(update),
      ],
    );
    return { accepted: true, duplicate: rowCount === 0 };
  }

  async claim(
    workerId: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<InboxRecord | null> {
    return await this.db.transaction(async (client) => {
      await client.query(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_updates
            SET status = 'dead',
                completed_at = now(),
                last_error = COALESCE(last_error, 'worker lease expired after final attempt'),
                locked_at = NULL,
                locked_by = NULL
          WHERE status = 'processing'
            AND attempts >= $2
            AND locked_at < now() - make_interval(secs => $1)`,
        [Math.max(30, leaseSeconds), Math.max(1, maxAttempts)],
      );
      const { rows } = await client.query<InboxRow>(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          SELECT update_id, payload, attempts, chat_id, telegram_user_id
           FROM telegram_updates
          WHERE attempts < $2
            AND payload IS NOT NULL
            AND (
              (status IN ('queued', 'retry') AND available_at <= now())
              OR
              (status = 'processing'
                AND locked_at < now() - make_interval(secs => $1))
            )
          ORDER BY received_at, update_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [Math.max(30, leaseSeconds), Math.max(1, maxAttempts)],
      );
      const row = rows[0];
      if (!row) return null;
      await client.query(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_updates
            SET status = 'processing',
                attempts = attempts + 1,
                locked_at = now(),
                locked_by = $2,
                last_error = NULL
          WHERE update_id = $1`,
        [row.update_id, workerId],
      );
      return {
        updateId: Number(row.update_id),
        payload: row.payload,
        attempts: row.attempts + 1,
        chatId: row.chat_id === null ? null : Number(row.chat_id),
        telegramUserId: row.telegram_user_id === null ? null : Number(row.telegram_user_id),
      };
    });
  }

  async complete(updateId: number, result: InboxResult): Promise<void> {
    await this.db.query(
      `
        -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
        UPDATE telegram_updates
          SET status = $2,
              usage_charged = usage_charged OR $3,
              error_code = NULL,
              error_message = NULL,
              last_error = NULL,
              completed_at = now(),
              locked_at = NULL,
              locked_by = NULL
        WHERE update_id = $1`,
      [updateId, result.status, result.usageCharged ?? false],
    );
  }

  async fail(
    updateId: number,
    error: unknown,
    attempts: number,
    maxAttempts: number,
  ): Promise<{ dead: boolean }> {
    const dead = attempts >= maxAttempts;
    const message = error instanceof Error ? error.message : String(error);
    const backoffSeconds = Math.min(300, Math.max(2, 2 ** Math.max(0, attempts - 1)));
    await this.db.query(
      `
        -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
        UPDATE telegram_updates
          SET status = $2,
              available_at = CASE
                WHEN $2 = 'retry' THEN now() + make_interval(secs => $3)
                ELSE available_at
              END,
              error_code = 'workflow_failed',
              error_message = $4,
              last_error = $4,
              completed_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END,
              locked_at = NULL,
              locked_by = NULL
        WHERE update_id = $1`,
      [updateId, dead ? "dead" : "retry", backoffSeconds, message.slice(0, 2_000)],
    );
    return { dead };
  }
}

export class TelegramInboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = `${process.pid}-${randomUUID()}`;

  constructor(
    private readonly inbox: TelegramInbox,
    private readonly processor: (update: TelegramUpdate) => Promise<InboxResult>,
    private readonly logger: Logger,
    private readonly options: {
      pollMs: number;
      leaseSeconds: number;
      maxAttempts: number;
      onDead?: (record: InboxRecord, error: unknown) => Promise<void>;
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

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let processed = 0; processed < 20; processed += 1) {
        const record = await this.inbox.claim(
          this.workerId,
          this.options.leaseSeconds,
          this.options.maxAttempts,
        );
        if (!record) break;
        try {
          const result = await this.processor(record.payload);
          await this.inbox.complete(record.updateId, result);
        } catch (error) {
          const outcome = await this.inbox.fail(
            record.updateId,
            error,
            record.attempts,
            this.options.maxAttempts,
          );
          this.logger.error("Ошибка обработки Telegram update", {
            updateId: record.updateId,
            attempt: record.attempts,
            dead: outcome.dead,
            message: error instanceof Error ? error.message : String(error),
          });
          if (outcome.dead) {
            await this.options.onDead?.(record, error).catch((notificationError) => {
              this.logger.warn("Не удалось поставить уведомление о dead update в outbox", {
                updateId: record.updateId,
                message: notificationError instanceof Error
                  ? notificationError.message
                  : String(notificationError),
              });
            });
          }
        }
      }
    } catch (error) {
      this.logger.error("Ошибка Telegram inbox worker", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
