import { DateTime, IANAZone } from "luxon";

export function isValidIanaTimezone(value: string): boolean {
  return IANAZone.isValidZone(value.trim());
}

export function localNow(timezone: string, now = new Date()): DateTime {
  const zone = isValidIanaTimezone(timezone) ? timezone : "UTC";
  return DateTime.fromJSDate(now, { zone });
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
