/**
 * Разбор и вычисление cron в зоне пользователя.
 *
 * Вынесено из `background.ts` шагом 08: планировщик перестаёт быть
 * единственным потребителем этих функций — расписания заданий и
 * проактивные слоты считают то же самое, а файл на семьсот строк
 * перечитывается целиком каждой сессией, которая его касается.
 *
 * Поведение не менялось: это перенос, а не переделка. `background.ts`
 * реэкспортирует те же имена, поэтому внешние вызовы и тесты остались
 * прежними.
 */

/** A cron search never looks further ahead than this. */
const CRON_HORIZON_MS = 366 * 24 * 60 * 60_000;

/**
 * Reject a cron expression before it is ever stored.
 *
 * Every field must parse, and the whole expression must actually fire within
 * the horizon — so `0 0 30 2 *` is refused at creation time instead of
 * failing later inside the scheduler.
 */
export function assertCronExpression(expression: string, timezone: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron должен содержать пять полей");
  const bounds: Array<[number, number, boolean]> = [
    [0, 59, false],
    [0, 23, false],
    [1, 31, false],
    [1, 12, false],
    [0, 7, true],
  ];
  fields.forEach((field, index) => {
    const [min, max, sundayAlias] = bounds[index]!;
    // A field that matches nothing in its own range can never fire.
    let satisfiable = false;
    for (let value = min; value <= max; value += 1) {
      if (cronFieldMatches(field, value, min, max, sundayAlias)) {
        satisfiable = true;
        break;
      }
    }
    if (!satisfiable) throw new Error(`Cron: поле «${field}» не соответствует ни одному значению`);
  });
  // Proves the combination is reachable (and that the timezone is valid).
  nextCronDate(expression, timezone, new Date());
}

/**
 * The next moment a cron expression fires, in the given IANA timezone.
 *
 * The search skips whole days and hours instead of walking minute by minute:
 * a naive scan is up to 527 040 iterations, and — because a fresh
 * `Intl.DateTimeFormat` per iteration costs ~90 µs — used to block the event
 * loop for the better part of a minute on an expression as ordinary as
 * `0 0 1 1 *`. With coarse stepping and a cached formatter the same lookup is
 * a few hundred formatter calls.
 */
export function nextCronDate(expression: string, timezone: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron должен содержать пять полей");
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];

  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const deadline = start.getTime() + CRON_HORIZON_MS;

  let candidate = start.getTime();
  while (candidate <= deadline) {
    const parts = zonedParts(new Date(candidate), timezone);
    const dateMatches =
      cronFieldMatches(month, parts.month, 1, 12) &&
      cronFieldMatches(day, parts.day, 1, 31) &&
      cronFieldMatches(weekday, parts.weekday, 0, 7, true);

    if (!dateMatches) {
      // Jump to the start of the next local day. Always at least one minute,
      // so the loop cannot stall even across a DST transition.
      candidate += ((24 - parts.hour) * 60 - parts.minute) * 60_000;
      continue;
    }
    if (!cronFieldMatches(hour, parts.hour, 0, 23)) {
      candidate += (60 - parts.minute) * 60_000;
      continue;
    }
    if (!cronFieldMatches(minute, parts.minute, 0, 59)) {
      candidate += 60_000;
      continue;
    }
    return new Date(candidate);
  }
  throw new Error("Не удалось найти следующий запуск cron в пределах года");
}

export function cronFieldMatches(
  expression: string,
  value: number,
  min: number,
  max: number,
  sundayAlias = false,
): boolean {
  const normalizedValue = sundayAlias && value === 0 ? 0 : value;
  return expression.split(",").some((part) => {
    const [rangeRaw, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isSafeInteger(step) || step < 1) return false;
    const range = rangeRaw ?? "*";
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [left, right] = range.split("-").map(Number);
      if (left === undefined || right === undefined) return false;
      start = left;
      end = right;
    } else {
      start = Number(range);
      end = start;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      return false;
    }
    const candidate = sundayAlias && normalizedValue === 0 && start === 7 ? 7 : normalizedValue;
    return candidate >= start && candidate <= end && (candidate - start) % step === 0;
  });
}

/**
 * Constructing an `Intl.DateTimeFormat` dominates the cost of a cron search,
 * so one is built per timezone and reused. Formatters are immutable and
 * thread-safe for our purposes; the map is bounded by the number of distinct
 * user timezones.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;
  // Throws RangeError for an unknown zone — surfaced to the caller as an
  // invalid task rather than silently falling back to UTC.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  if (FORMATTERS.size < 500) FORMATTERS.set(timezone, formatter);
  return formatter;
}

function zonedParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const formatter = zonedFormatter(timezone);
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    day: Number(values.day),
    month: Number(values.month),
    weekday: weekdays[values.weekday ?? ""] ?? 0,
  };
}

export function isQuietHours(timezone: string): boolean {
  const hour = zonedParts(new Date(), timezone).hour;
  return hour >= 22 || hour < 9;
}
