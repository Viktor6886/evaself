/**
 * Сколько ждать, когда попросили подождать.
 *
 * Пауза приходит тремя разными способами, и все три встречаются в
 * жизни: `retry_after` в теле ответа Telegram, заголовок `Retry-After`
 * числом секунд и тот же заголовок датой в формате HTTP-date. Считать
 * их в трёх местах по-разному значит однажды разойтись.
 *
 * Ко всякой паузе добавляется небольшой случайный jitter. Без него
 * реплики, получившие 429 одновременно, проснутся тоже одновременно и
 * повторят залп, из-за которого их и попросили подождать.
 */

/** Верхняя граница здравого смысла: сутки ожидания — это не пауза, а отказ. */
const MAX_WAIT_SECONDS = 86_400;

export interface RetryAfterSource {
  /** Тело ответа Telegram: `parameters.retry_after`. */
  body?: unknown;
  /** Значение заголовка `Retry-After`. */
  header?: string | null;
  /** Момент, от которого считается HTTP-date. Вынесен ради тестов. */
  now?: number;
}

/**
 * Секунды ожидания или `null`, если подождать не просили.
 *
 * Ноль — это тоже ответ: «можно сразу». Он отличается от `null`, и
 * различие важно, потому что `retry_after: 0` от Telegram означает, что
 * лимит уже отпустил, а отсутствие поля — что причина не в лимите.
 */
export function parseRetryAfter(source: RetryAfterSource): number | null {
  const fromBody = retryAfterFromBody(source.body);
  if (fromBody !== null) return fromBody;
  return retryAfterFromHeader(source.header ?? null, source.now ?? Date.now());
}

function retryAfterFromBody(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const parameters = record.parameters;
  const direct = record.retry_after;
  const nested =
    parameters && typeof parameters === "object"
      ? (parameters as Record<string, unknown>).retry_after
      : undefined;
  for (const value of [nested, direct]) {
    if (typeof value === "number" && Number.isFinite(value)) return clamp(value);
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return clamp(parsed);
    }
  }
  return null;
}

function retryAfterFromHeader(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;
  // Числовая форма проверяется первой: она однозначна, а `Date.parse`
  // на строке «120» в некоторых движках даёт год 120-й.
  if (/^\d+(\.\d+)?$/.test(value)) return clamp(Number(value));
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return clamp((at - now) / 1000);
}

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, seconds));
}

/**
 * Пауза с разбросом.
 *
 * Разброс только вверх: ждать меньше, чем попросили, — значит не
 * выполнить просьбу. Доля намеренно небольшая; смысл в том, чтобы
 * развести реплики, а не в том, чтобы ждать дольше.
 */
export function withJitter(seconds: number, ratio = 0.15, random = Math.random): number {
  if (seconds <= 0) return 0;
  const spread = seconds * Math.max(0, ratio);
  return Math.round((seconds + random() * spread) * 1000) / 1000;
}

/**
 * Стоит ли ждать или пора идти к резерву.
 *
 * Ожидание дольше предела — это отказ, замаскированный под задержку:
 * человек, которому ответ придёт через три минуты, уже не считает это
 * ответом. Резервный провайдер хуже основного, но он есть сейчас.
 */
export function waitExceedsBudget(seconds: number, budgetSeconds: number): boolean {
  return seconds > Math.max(0, budgetSeconds);
}
