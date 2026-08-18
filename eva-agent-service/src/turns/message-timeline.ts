/**
 * Когда человек написал каждое сообщение окна.
 *
 * Быстрые сообщения одного человека объединяются в один ход
 * (`src/turns/aggregator.ts`), и до этого модуля от окна оставалось одно
 * число — сколько сообщений в нём было. Всё остальное терялось: и «эти
 * два пришли с разницей в секунду», и «между вторым и третьим прошло
 * три минуты». Без этого «пошли кушать» и через секунду «покушали»
 * выглядят как рассказ о состоявшемся обеде.
 *
 * Отметки берутся у Telegram (`message.date`, секунды epoch), а не у
 * момента обработки: между отправкой и ходом стоит durable inbox, и
 * очередь может задержать ход на минуты.
 */

import { humanizeInterval, isValidIanaTimezone } from "../time/local-date-time.js";
import { DateTime } from "luxon";

export interface MessageTiming {
  /** Порядок в окне, начиная с единицы. */
  order: number;
  /** Идентификатор сообщения Telegram: он же связывает запись с апдейтом. */
  messageId: number;
  /** Когда сообщение отправлено. */
  at: Date;
  /** Промежуток с предыдущим сообщением окна. `null` — первое в окне. */
  elapsedFromPreviousMs: number | null;
}

export interface MessageBatchTiming {
  messages: MessageTiming[];
  /** От первого сообщения окна до последнего. */
  spanMs: number;
  firstAt: Date;
  lastAt: Date;
}

interface TimedMessage {
  messageId: number;
  /** Секунды epoch, как их отдаёт Telegram. */
  date?: number;
}

/**
 * Разложить окно во времени.
 *
 * Сообщение без даты — не повод потерять весь порядок: у него берётся
 * отметка предыдущего сообщения, а у первого — переданное «сейчас».
 * Идти назад отметки не могут: Telegram присылает их в секундах, и
 * равные отметки соседних сообщений — обычное дело, а обратный ход
 * означал бы отрицательный промежуток в контексте.
 */
export function messageBatchTiming(
  messages: TimedMessage[],
  now: Date,
): MessageBatchTiming {
  const timings: MessageTiming[] = [];
  let previous: Date | null = null;
  for (const [index, message] of messages.entries()) {
    const raw = Number.isFinite(message.date) && (message.date ?? 0) > 0
      ? new Date((message.date ?? 0) * 1_000)
      : previous ?? now;
    const at: Date = previous && raw.getTime() < previous.getTime() ? previous : raw;
    timings.push({
      order: index + 1,
      messageId: message.messageId,
      at,
      elapsedFromPreviousMs: previous ? at.getTime() - previous.getTime() : null,
    });
    previous = at;
  }
  const firstAt = timings[0]?.at ?? now;
  const lastAt = timings[timings.length - 1]?.at ?? now;
  return {
    messages: timings,
    spanMs: lastAt.getTime() - firstAt.getTime(),
    firstAt,
    lastAt,
  };
}

/**
 * Окно словами для служебного блока хода.
 *
 * Одно сообщение — строк нет вовсе: рассказывать нечего, а место в
 * бюджете хода не бесплатное.
 */
export function timelineLines(batch: MessageBatchTiming, timezone: string): string[] {
  if (batch.messages.length < 2) return [];
  const zone = isValidIanaTimezone(timezone) ? timezone : "UTC";
  return batch.messages.map((message) => {
    const clock = DateTime.fromJSDate(message.at, { zone }).toFormat("HH:mm:ss");
    // Промежуток пишется знаком «плюс», а не предлогом: единицы времени
    // приходят из luxon в именительном падеже, и «через 1 секунда» —
    // это ошибка в каждом ходе. Падежи здесь не склоняются: подгонка
    // окончаний регулярками — отдельный источник ошибок.
    const gap = message.elapsedFromPreviousMs === null
      ? "начало серии"
      : `+${humanizeInterval(message.elapsedFromPreviousMs)}`;
    return `${message.order} · ${clock} · ${gap}`;
  });
}

/** Одна строка про всё окно: сколько сообщений и за какое время. */
export function batchSummary(batch: MessageBatchTiming): string | null {
  if (batch.messages.length < 2) return null;
  return `${batch.messages.length} сообщения подряд, разброс — ${humanizeInterval(batch.spanMs)}`;
}

/**
 * Запись окна для журнала хода: только метаданные.
 *
 * Ни текста, ни расшифровок — идентификаторы, отметки и промежутки.
 * Разбирать по ней можно, читать переписку — нет.
 */
export function timelineDetail(batch: MessageBatchTiming): Record<string, unknown> {
  return {
    messages: batch.messages.length,
    span_ms: batch.spanMs,
    first_at: batch.firstAt.toISOString(),
    last_at: batch.lastAt.toISOString(),
    items: batch.messages.map((message) => ({
      order: message.order,
      message_id: message.messageId,
      at: message.at.toISOString(),
      elapsed_from_previous_ms: message.elapsedFromPreviousMs,
    })),
  };
}
