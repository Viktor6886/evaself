import { tooManyRequests } from "../errors.js";

/**
 * Лимиты на публичных поверхностях.
 *
 * Публичные маршруты и webhook Telegram — единственные точки, куда можно
 * постучаться снаружи. До сих пор ограничений на них не было вовсе:
 * достаточно было цикла, чтобы занять пул подключений или сжечь квоту
 * платных провайдеров.
 *
 * Лимиты раздельные и считаются оба:
 *
 *   • по IP — грубая защита от потока запросов, работает ДО проверки
 *     подписи, потому что сама проверка тоже стоит процессорного времени;
 *   • по проверенной личности Telegram — защита от того, чтобы один
 *     пользователь исчерпал общий ресурс, зайдя с многих адресов.
 *
 * Идентификатор пользователя из тела запроса или из браузера ключом не
 * является: по нему считать бессмысленно, его подставляет клиент.
 *
 * Окно фиксированное: счётчик живёт ровно окно и обнуляется целиком.
 * Точность скользящего окна здесь не нужна, а INCR + EXPIRE — две дешёвые
 * операции без Lua.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict>;
}

type RedisLike = {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
};

const PREFIX = "eva:ratelimit:";

export class ValkeyRateLimiter implements RateLimiter {
  constructor(private readonly redis: RedisLike) {}

  async hit(
    bucket: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitVerdict> {
    if (limit <= 0) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
    }
    const key = `${PREFIX}${bucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }
    if (count <= limit) {
      return { allowed: true, remaining: limit - count, retryAfterSeconds: 0 };
    }
    // TTL может вернуть -1, если EXPIRE не успел примениться: тогда окно
    // считаем полным, а не «повторите немедленно».
    const ttl = await this.redis.ttl(key);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }
}

/**
 * Лимитер, который всегда пропускает.
 *
 * Нужен там, где Valkey недоступен по замыслу — например в тестах
 * маршрутов, которые проверяют не лимиты, а поведение обработчика.
 * В рантайме подставляется настоящий: отсутствие Valkey не должно
 * молча снимать ограничения, и это отдельно проверяется в doctor.
 */
export class NoopRateLimiter implements RateLimiter {
  async hit(): Promise<RateLimitVerdict> {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
  }
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

/**
 * Проверка лимита с понятной ошибкой.
 *
 * Сообщение намеренно не раскрывает ни фактический счётчик, ни лимит:
 * это подсказка для подбора темпа.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  bucket: string,
  rule: RateLimitRule,
): Promise<void> {
  const verdict = await limiter.hit(bucket, rule.limit, rule.windowSeconds);
  if (verdict.allowed) return;
  throw tooManyRequests(
    "Слишком много запросов — попробуйте чуть позже",
    verdict.retryAfterSeconds,
  );
}

/**
 * Ключ по адресу клиента.
 *
 * За Caddy реальный адрес приходит в X-Forwarded-For. Берётся ПЕРВЫЙ
 * элемент слева — его подставляет наш же прокси; всё остальное в цепочке
 * клиент может написать сам.
 */
export function clientAddress(
  headers: Record<string, unknown>,
  fallback: string | undefined,
): string {
  const forwarded = headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string" && raw.trim()) {
    const first = raw.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (fallback ?? "unknown").slice(0, 64);
}
