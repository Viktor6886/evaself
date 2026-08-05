/**
 * Параллельный диспетчер durable inbox.
 *
 * Прежний воркер брал ровно одну запись и держал всю очередь, пока она
 * не отработает: человек, чей ход занял двадцать секунд, останавливал
 * всех остальных. Здесь записи берутся батчем — по одной на человека — и
 * выполняются одновременно, но не сколько получится, а сколько
 * разрешено.
 *
 * Ограничений на одновременность три, и они разные по природе:
 *
 *   1. Ёмкость процесса: `concurrency`. Пул ограничен по построению,
 *      неограниченного `Promise.all` здесь нет и быть не может.
 *   2. Глобальные слоты по классам хода (`TurnSemaphores`): их делит
 *      между собой весь стенд, а не один процесс.
 *   3. Слот пользователя (`UserTurnLock`) — его берёт уже сам ход.
 *
 * Что остаётся неизменным: таблица `telegram_updates` та же, порядок
 * сообщений внутри человека строгий, а запись, которой не хватило
 * ёмкости, остаётся durable и ждёт. Выполнять ход внутри вебхука как
 * запасной путь запрещено — здесь такого пути нет.
 */

import { randomUUID } from "node:crypto";

import { EvaError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { TurnAggregator } from "../turns/aggregator.js";
import type { TurnSemaphores } from "../turns/semaphores.js";
import type { UserTurnLock } from "../turns/user-turn-lock.js";
import type { InboxRecord, InboxResult, ParallelTelegramInbox } from "./inbox.js";

export interface DispatcherOptions {
  pollMs: number;
  leaseSeconds: number;
  maxAttempts: number;
  /** Сколько ходов процесс ведёт одновременно. */
  concurrency: number;
  /** Сколько записей забирать за один заход в базу. */
  batchSize: number;
  /** Через сколько секунд вернуть запись, если не хватило слота. */
  releaseDelaySeconds?: number;
  onDead?: (record: InboxRecord, error: unknown) => Promise<void>;
}

/** Обработчик хода. Записей может быть несколько — это объединённый ход. */
export type TurnProcessor = (records: InboxRecord[]) => Promise<InboxResult>;

export class ParallelInboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private readonly workerId = `${process.pid}-${randomUUID()}`;
  private readonly inFlight = new Set<Promise<void>>();
  /** Люди, чей ход ведёт этот процесс прямо сейчас. */
  private readonly busy = new Set<number>();
  /** Сколько раз запись вернулась из-за чужой блокировки. Для наблюдения. */
  private foreignLockReleases = 0;

  constructor(
    private readonly inbox: ParallelTelegramInbox,
    private readonly processor: TurnProcessor,
    private readonly logger: Logger,
    private readonly options: DispatcherOptions,
    private readonly slots?: TurnSemaphores,
    private readonly aggregator?: TurnAggregator,
    /**
     * Слот пользователя. Диспетчеру он нужен не чтобы брать, а чтобы
     * видеть: этот же ключ держит фоновая часть сервиса и другие
     * экземпляры, и их владение из базы не видно.
     */
    private readonly lock?: UserTurnLock,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(100, this.options.pollMs));
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Дождаться уже начатых ходов и текущего опроса.
   *
   * Опрос ждём тоже: заход в базу мог уже забрать батч, и уйти раньше,
   * чем эти записи попадут в `inFlight`, значит бросить их до истечения
   * аренды.
   */
  async drain(): Promise<void> {
    while (this.polling || this.inFlight.size > 0) {
      if (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
      if (this.polling) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  get activeTurns(): number {
    return this.inFlight.size;
  }

  /** Возвраты по чужой блокировке. Растущий счётчик — признак подвисшего ключа. */
  get foreignLockCount(): number {
    return this.foreignLockReleases;
  }

  async tick(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      while (!this.stopped) {
        const capacity = this.options.concurrency - this.inFlight.size;
        if (capacity <= 0) break;
        const batch = await this.inbox.claimBatch({
          workerId: this.workerId,
          leaseSeconds: this.options.leaseSeconds,
          maxAttempts: this.options.maxAttempts,
          limit: Math.min(this.options.batchSize, capacity),
          excludeTelegramUsers: [...this.busy],
        });
        if (batch.length === 0) break;
        if (this.stopped) {
          // Сервис останавливают. Записи возвращаются в очередь сразу, а
          // не ждут истечения аренды: их никто не начинал.
          for (const record of batch) {
            await this.inbox.release(record.updateId, 0, this.workerId).catch(() => undefined);
          }
          break;
        }
        for (const record of batch) this.launch(record);
      }
    } catch (error) {
      this.logger.error("Ошибка диспетчера Telegram inbox", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
  }

  private launch(record: InboxRecord): void {
    if (record.telegramUserId !== null) this.busy.add(record.telegramUserId);
    // `catch` здесь обязателен, а не «на всякий случай»: без него любая
    // ошибка вне внутреннего try — недоступная Valkey, отказавшая база —
    // становится unhandled rejection и роняет процесс целиком.
    const work = this.runTurn(record).catch((error: unknown) => {
      this.logger.error("Ход завершился ошибкой вне обработки", {
        updateId: record.updateId,
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (record.telegramUserId !== null) this.busy.delete(record.telegramUserId);
      this.inFlight.delete(work);
    });
    this.inFlight.add(work);
  }

  private async runTurn(record: InboxRecord): Promise<void> {
    // Распределённая блокировка этого человека может быть занята не
    // нами: тот же ключ держат фоновая часть сервиса и другие
    // экземпляры. Их владение в базе не отражено, поэтому спрашиваем
    // прямо — иначе ход упёрся бы в `user_busy` и потратил попытку.
    if (record.telegramUserId !== null && this.lock) {
      // `try` здесь, а не `.catch`: синхронный бросок клиента Valkey
      // промиса не создаёт вовсе, и `.catch` его бы не поймал — запись
      // осталась бы `processing` до истечения аренды.
      let held = false;
      try {
        held = await this.lock.isLocked(record.telegramUserId);
      } catch {
        held = false;
      }
      if (held) {
        // Возврат по чужой блокировке молчаливым быть не должен: при
        // подвисшем чужом ключе запись будет крутиться «взять — вернуть»
        // каждую секунду, и без следа в логе это выглядит как тишина.
        this.foreignLockReleases += 1;
        this.logger.debug("Слот пользователя занят другим владельцем", {
          updateId: record.updateId,
          releases: this.foreignLockReleases,
        });
        await this.release(record, this.options.releaseDelaySeconds ?? 1);
        return;
      }
    }

    let slot = null;
    if (this.slots) {
      try {
        slot = await this.slots.acquire("interactive", `${this.workerId}:${record.updateId}`);
      } catch {
        slot = null;
      }
    }
    if (this.slots && !slot) {
      // Свободного слота нет — или Valkey недоступна. Запись
      // возвращается в очередь, попытка ей не засчитывается: её ничто
      // не обрабатывало.
      await this.release(record, this.options.releaseDelaySeconds ?? 1);
      return;
    }

    let records = [record];
    try {
      if (this.aggregator) {
        const aggregated = await this.aggregator.collect(record, {
          workerId: this.workerId,
          maxAttempts: this.options.maxAttempts,
        });
        records = aggregated.records;
      }
      const result = await this.processor(records);
      // Квота у объединённого хода снимается один раз, и флаг списания
      // достаётся той записи, на которую ход отвечает, — последней.
      // Иначе аналитика по строкам указывала бы не на то сообщение.
      const answered = records[records.length - 1]!;
      await this.inbox.complete(answered.updateId, result);
      for (const extra of records) {
        if (extra.updateId === answered.updateId) continue;
        await this.inbox.complete(extra.updateId, { status: result.status, usageCharged: false });
      }
    } catch (error) {
      await this.failTurn(records, error);
    } finally {
      await slot?.release().catch(() => undefined);
    }
  }

  /** Вернуть запись в очередь, не потратив попытку. */
  private async release(record: InboxRecord, delaySeconds: number): Promise<void> {
    await this.inbox
      .release(record.updateId, delaySeconds, this.workerId)
      .catch((error: unknown) => {
        this.logger.warn("Не удалось вернуть запись в очередь", {
          updateId: record.updateId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async failTurn(records: InboxRecord[], error: unknown): Promise<void> {
    const primary = records[0]!;
    // `user_busy` — это «слот занят», а не «ход не удался». Тратить на
    // него попытку значит убивать сообщение за чужую занятость: пять
    // попыток с их backoff укладываются в секунды, а чужой ход может
    // идти минуты.
    if (error instanceof EvaError && error.code === "user_busy") {
      for (const record of records) {
        await this.release(record, this.options.releaseDelaySeconds ?? 1);
      }
      return;
    }
    // Присоединённые сообщения возвращаются в очередь целыми: ход не
    // состоялся, и терять их из-за чужой неудачной попытки нельзя.
    for (const extra of records.slice(1)) {
      await this.release(extra, 0);
    }
    const outcome = await this.inbox
      .fail(primary.updateId, error, primary.attempts, this.options.maxAttempts)
      .catch((failure: unknown) => {
        this.logger.error("Не удалось записать отказ хода", {
          updateId: primary.updateId,
          message: failure instanceof Error ? failure.message : String(failure),
        });
        return { dead: false };
      });
    this.logger.error("Ошибка обработки Telegram update", {
      updateId: primary.updateId,
      attempt: primary.attempts,
      dead: outcome.dead,
      message: error instanceof Error ? error.message : String(error),
    });
    if (outcome.dead) {
      await this.options.onDead?.(primary, error).catch((notificationError) => {
        this.logger.warn("Не удалось поставить уведомление о dead update в outbox", {
          updateId: primary.updateId,
          message: notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
        });
      });
    }
  }
}
