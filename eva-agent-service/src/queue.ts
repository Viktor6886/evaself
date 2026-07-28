/**
 * Per-user message serialisation.
 *
 * A Letta conversation processes one turn at a time; Telegram delivers
 * bursts. Two layers keep that safe:
 *
 *   1. A Valkey lock keyed by Telegram ID, so two *service instances* (or a
 *      restarted one) cannot run turns for the same person concurrently. It
 *      is released with a compare-and-delete script, so a lock that expired
 *      and was re-taken by someone else is never deleted by the old owner.
 *
 *   2. An in-process FIFO queue per user, so a burst that arrives at one
 *      instance is processed in order instead of being rejected — up to
 *      `maxQueueDepth`, after which the caller gets a retryable `user_busy`.
 */

import type { Redis } from "ioredis";
import { userBusy } from "./errors.js";

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export interface QueueOptions {
  ttlSeconds: number;
  maxQueueDepth?: number;
  keyPrefix?: string;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class UserQueue {
  private readonly ttl: number;
  private readonly maxQueueDepth: number;
  private readonly prefix: string;
  /** telegramId -> waiters queued behind the running turn */
  private readonly local = new Map<number, Waiter[]>();
  private readonly running = new Set<number>();

  private readonly redis: Redis;

  constructor(redis: Redis, options: QueueOptions) {
    this.redis = redis;
    this.ttl = options.ttlSeconds;
    this.maxQueueDepth = options.maxQueueDepth ?? 3;
    this.prefix = options.keyPrefix ?? "eva:lock:user:";
  }

  private key(telegramId: number): string {
    return `${this.prefix}${telegramId}`;
  }

  /** Run `work` with the user's slot held, queueing locally if needed. */
  async run<T>(telegramId: number, work: () => Promise<T>): Promise<T> {
    await this.enterLocalQueue(telegramId);
    let token: string | null = null;
    try {
      token = await this.acquireDistributedLock(telegramId);
      return await work();
    } finally {
      if (token) await this.releaseDistributedLock(telegramId, token);
      this.leaveLocalQueue(telegramId);
    }
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

  private async acquireDistributedLock(telegramId: number): Promise<string> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const acquired = await this.redis.set(this.key(telegramId), token, "EX", this.ttl, "NX");
    if (acquired) return token;

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
      // A failed release is not fatal: the lock expires on its own.
    }
  }

  /** Operator escape hatch, exposed as POST /v1/locks/{telegram_id}/release. */
  async forceRelease(telegramId: number): Promise<boolean> {
    const removed = await this.redis.del(this.key(telegramId));
    return removed > 0;
  }

  async isLocked(telegramId: number): Promise<boolean> {
    return (await this.redis.exists(this.key(telegramId))) > 0;
  }

  get queuedUsers(): number {
    return this.local.size;
  }
}
