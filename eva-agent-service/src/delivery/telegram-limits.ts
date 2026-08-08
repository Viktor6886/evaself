/**
 * Distributed Telegram Bot API token buckets.
 *
 * PostgreSQL keeps the durable outbox; Valkey coordinates only recoverable
 * send capacity. No message body or credential enters these keys.
 */

import type { Redis } from "ioredis";

const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local global_rate = tonumber(ARGV[2])
local global_burst = tonumber(ARGV[3])
local chat_rate = tonumber(ARGV[4])
local chat_burst = tonumber(ARGV[5])

local global_cooldown = redis.call('PTTL', KEYS[3])
local chat_cooldown = redis.call('PTTL', KEYS[4])
local cooldown = math.max(global_cooldown, chat_cooldown)
if cooldown > 0 then return cooldown end

local function refill(key, rate, burst)
  local tokens = tonumber(redis.call('HGET', key, 'tokens'))
  local updated = tonumber(redis.call('HGET', key, 'updated'))
  if tokens == nil or updated == nil then return burst end
  local elapsed = math.max(0, now - updated) / 1000
  return math.min(burst, tokens + elapsed * rate)
end

local global_tokens = refill(KEYS[1], global_rate, global_burst)
local chat_tokens = refill(KEYS[2], chat_rate, chat_burst)
if global_tokens < 1 or chat_tokens < 1 then
  local global_wait = global_tokens < 1 and math.ceil((1 - global_tokens) / global_rate * 1000) or 0
  local chat_wait = chat_tokens < 1 and math.ceil((1 - chat_tokens) / chat_rate * 1000) or 0
  return math.max(global_wait, chat_wait)
end

redis.call('HSET', KEYS[1], 'tokens', global_tokens - 1, 'updated', now)
redis.call('HSET', KEYS[2], 'tokens', chat_tokens - 1, 'updated', now)
redis.call('PEXPIRE', KEYS[1], 120000)
redis.call('PEXPIRE', KEYS[2], 120000)
return 0
`;

export interface TelegramRateLimitOptions {
  globalPerSecond: number;
  globalBurst: number;
  chatPerSecond: number;
  chatBurst: number;
}

export class TelegramDeliveryLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly options: TelegramRateLimitOptions,
  ) {}

  async reserve(chatId: number, now = Date.now()): Promise<number> {
    const result = await this.redis.eval(
      ACQUIRE_SCRIPT,
      4,
      "eva:telegram:bucket:global",
      `eva:telegram:bucket:chat:${chatId}`,
      "eva:telegram:cooldown:global",
      `eva:telegram:cooldown:chat:${chatId}`,
      now,
      Math.max(0.001, this.options.globalPerSecond),
      Math.max(1, this.options.globalBurst),
      Math.max(0.001, this.options.chatPerSecond),
      Math.max(1, this.options.chatBurst),
    );
    const waitMs = Number(result);
    return Number.isFinite(waitMs) ? Math.max(0, Math.ceil(waitMs)) : 1_000;
  }

  /** Telegram retry_after is bot-wide; the chat key is a second guard. */
  async penalize(chatId: number, retryAfterMs: number): Promise<void> {
    const ttl = Math.max(1, Math.ceil(retryAfterMs));
    await Promise.all([
      this.redis.set("eva:telegram:cooldown:global", "1", "PX", ttl),
      this.redis.set(`eva:telegram:cooldown:chat:${chatId}`, "1", "PX", ttl),
    ]);
  }
}
