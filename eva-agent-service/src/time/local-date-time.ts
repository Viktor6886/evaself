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

/**
 * Converts a local ISO date/time to UTC. An explicit offset/Z in the value is
 * authoritative; otherwise the persisted user timezone is applied with DST.
 */
/**
 * Привести к ISO то, что человек и модель пишут как дату.
 *
 * Строгий ISO — договор, а не привычка: модель регулярно присылает
 * «2026-08-20 10:09» с пробелом вместо `T`, время без секунд или
 * «10:09» одним временем без даты. Отказывать на этом — значит терять
 * напоминание из-за формы записи, а не из-за смысла: человек попросил
 * напомнить, и «инструмент вернул ошибку» он читает как «Ева не может».
 *
 * Разбор остаётся детерминированным: никакого угадывания смысла, только
 * приведение известных написаний к одному виду.
 */
function normalizeIsoish(value: string, now: DateTime): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  // Пробел вместо `T` — самая частая запись.
  const separated = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(trimmed)
    ? trimmed.replace(" ", "T")
    : trimmed;
  // Одно время без даты: ближайшее наступление сегодня или завтра.
  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(separated);
  if (timeOnly) {
    const candidate = now.set({
      hour: Number(timeOnly[1]),
      minute: Number(timeOnly[2]),
      second: Number(timeOnly[3] ?? 0),
      millisecond: 0,
    });
    const target = candidate <= now ? candidate.plus({ days: 1 }) : candidate;
    return target.toISO({ suppressMilliseconds: true })!;
  }
  return separated;
}

export function localDateTimeToUtc(value: string, timezone: string): string {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`Некорректный часовой пояс IANA: ${timezone}`);
  }
  const now = DateTime.now().setZone(timezone);
  const normalized = normalizeIsoish(value, now);
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  const parsed = hasExplicitOffset
    ? DateTime.fromISO(normalized, { setZone: true })
    : DateTime.fromISO(normalized, { zone: timezone });
  if (!parsed.isValid) {
    // Ошибка называет и ожидаемый вид, и текущее местное время: без
    // второго модель не может исправиться, потому что не знает, от чего
    // считать.
    throw new Error(
      `Не разобрать дату «${value.slice(0, 40)}». Ожидается местное время вида `
      + `2026-08-20T10:09 (сейчас у пользователя ${now.toISO({ suppressMilliseconds: true })}); `
      + "для «через N минут» есть отдельное поле",
    );
  }
  return parsed.toUTC().toISO({ suppressMilliseconds: true })!;
}
