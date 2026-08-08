/**
 * Provider rate and concurrency limits.
 *
 * ProviderLimits preserves the old process-local rollback path.
 * ValkeyRouterLimits atomically reserves the same capacity across router
 * replicas and expires in-flight reservations after a crashed worker.
 */

interface Window {
  /** Метки времени запросов в текущем окне. */
  requests: number[];
  /** [метка времени, токены] в текущем окне. */
  tokens: Array<[number, number]>;
  inFlight: number;
}

const MINUTE_MS = 60_000;

export type LimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: "rpm" | "tpm" | "concurrency" };

export class ProviderLimits {
  private readonly windows = new Map<string, Window>();

  private window(providerId: string): Window {
    let window = this.windows.get(providerId);
    if (!window) {
      window = { requests: [], tokens: [], inFlight: 0 };
      this.windows.set(providerId, window);
    }
    return window;
  }

  private prune(window: Window, now: number): void {
    const cutoff = now - MINUTE_MS;
    while (window.requests.length && window.requests[0]! <= cutoff) window.requests.shift();
    while (window.tokens.length && window.tokens[0]![0] <= cutoff) window.tokens.shift();
  }

  check(
    providerId: string,
    limits: { max_rpm: number | null; max_tpm: number | null; max_concurrency: number },
    estimatedTokens: number,
    now = Date.now(),
  ): LimitVerdict {
    const window = this.window(providerId);
    this.prune(window, now);

    if (window.inFlight >= limits.max_concurrency) {
      return { allowed: false, reason: "concurrency" };
    }
    if (limits.max_rpm !== null && window.requests.length >= limits.max_rpm) {
      return { allowed: false, reason: "rpm" };
    }
    if (limits.max_tpm !== null) {
      const used = window.tokens.reduce((sum, [, value]) => sum + value, 0);
      if (used + estimatedTokens > limits.max_tpm) {
        return { allowed: false, reason: "tpm" };
      }
    }
    return { allowed: true };
  }

  /** Резервирует слот. Возвращает функцию освобождения. */
  acquire(providerId: string, estimatedTokens: number, now = Date.now()): () => void {
    const window = this.window(providerId);
    window.inFlight += 1;
    window.requests.push(now);
    window.tokens.push([now, estimatedTokens]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      window.inFlight = Math.max(0, window.inFlight - 1);
    };
  }

  /** Уточняет расход токенов по фактическому usage. */
  settle(providerId: string, actualTokens: number, now = Date.now()): void {
    const window = this.window(providerId);
    const last = window.tokens[window.tokens.length - 1];
    if (last && now - last[0] < MINUTE_MS) last[1] = actualTokens;
  }

  snapshot(providerId: string, now = Date.now()): { rpm: number; tpm: number; inFlight: number } {
    const window = this.window(providerId);
    this.prune(window, now);
    return {
      rpm: window.requests.length,
      tpm: window.tokens.reduce((sum, [, value]) => sum + value, 0),
      inFlight: window.inFlight,
    };
  }
}

export interface LimitConfig {
  max_rpm: number | null;
  max_tpm: number | null;
  max_concurrency: number;
}

export interface RouterLimitInput {
  providerId: string;
  model: string;
  route: string;
  limits: LimitConfig;
  estimatedTokens: number;
  reservationTtlMs: number;
  reservationId: string;
}

export interface RouterLimitReservation {
  settle(actualTokens: number): Promise<void>;
  release(): Promise<void>;
}

export type RouterLimitResult =
  | { allowed: false; reason: "rpm" | "tpm" | "concurrency" }
  | { allowed: true; reservation: RouterLimitReservation };

export interface RouterLimits {
  reserve(input: RouterLimitInput): Promise<RouterLimitResult>;
}

/** Compatibility path used while EVA_DISTRIBUTED_LIMITS is disabled. */
export class LocalRouterLimits implements RouterLimits {
  private readonly limits = new ProviderLimits();

  async reserve(input: RouterLimitInput): Promise<RouterLimitResult> {
    const verdict = this.limits.check(
      input.providerId,
      input.limits,
      input.estimatedTokens,
    );
    if (!verdict.allowed) return verdict;
    const release = this.limits.acquire(input.providerId, input.estimatedTokens);
    let released = false;
    return {
      allowed: true,
      reservation: {
        settle: async (actualTokens) => {
          this.limits.settle(input.providerId, actualTokens);
        },
        release: async () => {
          if (released) return;
          released = true;
          release();
        },
      },
    };
  }
}

type RedisLike = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local cutoff = now - 60000
local estimated = tonumber(ARGV[2])
local reservation = ARGV[12]
local reservation_ttl = tonumber(ARGV[13])

for dimension = 0, 2 do
  local offset = dimension * 3
  local max_rpm = tonumber(ARGV[3 + offset])
  local max_tpm = tonumber(ARGV[4 + offset])
  local max_concurrency = tonumber(ARGV[5 + offset])
  local requests = KEYS[offset + 1]
  local tokens = KEYS[offset + 2]
  local inflight = KEYS[offset + 3]
  local expired = redis.call('ZRANGEBYSCORE', requests, '-inf', cutoff)
  for _, member in ipairs(expired) do redis.call('HDEL', tokens, member) end
  redis.call('ZREMRANGEBYSCORE', requests, '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', inflight, '-inf', now)

  if redis.call('ZCARD', inflight) >= max_concurrency then return 'concurrency' end
  if max_rpm >= 0 and redis.call('ZCARD', requests) >= max_rpm then return 'rpm' end
  if max_tpm >= 0 then
    local used = 0
    for _, value in ipairs(redis.call('HVALS', tokens)) do used = used + tonumber(value) end
    if used + estimated > max_tpm then return 'tpm' end
  end
end

for dimension = 0, 2 do
  local offset = dimension * 3
  redis.call('ZADD', KEYS[offset + 1], now, reservation)
  redis.call('HSET', KEYS[offset + 2], reservation, estimated)
  redis.call('ZADD', KEYS[offset + 3], now + reservation_ttl, reservation)
  redis.call('PEXPIRE', KEYS[offset + 1], 60000 + reservation_ttl)
  redis.call('PEXPIRE', KEYS[offset + 2], 60000 + reservation_ttl)
  redis.call('PEXPIRE', KEYS[offset + 3], 60000 + reservation_ttl)
end
return 'ok'
`;

const SETTLE_SCRIPT = `
for dimension = 0, 2 do
  local requests = KEYS[dimension * 2 + 1]
  local tokens = KEYS[dimension * 2 + 2]
  -- A request longer than the sliding minute may already have been pruned.
  -- Do not resurrect an orphan token entry without its timestamp.
  if redis.call('ZSCORE', requests, ARGV[1]) then
    redis.call('HSET', tokens, ARGV[1], ARGV[2])
  end
end
return 1
`;

const RELEASE_SCRIPT = `
for index = 1, 3 do redis.call('ZREM', KEYS[index], ARGV[1]) end
return 1
`;

/**
 * One atomic reservation across provider, provider/model and route scopes.
 * A lease in the in-flight sorted sets expires after a worker crash; RPM/TPM
 * entries live only for the sliding minute.
 */
export class ValkeyRouterLimits implements RouterLimits {
  constructor(
    private readonly redis: RedisLike,
    private readonly routeLimits: LimitConfig = {
      max_rpm: 600,
      max_tpm: 2_000_000,
      max_concurrency: 64,
    },
  ) {}

  async reserve(input: RouterLimitInput): Promise<RouterLimitResult> {
    const prefixes = [
      `eva:router:limit:provider:${safeKey(input.providerId)}`,
      `eva:router:limit:model:${safeKey(input.providerId)}:${safeKey(input.model)}`,
      `eva:router:limit:route:${safeKey(input.route)}`,
    ];
    const keys = prefixes.flatMap((prefix) => [
      `${prefix}:requests`, `${prefix}:tokens`, `${prefix}:inflight`,
    ]);
    const result = String(await this.redis.eval(
      RESERVE_SCRIPT,
      keys.length,
      ...keys,
      Date.now(),
      Math.max(0, Math.ceil(input.estimatedTokens)),
      input.limits.max_rpm ?? -1,
      input.limits.max_tpm ?? -1,
      Math.max(1, input.limits.max_concurrency),
      input.limits.max_rpm ?? -1,
      input.limits.max_tpm ?? -1,
      Math.max(1, input.limits.max_concurrency),
      this.routeLimits.max_rpm ?? -1,
      this.routeLimits.max_tpm ?? -1,
      Math.max(1, this.routeLimits.max_concurrency),
      input.reservationId,
      Math.max(1_000, input.reservationTtlMs),
    ));
    if (result !== "ok") {
      const reason = result === "rpm" || result === "tpm" || result === "concurrency"
        ? result
        : "concurrency";
      return { allowed: false, reason };
    }

    let released = false;
    return {
      allowed: true,
      reservation: {
        settle: async (actualTokens) => {
          await this.redis.eval(
            SETTLE_SCRIPT,
            6,
            keys[0]!, keys[1]!, keys[3]!, keys[4]!, keys[6]!, keys[7]!,
            input.reservationId,
            Math.max(0, Math.ceil(actualTokens)),
          );
        },
        release: async () => {
          if (released) return;
          released = true;
          await this.redis.eval(
            RELEASE_SCRIPT,
            3,
            keys[2]!, keys[5]!, keys[8]!,
            input.reservationId,
          );
        },
      },
    };
  }
}

function safeKey(value: string): string {
  return encodeURIComponent(value).slice(0, 240);
}
