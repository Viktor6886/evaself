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

export interface ClaimBatchInput {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
  limit: number;
  /**
   * Пользователи, чей ход уже выполняется в этом процессе. Их записи в
   * батч не попадают: распределённая блокировка всё равно не пустила бы
   * второй ход, а занятая запись простояла бы в `processing` впустую.
   */
  excludeTelegramUsers?: number[];
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

/** Inbox, умеющий отдавать сразу несколько записей разных людей. */
export interface ParallelTelegramInbox extends TelegramInbox {
  claimBatch(input: ClaimBatchInput): Promise<InboxRecord[]>;
  /** Забрать следующие сообщения того же человека — для объединения быстрых сообщений. */
  claimFollowUps(input: {
    workerId: string;
    telegramUserId: number;
    afterUpdateId: number;
    maxAttempts: number;
    limit: number;
  }): Promise<InboxRecord[]>;
  /**
   * Вернуть запись в очередь, не потратив попытку: ёмкость кончилась, а
   * не обработка. `workerId` сверяет аренду: чужую запись не возвращаем.
   */
  release(updateId: number, delaySeconds: number, workerId?: string): Promise<void>;
}

interface InboxRow {
  update_id: string;
  payload: TelegramUpdate;
  attempts: number;
  chat_id: string | null;
  telegram_user_id: string | null;
}

function toRecord(row: InboxRow): InboxRecord {
  return {
    updateId: Number(row.update_id),
    payload: row.payload,
    attempts: row.attempts + 1,
    chatId: row.chat_id === null ? null : Number(row.chat_id),
    telegramUserId: row.telegram_user_id === null ? null : Number(row.telegram_user_id),
  };
}

export class PostgresTelegramInbox implements ParallelTelegramInbox {
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
    // Приём апдейта — системная запись: внутренний пользователь ещё не
    // опознан, запись хранит только проверенный Telegram-идентификатор.
    const { rowCount } = await this.db.withSystemScope(
      "telegram.inbox.enqueue",
      async () => await this.db.query(
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
      ),
    );
    return { accepted: true, duplicate: rowCount === 0 };
  }

  async claim(
    workerId: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<InboxRecord | null> {
    // Аренда очереди идёт по записям всех пользователей сразу: это
    // durable ingress сервиса, а не работа от чьего-то имени.
    return await this.db.withSystemScope("telegram.inbox.claim", async () =>
      await this.db.transaction(async (client) => {
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
      return toRecord(row);
      }),
      { crossUser: true },
    );
  }

  /**
   * Батч записей — по одной на человека.
   *
   * Условия исключения читаются как список причин, по которым запись
   * брать нельзя: у человека есть более раннее незавершённое сообщение
   * (порядок внутри человека строгий), запись завершена или мертва, срок
   * доступности не наступил, попытки исчерпаны, ход этого человека уже
   * идёт в этом процессе. Ограничение «одна запись на человека» здесь же
   * даёт справедливость: один говорливый пользователь не займёт весь
   * батч, потому что второй его записи в батче просто нет.
   */
  async claimBatch(input: ClaimBatchInput): Promise<InboxRecord[]> {
    const lease = Math.max(30, input.leaseSeconds);
    const attempts = Math.max(1, input.maxAttempts);
    const limit = Math.max(1, Math.min(100, input.limit));
    const excluded = input.excludeTelegramUsers ?? [];
    return await this.db.withSystemScope("telegram.inbox.claim_batch", async () =>
      await this.db.transaction(async (client) => {
      // Тот же sweeper, что и у последовательного claim. Без него
      // запись, у которой кончились попытки, остаётся `processing`
      // навсегда — и по правилу «более раннее незавершённое блокирует»
      // закрывает этому человеку всю очередь до конца времён.
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
        [lease, attempts],
      );
      const { rows } = await client.query<InboxRow>(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          SELECT t.update_id, t.payload, t.attempts, t.chat_id, t.telegram_user_id
            FROM telegram_updates t
           WHERE t.attempts < $2
             AND t.payload IS NOT NULL
             AND (
               (t.status IN ('queued', 'retry') AND t.available_at <= now())
               OR (t.status = 'processing'
                   AND t.locked_at < now() - make_interval(secs => $1))
             )
             -- NULL здесь не «не входит в список», а «неизвестно»:
             -- без явной ветки запись без опознанного отправителя
             -- выпадала бы из батча, стоило кому-то оказаться занятым.
             AND (t.telegram_user_id IS NULL
                  OR NOT (t.telegram_user_id = ANY($4::bigint[])))
             AND NOT EXISTS (
               SELECT 1
                 FROM telegram_updates earlier
                WHERE earlier.status IN ('queued', 'processing', 'retry')
                  AND earlier.telegram_user_id IS NOT DISTINCT FROM t.telegram_user_id
                  AND (earlier.received_at, earlier.update_id) < (t.received_at, t.update_id)
             )
           ORDER BY t.received_at, t.update_id
           FOR UPDATE OF t SKIP LOCKED
           LIMIT $3`,
        [lease, attempts, limit, excluded],
      );
      if (rows.length === 0) return [];
      await client.query(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_updates
             SET status = 'processing',
                 attempts = attempts + 1,
                 locked_at = now(),
                 locked_by = $2,
                 last_error = NULL
           WHERE update_id = ANY($1::bigint[])`,
        [rows.map((row) => row.update_id), input.workerId],
      );
      return rows.map(toRecord);
      }),
      { crossUser: true },
    );
  }

  /**
   * Следующие сообщения того же человека. Правило «более раннее
   * незавершённое сообщение блокирует» здесь не применяется намеренно:
   * это более раннее сообщение — наше собственное, оно и зовёт.
   */
  async claimFollowUps(input: {
    workerId: string;
    telegramUserId: number;
    afterUpdateId: number;
    maxAttempts: number;
    limit: number;
  }): Promise<InboxRecord[]> {
    const limit = Math.max(1, Math.min(20, input.limit));
    return await this.db.withSystemScope("telegram.inbox.claim_follow_ups", async () =>
      await this.db.transaction(async (client) => {
      const { rows } = await client.query<InboxRow>(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          SELECT t.update_id, t.payload, t.attempts, t.chat_id, t.telegram_user_id
            FROM telegram_updates t
           WHERE t.telegram_user_id = $1
             AND t.update_id > $2
             AND t.attempts < $3
             AND t.payload IS NOT NULL
             AND t.status IN ('queued', 'retry')
             AND t.available_at <= now()
           ORDER BY t.received_at, t.update_id
           FOR UPDATE OF t SKIP LOCKED
           LIMIT $4`,
        [input.telegramUserId, input.afterUpdateId, Math.max(1, input.maxAttempts), limit],
      );
      if (rows.length === 0) return [];
      await client.query(
        `
          -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
          UPDATE telegram_updates
             SET status = 'processing',
                 attempts = attempts + 1,
                 locked_at = now(),
                 locked_by = $2,
                 last_error = NULL
           WHERE update_id = ANY($1::bigint[])`,
        [rows.map((row) => row.update_id), input.workerId],
      );
      return rows.map(toRecord);
      }),
      { crossUser: true },
    );
  }

  /**
   * Вернуть запись в очередь. Попытка возвращается обратно: её потратила
   * не обработка, а нехватка ёмкости, и наказывать за это сообщение
   * человека нечестно — на третьем таком возврате оно оказалось бы
   * мёртвым, ни разу не дойдя до модели.
   */
  async release(updateId: number, delaySeconds: number, workerId?: string): Promise<void> {
    await this.db.withSystemScope("telegram.inbox.release", async () =>
      await this.db.query(
      `
        -- tenant: system — durable ingress Telegram: строки берутся по update_id и аренде воркера, а не по запросу пользователя
        UPDATE telegram_updates
           SET status = 'queued',
               attempts = GREATEST(0, attempts - 1),
               available_at = now() + make_interval(secs => $2),
               locked_at = NULL,
               locked_by = NULL
         WHERE update_id = $1
           AND status = 'processing'
           -- Возвращаем только свою аренду. Если она истекла и запись
           -- перехватил другой воркер, наш возврат сбросил бы её из-под
           -- чужой обработки — и ход выполнился бы дважды.
           AND ($3::text IS NULL OR locked_by = $3)`,
      [updateId, Math.max(0, delaySeconds), workerId ?? null],
      ),
      { crossUser: true },
    );
  }

  async complete(updateId: number, result: InboxResult): Promise<void> {
    await this.db.withSystemScope("telegram.inbox.complete", async () =>
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
      ),
      { crossUser: true },
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
    await this.db.withSystemScope("telegram.inbox.fail", async () =>
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
      ),
      { crossUser: true },
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
