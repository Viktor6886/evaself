/**
 * Объединение быстрых последовательных сообщений в один ход.
 *
 * Человек часто пишет мысль в три сообщения подряд. Отвечать на каждое —
 * значит трижды поднять контекст, трижды сходить к модели и трижды снять
 * квоту за одну реплику, а человеку прислать три ответа на разорванную
 * фразу. Здесь эти сообщения собираются в один ход.
 *
 * Окно адаптивное: базовая пауза 800 мс, каждое новое сообщение
 * продлевает её ещё на паузу, но не дальше общего потолка. Закрывается
 * окно по любому из событий: наступил дедлайн, набралось предельное
 * число сообщений, набрался предельный объём, пришла граница темы —
 * команда или сообщение, требующее отдельного ответа.
 *
 * Чего окно не объединяет никогда: команды, кризисные сообщения,
 * сообщения без готового медиа и сообщения другого человека или другой
 * conversation. Первые два — потому что ответ на них отдельный по сути,
 * а не по форме; третье — потому что объединять нечего, пока нечего
 * читать.
 */

import { detectCrisis } from "../crisis.js";
import type { InboxRecord, ParallelTelegramInbox } from "../delivery/inbox.js";
import type { Logger } from "../logger.js";
import type { TelegramMessage, TelegramUpdate } from "../telegram.js";

export interface AggregationOptions {
  /** Базовая пауза ожидания следующего сообщения. */
  debounceMs: number;
  /** Потолок окна: дальше ход начинается независимо от новых сообщений. */
  maxWindowMs: number;
  maxMessages: number;
  maxCharacters: number;
}

export const AGGREGATION_DEFAULTS: AggregationOptions = {
  debounceMs: 800,
  maxWindowMs: 2_500,
  maxMessages: 5,
  maxCharacters: 2_000,
};

/** Почему окно закрылось. Уходит в лог и в метрику, не пользователю. */
export type AggregationStop =
  | "deadline"
  | "no_more_messages"
  | "message_limit"
  | "volume_limit"
  | "boundary";

export interface AggregatedTurn {
  records: InboxRecord[];
  stop: AggregationStop;
  windowMs: number;
}

function messageOf(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.edited_message;
}

function textOf(update: TelegramUpdate): string {
  const message = messageOf(update);
  return (message?.text ?? message?.caption ?? "").trim();
}

/**
 * Готово ли медиа сообщения к тому, чтобы стать частью общего хода.
 *
 * Проверяется именно готовность, а не наличие: у голосового сообщения
 * без `file_id` читать нечего, и объединение превратилось бы в потерю
 * реплики. Такое сообщение уходит отдельным ходом, где его разберёт
 * обычный путь с расшифровкой.
 */
export function mediaReady(update: TelegramUpdate): boolean {
  const message = messageOf(update);
  if (!message) return false;
  const file = message.voice ?? message.audio ?? message.document ?? message.photo?.at(-1);
  if (!file) return true;
  return typeof file.file_id === "string" && file.file_id.length > 0;
}

/**
 * Можно ли сообщение вообще присоединять к общему ходу.
 *
 * Список закрытый и объясняется по пунктам: команда меняет режим
 * разговора и обязана отработать отдельно; кризисный сигнал требует
 * немедленного и отдельного ответа (детектор здесь тот же
 * детерминированный, что и у монитора, — второго не заводим);
 * сообщение бота и сообщение без содержимого объединять нечего.
 */
export function aggregatable(update: TelegramUpdate): boolean {
  const message = messageOf(update);
  if (!message?.from || message.from.is_bot) return false;
  const text = textOf(update);
  if (/^\/[a-z_]+(?:@\w+)?(?:\s|$)/i.test(text)) return false;
  if (text && detectCrisis(text)) return false;
  if (!mediaReady(update)) return false;
  const hasContent = Boolean(
    text || message.voice || message.audio || message.photo?.length || message.document,
  );
  return hasContent;
}

/** Одна ли это conversation. У Telegram-хода conversation задаётся чатом. */
function sameConversation(left: TelegramUpdate, right: TelegramUpdate): boolean {
  return messageOf(left)?.chat.id === messageOf(right)?.chat.id;
}

export class TurnAggregator {
  private readonly options: AggregationOptions;

  constructor(
    private readonly inbox: ParallelTelegramInbox,
    private readonly logger: Logger,
    options: Partial<AggregationOptions> = {},
    /** Ожидание вынесено параметром, чтобы тест не спал по-настоящему. */
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.options = { ...AGGREGATION_DEFAULTS, ...options };
  }

  /**
   * Собрать ход вокруг уже занятой записи.
   *
   * Возвращает всегда как минимум саму запись: объединение — улучшение
   * хода, а не условие его существования.
   */
  async collect(
    primary: InboxRecord,
    context: { workerId: string; maxAttempts: number },
  ): Promise<AggregatedTurn> {
    const started = Date.now();
    if (primary.telegramUserId === null || !aggregatable(primary.payload)) {
      return { records: [primary], stop: "boundary", windowMs: 0 };
    }

    const records = [primary];
    let characters = textOf(primary.payload).length;
    const deadline = started + this.options.maxWindowMs;
    let stop: AggregationStop = "no_more_messages";

    while (Date.now() < deadline) {
      const pause = Math.min(this.options.debounceMs, deadline - Date.now());
      if (pause > 0) await this.wait(pause);

      const followUps = await this.inbox.claimFollowUps({
        workerId: context.workerId,
        telegramUserId: primary.telegramUserId,
        afterUpdateId: records[records.length - 1]!.updateId,
        maxAttempts: context.maxAttempts,
        limit: Math.max(1, this.options.maxMessages - records.length),
      });
      if (followUps.length === 0) {
        stop = Date.now() >= deadline ? "deadline" : "no_more_messages";
        break;
      }

      let closed: AggregationStop | null = null;
      for (const record of followUps) {
        const boundary =
          !aggregatable(record.payload) || !sameConversation(primary.payload, record.payload);
        if (boundary || closed !== null) {
          // Граница темы или уже закрытое окно: запись возвращается в
          // очередь и станет собственным ходом. Попытка ей возвращается —
          // её ничто не обрабатывало.
          await this.inbox.release(record.updateId, 0);
          if (!closed) closed = "boundary";
          continue;
        }
        records.push(record);
        characters += textOf(record.payload).length;
        if (records.length >= this.options.maxMessages) closed = "message_limit";
        else if (characters >= this.options.maxCharacters) closed = "volume_limit";
      }
      if (closed) {
        stop = closed;
        break;
      }
    }
    if (Date.now() >= deadline && stop === "no_more_messages") stop = "deadline";

    if (records.length > 1) {
      this.logger.info("Быстрые сообщения объединены в один ход", {
        telegram_id: primary.telegramUserId,
        messages: records.length,
        window_ms: Date.now() - started,
        stop,
      });
    }
    return { records, stop, windowMs: Date.now() - started };
  }
}
