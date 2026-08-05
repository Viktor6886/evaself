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

import type { Logger } from "../logger.js";
import type { TurnAggregator } from "../turns/aggregator.js";
import type { TurnSemaphores } from "../turns/semaphores.js";
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

  constructor(
    private readonly inbox: ParallelTelegramInbox,
    private readonly processor: TurnProcessor,
    private readonly logger: Logger,
    private readonly options: DispatcherOptions,
    private readonly slots?: TurnSemaphores,
    private readonly aggregator?: TurnAggregator,
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

  /** Дождаться уже начатых ходов. Нужно остановке и тестам. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  get activeTurns(): number {
    return this.inFlight.size;
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
    const work = this.runTurn(record).finally(() => {
      if (record.telegramUserId !== null) this.busy.delete(record.telegramUserId);
      this.inFlight.delete(work);
    });
    this.inFlight.add(work);
  }

  private async runTurn(record: InboxRecord): Promise<void> {
    const slot = this.slots
      ? await this.slots.acquire("interactive", `${this.workerId}:${record.updateId}`)
      : null;
    if (this.slots && !slot) {
      // Свободного слота нет. Запись возвращается в очередь, попытка ей
      // не засчитывается: её ничто не обрабатывало.
      await this.inbox.release(record.updateId, this.options.releaseDelaySeconds ?? 1);
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
      // Квота у объединённого хода снимается один раз, поэтому флаг
      // списания достаётся первой записи, а остальные закрываются как
      // часть того же хода.
      await this.inbox.complete(records[0]!.updateId, result);
      for (const extra of records.slice(1)) {
        await this.inbox.complete(extra.updateId, { status: result.status, usageCharged: false });
      }
    } catch (error) {
      await this.failTurn(records, error);
    } finally {
      await slot?.release();
    }
  }

  private async failTurn(records: InboxRecord[], error: unknown): Promise<void> {
    const primary = records[0]!;
    // Присоединённые сообщения возвращаются в очередь целыми: ход не
    // состоялся, и терять их из-за чужой неудачной попытки нельзя.
    for (const extra of records.slice(1)) {
      await this.inbox.release(extra.updateId, 0).catch(() => undefined);
    }
    const outcome = await this.inbox.fail(
      primary.updateId,
      error,
      primary.attempts,
      this.options.maxAttempts,
    );
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
