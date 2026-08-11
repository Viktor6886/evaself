/**
 * Когда Еве уместно выйти на связь первой.
 *
 * Решение принимает детерминированный серверный код, а не модель.
 * Причина простая: «уместно ли сейчас написать» — это вопрос о времени,
 * согласии и частоте, а не о смысле. Модель, которой доверили этот
 * вопрос, будет иногда отвечать «да» в четыре утра.
 *
 * Местное время считается через luxon и зону IANA, а не арифметикой над
 * UTC. В ночь перехода на летнее время смещение зоны меняется, и «девять
 * утра» вычисленное как «UTC плюс три» промахивается ровно в тот день,
 * когда человек особенно замечает время.
 *
 * Слот — это локальная дата и вид сообщения, а не отметка запуска.
 * Задание, выполненное дважды, попадает в один слот и второго сообщения
 * не порождает (требование 10 шага 8).
 */

import { DateTime } from "luxon";

import { isValidIanaTimezone } from "../../time/local-date-time.js";

export type ProactiveKind =
  | "reminder"
  | "heartbeat"
  | "checkin_morning"
  | "checkin_evening"
  | "daily_insight"
  | "weekly_review";

export interface QuietHours {
  /** Час начала тишины в местном времени. */
  startHour: number;
  /** Час её окончания. Окно пересекает полночь, если начало больше конца. */
  endHour: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 22, endHour: 9 };

/** Как часто человек готов слышать инициативу. Приходит из его настроек. */
export type ProactiveFrequency = "normal" | "reduced" | "off";

export interface ProactiveContext {
  timezone: string;
  /** Последнее сообщение человека. Недавняя активность отменяет инициативу. */
  lastUserMessageAt: Date | null;
  /** Последнее наше проактивное сообщение этого вида. */
  lastProactiveAt: Date | null;
  /** Сколько наших сообщений подряд остались без ответа. */
  unansweredProactive: number;
  /** Согласие на инициативу. Выключено — молчим независимо от прочего. */
  consent: boolean;
  frequency: ProactiveFrequency;
  quietHours?: QuietHours;
  /** Незакрытая переписка: человек написал последним и ждёт ответа. */
  awaitingReply: boolean;
}

export type ProactiveDecision =
  | { send: true }
  | { send: false; reason: ProactiveSkipReason };

export type ProactiveSkipReason =
  | "consent_withheld"
  | "frequency_off"
  | "quiet_hours"
  | "recent_activity"
  | "awaiting_reply"
  | "too_soon"
  | "unanswered_previous";

/** Минимальная тишина до инициативы и минимальный интервал между сообщениями. */
const RULES: Record<ProactiveKind, { minSilenceMs: number; minIntervalMs: number; maxUnanswered: number }> = {
  reminder: {
    // Напоминание человек попросил сам: молчание и частота на него не
    // влияют, но подряд идущие дубли — влияют.
    minSilenceMs: 0,
    minIntervalMs: 60_000,
    maxUnanswered: 100,
  },
  heartbeat: {
    minSilenceMs: 6 * 3_600_000,
    minIntervalMs: 12 * 3_600_000,
    maxUnanswered: 2,
  },
  checkin_morning: {
    minSilenceMs: 0,
    minIntervalMs: 20 * 3_600_000,
    maxUnanswered: 3,
  },
  checkin_evening: {
    minSilenceMs: 0,
    minIntervalMs: 8 * 3_600_000,
    maxUnanswered: 3,
  },
  daily_insight: {
    minSilenceMs: 0,
    minIntervalMs: 20 * 3_600_000,
    maxUnanswered: 2,
  },
  weekly_review: {
    minSilenceMs: 0,
    minIntervalMs: 6 * 24 * 3_600_000,
    maxUnanswered: 2,
  },
};

/** Во сколько раз режим `reduced` растягивает интервалы. */
const REDUCED_FACTOR = 2;

export function zone(timezone: string): string {
  return isValidIanaTimezone(timezone) ? timezone : "UTC";
}

/**
 * Тихие часы в местном времени.
 *
 * Окно пересекает полночь, поэтому проверка — дизъюнкция, а не
 * сравнение с диапазоном: с 22 до 9 «час больше 22 И меньше 9» не
 * выполняется никогда.
 */
export function inQuietHours(
  timezone: string,
  now: Date,
  quiet: QuietHours = DEFAULT_QUIET_HOURS,
): boolean {
  const hour = DateTime.fromJSDate(now, { zone: zone(timezone) }).hour;
  if (quiet.startHour === quiet.endHour) return false;
  return quiet.startHour > quiet.endHour
    ? hour >= quiet.startHour || hour < quiet.endHour
    : hour >= quiet.startHour && hour < quiet.endHour;
}

export interface ProactiveSlot {
  /** Локальная дата человека в формате `YYYY-MM-DD`. */
  localDate: string;
  /** Ключ идемпотентности слота: дата, вид и, где нужно, номер попытки. */
  slotKey: string;
  timezone: string;
}

/**
 * Слот сообщения.
 *
 * У ежедневных видов слот — это местная дата: «утро вторника» бывает
 * один раз, сколько бы раз задание ни выполнилось. У heartbeat слот
 * дополнительно делится на половины суток: он не привязан к событию дня
 * и без такого деления был бы «не чаще раза в сутки», а это уже другая
 * политика.
 *
 * Недельный обзор привязан к номеру ISO-недели: воскресенье и
 * понедельник — разные недели, и без номера обзор ушёл бы дважды.
 */
export function proactiveSlot(kind: ProactiveKind, timezone: string, now: Date): ProactiveSlot {
  const tz = zone(timezone);
  const local = DateTime.fromJSDate(now, { zone: tz });
  const localDate = local.toISODate() ?? "1970-01-01";
  if (kind === "weekly_review") {
    return { localDate, slotKey: `${local.weekYear}-W${local.weekNumber}:${kind}`, timezone: tz };
  }
  if (kind === "heartbeat") {
    return {
      localDate,
      slotKey: `${localDate}:${kind}:${local.hour < 12 ? "am" : "pm"}`,
      timezone: tz,
    };
  }
  return { localDate, slotKey: `${localDate}:${kind}`, timezone: tz };
}

/**
 * Ближайшее наступление местного времени `hour:minute`.
 *
 * Переход на летнее время обрабатывается зоной, а не поправкой: если
 * такого местного времени в этот день не существует, luxon отдаёт
 * ближайшее существующее, и напоминание сдвигается на час вместо того,
 * чтобы пропасть. Обратный переход даёт местное время дважды — второе
 * попадает в тот же слот и сообщения не порождает.
 */
export function nextLocalTime(
  timezone: string,
  hour: number,
  minute: number,
  now: Date,
): Date {
  const tz = zone(timezone);
  const local = DateTime.fromJSDate(now, { zone: tz });
  let target = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (target <= local) target = target.plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
  return target.toJSDate();
}

/**
 * Решение об инициативе.
 *
 * Порядок проверок — от неотменяемого к настраиваемому: сначала
 * согласие, потом тишина, потом частота. Так причина отказа всегда
 * называет самое сильное основание, а не первое совпавшее.
 */
export function decideProactive(
  kind: ProactiveKind,
  context: ProactiveContext,
  now: Date,
): ProactiveDecision {
  if (!context.consent) return { send: false, reason: "consent_withheld" };
  if (context.frequency === "off") return { send: false, reason: "frequency_off" };

  const rules = RULES[kind];
  const factor = context.frequency === "reduced" ? REDUCED_FACTOR : 1;

  // Напоминание человек попросил сам, и тихие часы его не отменяют: он
  // сам назначил время. Остальные виды — наша инициатива, и ночью её
  // быть не должно.
  if (kind !== "reminder" && inQuietHours(context.timezone, now, context.quietHours)) {
    return { send: false, reason: "quiet_hours" };
  }

  // Человек написал последним и ждёт ответа: инициатива поверх
  // незакрытой переписки выглядит так, будто его не услышали.
  if (context.awaitingReply && kind !== "reminder") {
    return { send: false, reason: "awaiting_reply" };
  }

  if (rules.minSilenceMs > 0 && context.lastUserMessageAt) {
    const silence = now.getTime() - context.lastUserMessageAt.getTime();
    if (silence < rules.minSilenceMs * factor) return { send: false, reason: "recent_activity" };
  }

  if (context.lastProactiveAt) {
    const since = now.getTime() - context.lastProactiveAt.getTime();
    if (since < rules.minIntervalMs * factor) return { send: false, reason: "too_soon" };
  }

  // Два неотвеченных сообщения подряд — это не «человек занят», это
  // ответ. Третье не отправляется.
  if (context.unansweredProactive >= rules.maxUnanswered) {
    return { send: false, reason: "unanswered_previous" };
  }

  return { send: true };
}
