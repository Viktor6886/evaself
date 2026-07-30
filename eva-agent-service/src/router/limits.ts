/**
 * Лимиты скорости и параллелизма, считаемые в процессе.
 *
 * Это не распределённый лимитер: он защищает провайдера от превышения его
 * собственных RPM/TPM раньше, чем тот ответит 429. Настоящей границей
 * остаётся ответ провайдера — 429 обрабатывается как обычная причина
 * переключения. При нескольких репликах роутера лимит делится между ними,
 * поэтому окно намеренно скользящее и слегка консервативное.
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
