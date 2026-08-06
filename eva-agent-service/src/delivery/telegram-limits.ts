/**
 * Общие для реплик лимиты отправки в Telegram.
 *
 * У Telegram два независимых предела: сколько сообщений в секунду
 * отправляет бот вообще и сколько он отправляет в один чат. Считать их
 * в памяти процесса нельзя: две реплики, каждая в своём праве,
 * превысят общий предел вдвое и получат 429 на двоих.
 *
 * Состояние живёт в Valkey и восстановимо (инвариант 2): его потеря
 * означает, что счётчики обнулились, а не что потеряны данные. Худшее
 * следствие — короткая пачка сверх лимита и ответ 429, который здесь же
 * и обрабатывается.
 *
 * Token bucket, а не окно: он пропускает ровную скорость и позволяет
 * накопленную паузу потратить пачкой, что для доставки естественно —
 * человек, которому пришли три части ответа подряд, видит один ответ.
 */

import type { Redis } from "ioredis";

import type { Logger } from "../logger.js";

/**
 * Взять токен: долить накопленное по времени, проверить остаток,
 * списать. Всё одним скриптом — иначе две реплики, посчитавшие
 * одновременно, обе увидели бы последний токен своим.
 *
 * Возвращает 0, если токен взят, иначе — миллисекунды до следующего.
 */
const TAKE_SCRIPT = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_ms = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
local gained = (now - at) / refill_ms
if gained > 0 then
  tokens = math.min(capacity, tokens + gained)
  at = now
end
if tokens < 1 then
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'at', at)
  redis.call('PEXPIRE', KEYS[1], ttl)
  return math.ceil((1 - tokens) * refill_ms)
end
redis.call('HMSET', KEYS[1], 'tokens', tokens - 1, 'at', at)
redis.call('PEXPIRE', KEYS[1], ttl)
return 0
`;

/**
 * Пауза, назначенная самим Telegram. Она не считается, а сообщается:
 * `retry_after` в ответе 429 — единственный источник правды о том,
 * когда можно снова.
 */
const COOLDOWN_SCRIPT = `
local until_ms = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil or current < until_ms then
  redis.call('SET', KEYS[1], until_ms, 'PX', tonumber(ARGV[2]))
end
return 1
`;

export interface TelegramLimitOptions {
  /** Сообщений в секунду на бота целиком. */
  globalPerSecond: number;
  /** Сообщений в секунду в один чат. */
  chatPerSecond: number;
}

export const TELEGRAM_LIMIT_DEFAULTS: TelegramLimitOptions = {
  // Документированный предел Telegram — 30 сообщений в секунду на бота
  // и примерно одно в секунду в один чат. Берём с запасом: расплата за
  // превышение — 429 и пауза, расплата за недобор — миллисекунды.
  globalPerSecond: 25,
  chatPerSecond: 1,
};

/** Сколько ждать до следующей попытки. `0` — можно отправлять сейчас. */
export interface LimitVerdict {
  waitMs: number;
  reason: "global" | "chat" | "cooldown" | null;
}

const READY: LimitVerdict = { waitMs: 0, reason: null };

export class TelegramRateLimits {
  private readonly options: TelegramLimitOptions;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    options: Partial<TelegramLimitOptions> = {},
  ) {
    this.options = { ...TELEGRAM_LIMIT_DEFAULTS, ...options };
  }

  /**
   * Можно ли отправлять в этот чат прямо сейчас.
   *
   * Порядок проверок — от назначенной паузы к общему пределу и только
   * потом к чату: пауза от Telegram сильнее любого нашего счёта, а
   * общий предел проверяется раньше чата, чтобы не тратить чужой токен
   * на сообщение, которое всё равно не уйдёт.
   *
   * **Отказ Valkey не запрещает доставку.** Лимит — это вежливость
   * перед Telegram, а не право писать человеку: при недоступном Valkey
   * настоящей границей остаётся ответ 429, который мы умеем читать.
   */
  async take(chatId: number): Promise<LimitVerdict> {
    try {
      const now = Date.now();
      const cooldown = await this.cooldownLeft(chatId, now);
      if (cooldown > 0) return { waitMs: cooldown, reason: "cooldown" };

      const globalWait = await this.takeBucket(
        "eva:tg:rate:global",
        this.options.globalPerSecond,
        now,
      );
      if (globalWait > 0) return { waitMs: globalWait, reason: "global" };

      const chatWait = await this.takeBucket(
        `eva:tg:rate:chat:${chatId}`,
        this.options.chatPerSecond,
        now,
      );
      // Токен бота уже потрачен, а чат занят. Возвращать его не нужно:
      // потерянный токен стоит одного сообщения в секунду, а возврат
      // из скрипта сделал бы операцию неатомарной.
      if (chatWait > 0) return { waitMs: chatWait, reason: "chat" };
      return READY;
    } catch (error) {
      this.logger.warn("Лимиты Telegram недоступны, доставка продолжается", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
      return READY;
    }
  }

  /** Пауза, о которой попросил сам Telegram ответом 429. */
  async cooldown(chatId: number, seconds: number): Promise<void> {
    const ms = Math.max(0, Math.round(seconds * 1000));
    if (ms === 0) return;
    const until = Date.now() + ms;
    try {
      await this.redis.eval(
        COOLDOWN_SCRIPT,
        1,
        `eva:tg:cooldown:${chatId}`,
        String(until),
        String(ms + 1000),
      );
    } catch (error) {
      this.logger.warn("Пауза Telegram не записана", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  private async cooldownLeft(chatId: number, now: number): Promise<number> {
    const raw = await this.redis.get(`eva:tg:cooldown:${chatId}`);
    if (!raw) return 0;
    const until = Number(raw);
    return Number.isFinite(until) ? Math.max(0, until - now) : 0;
  }

  private async takeBucket(key: string, perSecond: number, now: number): Promise<number> {
    const capacity = Math.max(1, Math.floor(perSecond));
    const refillMs = Math.max(1, Math.round(1000 / capacity));
    const result = await this.redis.eval(
      TAKE_SCRIPT,
      1,
      key,
      String(now),
      String(capacity),
      String(refillMs),
      String(Math.max(2000, refillMs * capacity * 2)),
    );
    return Number(result) || 0;
  }
}
