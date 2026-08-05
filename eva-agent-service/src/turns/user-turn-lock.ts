/**
 * Блокировка хода пользователя.
 *
 * Развитие прежнего `UserQueue` (инвариант 11): та же пара Lua-скриптов
 * — compare-and-delete на освобождении и compare-and-renew на продлении,
 * — тот же per-user FIFO в процессе, но владение блокировкой перестало
 * быть безымянной строкой. Теперь в значении ключа лежит, кто именно
 * держит слот: пользователь, conversation, ход, процесс и срок аренды.
 * Без этого вопрос «кто держит блокировку прямо сейчас» отвечался только
 * догадкой, а с параллельным диспетчером таких вопросов становится
 * больше, а не меньше.
 *
 * Два слоя, как и раньше:
 *
 *   1. Блокировка в Valkey по Telegram ID, чтобы два процесса (или один
 *      перезапущенный) не вели ходы одного человека одновременно.
 *   2. FIFO в процессе, чтобы пачка сообщений, пришедшая на один
 *      экземпляр, обрабатывалась по порядку, а не отвергалась — до
 *      `maxQueueDepth`, после которого вызывающий получает `user_busy`.
 *
 * Почему значение ключа неизменяемо. Продление делает только `EXPIRE`, а
 * записанный payload не переписывает. Перезапись означала бы, что токен
 * владельца меняется на ходу: освобождение, начатое до продления, ушло
 * бы со старым токеном и молча не сработало, а блокировка висела бы до
 * истечения аренды. Актуальный срок читается из TTL ключа, а не из
 * payload — там он записан как исходный, чтобы было видно, с чем ход
 * начинался.
 */

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

import { userBusy } from "../errors.js";

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * Продлить аренду, только пока она всё ещё наша. Блокировка, которая
 * истекла и была взята другим воркером, не должна оживать по таймеру
 * прежнего владельца.
 */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface UserTurnLockOptions {
  ttlSeconds: number;
  maxQueueDepth?: number;
  keyPrefix?: string;
}

/** Кто держит блокировку. Ровно это лежит в значении ключа Valkey. */
export interface TurnLockOwner {
  token: string;
  pid: number;
  telegramId: number;
  userId: number | null;
  conversationId: string | null;
  runId: string | null;
  leaseSeconds: number;
  acquiredAt: string;
}

/** Чем ход представляется блокировке. Всё необязательно: ход может начаться раньше, чем узнает о себе всё. */
export interface TurnLockClaim {
  userId?: number | null;
  conversationId?: string | null;
  runId?: string | null;
}

/** Сколько раз аренду продлевали — наблюдение, а не состояние. */
export interface TurnLockRenewals {
  count: number;
  lastAt: number | null;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class UserTurnLock {
  private readonly ttl: number;
  private readonly maxQueueDepth: number;
  private readonly prefix: string;
  /** telegramId -> ожидающие за уже выполняющимся ходом */
  private readonly local = new Map<number, Waiter[]>();
  private readonly running = new Set<number>();
  private readonly renewals = new Map<number, TurnLockRenewals>();

  private readonly redis: Redis;

  constructor(redis: Redis, options: UserTurnLockOptions) {
    this.redis = redis;
    this.ttl = options.ttlSeconds;
    this.maxQueueDepth = options.maxQueueDepth ?? 3;
    this.prefix = options.keyPrefix ?? "eva:lock:user:";
  }

  private key(telegramId: number): string {
    return `${this.prefix}${telegramId}`;
  }

  /**
   * Выполнить `work`, удерживая слот пользователя; при занятом слоте
   * встать в очередь в процессе.
   *
   * Аренда продлевается в фоне всё время, пока идёт `work`. Ход имеет
   * право длиться дольше TTL блокировки (таймаут хода намеренно больше),
   * и без продления блокировка истекла бы посреди ответа, позволив
   * второму воркеру начать параллельный ход в той же conversation.
   */
  async run<T>(telegramId: number, work: () => Promise<T>, claim: TurnLockClaim = {}): Promise<T> {
    await this.enterLocalQueue(telegramId);
    let token: string | null = null;
    let renewal: NodeJS.Timeout | null = null;
    try {
      token = await this.acquireDistributedLock(telegramId, claim);
      renewal = this.startRenewal(telegramId, token);
      return await work();
    } finally {
      if (renewal) clearInterval(renewal);
      if (token) await this.releaseDistributedLock(telegramId, token);
      this.renewals.delete(telegramId);
      this.leaveLocalQueue(telegramId);
    }
  }

  /** Продлевать треть TTL, но не реже раза в секунду. */
  private startRenewal(telegramId: number, token: string): NodeJS.Timeout {
    const everyMs = Math.max(Math.floor((this.ttl * 1000) / 3), 1_000);
    this.renewals.set(telegramId, { count: 0, lastAt: null });
    const timer = setInterval(() => {
      void this.redis
        .eval(RENEW_SCRIPT, 1, this.key(telegramId), token, String(this.ttl))
        .then((renewed) => {
          if (renewed !== 1) return;
          const state = this.renewals.get(telegramId);
          if (state) {
            state.count += 1;
            state.lastAt = Date.now();
          }
        })
        .catch(() => {
          // Пропущенное продление само по себе не смертельно: следующий
          // тик повторит, а таймаут хода всё равно ограничивает работу.
        });
    }, everyMs);
    timer.unref();
    return timer;
  }

  private enterLocalQueue(telegramId: number): Promise<void> {
    if (!this.running.has(telegramId)) {
      this.running.add(telegramId);
      return Promise.resolve();
    }

    const waiters = this.local.get(telegramId) ?? [];
    if (waiters.length >= this.maxQueueDepth) {
      return Promise.reject(
        userBusy(
          `too many messages from this user are already queued (${waiters.length})`,
          Math.max(this.ttl, 1),
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
      this.local.set(telegramId, waiters);
    });
  }

  private leaveLocalQueue(telegramId: number): void {
    const waiters = this.local.get(telegramId);
    const next = waiters?.shift();
    if (next) {
      if (waiters && waiters.length === 0) this.local.delete(telegramId);
      next.resolve();
      return;
    }
    this.local.delete(telegramId);
    this.running.delete(telegramId);
  }

  private async acquireDistributedLock(
    telegramId: number,
    claim: TurnLockClaim,
  ): Promise<string> {
    const owner: TurnLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      telegramId,
      userId: claim.userId ?? null,
      conversationId: claim.conversationId ?? null,
      runId: claim.runId ?? null,
      leaseSeconds: this.ttl,
      acquiredAt: new Date().toISOString(),
    };
    const value = JSON.stringify(owner);
    const acquired = await this.redis.set(this.key(telegramId), value, "EX", this.ttl, "NX");
    if (acquired) return value;

    const ttl = await this.redis.ttl(this.key(telegramId));
    throw userBusy(
      "a previous message from this user is still being processed",
      ttl > 0 ? ttl : this.ttl,
    );
  }

  private async releaseDistributedLock(telegramId: number, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, this.key(telegramId), token);
    } catch {
      // Неудачное освобождение не смертельно: блокировка истечёт сама.
    }
  }

  /** Ручной рычаг оператора, за ним стоит POST /v1/locks/{telegram_id}/release. */
  async forceRelease(telegramId: number): Promise<boolean> {
    const removed = await this.redis.del(this.key(telegramId));
    return removed > 0;
  }

  async isLocked(telegramId: number): Promise<boolean> {
    return (await this.redis.exists(this.key(telegramId))) > 0;
  }

  /**
   * Кто держит блокировку и до какого момента. Срок берётся из TTL
   * ключа: в payload записан исходный, а живёт аренда продлениями.
   */
  async describe(
    telegramId: number,
  ): Promise<(TurnLockOwner & { expiresInSeconds: number }) | null> {
    const value = await this.redis.get(this.key(telegramId));
    if (!value) return null;
    let owner: TurnLockOwner;
    try {
      owner = JSON.parse(value) as TurnLockOwner;
    } catch {
      // Значение прежнего формата: блокировка настоящая, описания нет.
      return null;
    }
    const ttl = await this.redis.ttl(this.key(telegramId));
    return { ...owner, expiresInSeconds: ttl > 0 ? ttl : 0 };
  }

  /** Сколько раз продлевали аренду этого хода. Для наблюдения. */
  renewalsOf(telegramId: number): TurnLockRenewals {
    return this.renewals.get(telegramId) ?? { count: 0, lastAt: null };
  }

  get queuedUsers(): number {
    return this.local.size;
  }

  /** Пользователи, чей ход выполняется прямо сейчас. */
  get activeUsers(): number {
    return this.running.size;
  }
}
