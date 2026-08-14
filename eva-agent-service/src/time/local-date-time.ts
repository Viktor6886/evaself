import { DateTime, Duration, IANAZone } from "luxon";

export function isValidIanaTimezone(value: string): boolean {
  return IANAZone.isValidZone(value.trim());
}

export function localNow(timezone: string, now = new Date()): DateTime {
  const zone = isValidIanaTimezone(timezone) ? timezone : "UTC";
  return DateTime.fromJSDate(now, { zone });
}

/**
 * Локальная дата словами: «пятница, 14 августа 2026».
 *
 * День недели пишется явно, а не оставляется на вычисление по ISO:
 * модель считает его из даты неохотно и ошибается, а «сегодня среда»
 * в ответе — это ошибка, которую человек замечает сразу.
 */
export function localDateWithWeekday(value: DateTime, locale = "ru"): string {
  return value.setLocale(locale).toFormat("cccc, d MMMM yyyy");
}

/**
 * Короткая местная отметка: «15 августа, 04:30».
 *
 * Без года и секунд: в контексте хода она стоит рядом с местным временем
 * пользователя и служит для сверки «когда», а не для протокола.
 */
export function formatLocalShort(
  value: Date | string,
  timezone: string,
  locale = "ru",
): string {
  const source = value instanceof Date
    ? DateTime.fromJSDate(value)
    : DateTime.fromISO(value, { setZone: true });
  if (!source.isValid) throw new Error("Некорректная дата");
  return source
    .setZone(isValidIanaTimezone(timezone) ? timezone : "UTC")
    .setLocale(locale)
    .toFormat("d MMMM, HH:mm");
}

/**
 * Промежуток словами: «9 секунд», «1 час 15 минут», «3 дня 2 часа».
 *
 * Две старшие ненулевые единицы: «2 часа 15 минут» человеку понятно, а
 * «2 часа 15 минут 3 секунды» — уже отчёт. Мельче секунды промежутка не
 * бывает: сообщения не приходят в одну миллисекунду, а «0» читалось бы
 * как «времени не прошло вовсе».
 */
export function humanizeInterval(milliseconds: number, locale = "ru"): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return "меньше секунды";
  const parts = Object.entries(
    Duration.fromMillis(milliseconds).shiftTo("days", "hours", "minutes", "seconds").toObject(),
  )
    .filter(([, amount]) => Math.floor(amount ?? 0) > 0)
    .slice(0, 2)
    .map(([unit, amount]) => Duration
      .fromObject({ [unit]: Math.floor(amount ?? 0) })
      .reconfigure({ locale })
      .toHuman());
  return parts.length > 0 ? parts.join(" ") : "меньше секунды";
}

export function formatLocalDateTime(
  value: Date | string,
  timezone: string,
  locale = "ru",
): string {
  const source = value instanceof Date
    ? DateTime.fromJSDate(value)
    : DateTime.fromISO(value, { setZone: true });
  if (!source.isValid) throw new Error("Некорректная дата");
  return source
    .setZone(isValidIanaTimezone(timezone) ? timezone : "UTC")
    .setLocale(locale)
    .toLocaleString(DateTime.DATETIME_FULL_WITH_SECONDS);
}

/**
 * Converts a local ISO date/time to UTC. An explicit offset/Z in the value is
 * authoritative; otherwise the persisted user timezone is applied with DST.
 */
export function localDateTimeToUtc(value: string, timezone: string): string {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`Некорректный часовой пояс IANA: ${timezone}`);
  }
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim());
  const parsed = hasExplicitOffset
    ? DateTime.fromISO(value, { setZone: true })
    : DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) {
    throw new Error(`Некорректные локальные дата и время: ${parsed.invalidExplanation ?? value}`);
  }
  return parsed.toUTC().toISO({ suppressMilliseconds: true })!;
}
