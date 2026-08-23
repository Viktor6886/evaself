import {
  formatEvaReply,
  isValidTelegramHtml,
  richMarkdownForTelegram,
  splitTelegramHtml,
  stripTags,
} from "./telegram-format.js";
import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { Config } from "./config.js";
import type {
  DeliveryMetrics,
  OutboxDelivery,
  OutboxTransport,
} from "./delivery/outbox.js";
import type { DeliveryPriority } from "./delivery/priority.js";
import type { Database } from "./db.js";
import type { Logger } from "./logger.js";
import type { ReactionTarget } from "./turns/turn-context.js";
import {
  hasNewerRealMessage,
  isReactionTargetFresh,
  lockReactionTarget,
} from "./telegram/reaction-target.js";
import {
  TelegramStickerCatalog,
  type StickerRuntimeDiagnostics,
} from "./telegram/stickers.js";

function reactionTargetFromPayload(value: unknown): ReactionTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Partial<ReactionTarget>;
  return Number.isSafeInteger(target.updateId)
    && Number.isSafeInteger(target.telegramUserId)
    && Number.isSafeInteger(target.chatId)
    && Number.isSafeInteger(target.messageId)
    ? target as ReactionTarget
    : null;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: TelegramFile;
  audio?: TelegramFile;
  document?: TelegramFile;
  photo?: TelegramFile[];
  reply_to_message?: TelegramMessage;
}

/** Нажатие inline-кнопки. `data` — наш непрозрачный токен, не команда. */
export interface TelegramCallbackQuery {
  id: string;
  from?: { id?: number };
  message?: { message_id?: number; chat?: { id?: number } };
  data?: string;
}

/** Ответ человека в опросе. Приходит только у неанонимного опроса. */
export interface TelegramPollAnswer {
  poll_id: string;
  user?: { id?: number };
  option_ids?: number[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  poll_answer?: TelegramPollAnswer;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/**
 * Файл больше отведённого предела.
 *
 * Отдельный тип, потому что ответ человеку здесь другой: не «что-то
 * пошло не так», а «файл слишком большой» с названным пределом.
 */
export class TelegramFileTooLarge extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`Файл больше предела: ${size} > ${limit} байт`);
    this.name = "TelegramFileTooLarge";
  }
}

/** Потолок загрузки по умолчанию: столько же, сколько принимает база знаний. */
const DEFAULT_DOWNLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly errorCode: number | null = null,
    readonly description: string = "Telegram API request failed",
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export function safeTelegramApiError(error: unknown): {
  error_code: number | "telegram_transport_error";
  description: string;
} {
  if (error instanceof TelegramApiError) {
    return {
      error_code: error.errorCode ?? "telegram_transport_error",
      description: sanitizeTelegramDescription(error.description),
    };
  }
  return {
    error_code: "telegram_transport_error",
    description: "Telegram API request failed",
  };
}

/**
 * Ответ, который растёт на глазах.
 *
 * Раньше это делал `sendMessageDraft`: Telegram показывал черновик бота,
 * но пока черновик открыт, кнопка отправки в чате подменяется на «•••» —
 * человек не может написать следующее сообщение, пока Ева отвечает.
 * Цена оказалась выше выигрыша, и Bot API отдать её обратно не может:
 * поведением ввода управляет клиент Telegram, а не бот.
 *
 * Поэтому поток показывается обычным сообщением: первый содержательный
 * срез уходит `sendMessage`, все следующие правят то же самое сообщение
 * через `editMessageText`. Поле ввода при этом свободно.
 */
export interface TelegramLiveMessage {
  /** Показать это состояние целиком. Промежуточные схлопываются в последнее. */
  push(text: string): void;
  /**
   * Довести сообщение до итогового текста.
   *
   * `delivered: false` означает, что показывать было нечего и сообщения
   * не существует: ответ должен уйти обычной отправкой.
   */
  /**
   * Довести ответ до итогового вида. `replyMarkup` — кнопки, которые
   * встают под последней частью ответа; `keyboardMessageId` называет то
   * сообщение, к которому они фактически прикреплены.
   */
  finish(
    text: string,
    replyMarkup?: unknown,
  ): Promise<{ delivered: boolean; messageId: number | null; keyboardMessageId: number | null }>;
  /** Прекратить всё: ход отменён или оборвался. Поздние правки не уйдут. */
  stop(): void;
  /** Идентификатор сообщения, которое растёт. `null` — его ещё нет. */
  readonly messageId: number | null;
  /** Сколько обращений к Telegram сделал показ: отправка и правки. */
  readonly updates: number;
  /** Что человек видит сейчас. */
  readonly shown: string;
}

export interface TelegramChatActionController {
  transition(action: "typing" | "record_voice" | "upload_voice" | null): void;
  stop(): void;
}

/**
 * Как часто правится растущее сообщение.
 *
 * Токены приходят десятками в секунду, а Telegram считает частоту
 * обращений к чату: править на каждый срез — значит выбрать лимит на
 * первых секундах ответа и получить 429 на самой доставке. Промежуточные
 * состояния поэтому не отправляются вовсе, уходит только последнее.
 */
const LIVE_UPDATE_INTERVAL_MS = 800;

/** Предел одного сообщения Telegram с запасом на разметку. */
const LIVE_MESSAGE_LIMIT = 3_900;
const LIVE_CURSOR = "▉";

/** Следующий читаемый prefix: целые слова, без разрыва code/link Markdown. */
export function nextLivePrefix(current: string, target: string, maxWords: number): string {
  if (!target.startsWith(current) || current.length >= target.length) return target;
  let inlineCode = false;
  let fencedCode = false;
  let brackets = 0;
  let linkParens = 0;
  let words = 0;
  let safe = current.length;
  let reachedLimit = false;
  for (let index = current.length; index < target.length; index += 1) {
    if (target.startsWith("```", index)) {
      fencedCode = !fencedCode;
      index += 2;
      continue;
    }
    const char = target[index]!;
    if (!fencedCode && char === "`") inlineCode = !inlineCode;
    if (!fencedCode && !inlineCode) {
      if (char === "[") brackets += 1;
      else if (char === "]") brackets = Math.max(0, brackets - 1);
      else if (char === "(" && index > 0 && target[index - 1] === "]") linkParens += 1;
      else if (char === ")") linkParens = Math.max(0, linkParens - 1);
    }
    if (/\s/u.test(char) && !fencedCode && !inlineCode && brackets === 0 && linkParens === 0) {
      words += 1;
      safe = index;
      if (words >= maxWords) { reachedLimit = true; break; }
    }
  }
  if (!reachedLimit && !fencedCode && !inlineCode && brackets === 0 && linkParens === 0) {
    return target;
  }
  if (safe <= current.length) return target;
  return target.slice(0, safe).trimEnd();
}

export class TelegramClient implements OutboxTransport {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly db: Database | null;
  private readonly stickers: TelegramStickerCatalog;
  private outbox: OutboxDelivery | null = null;
  private cachedUsername: string | null | undefined;
  private readonly deliveryContext = new AsyncLocalStorage<{
    prefix: string;
    sequence: number;
    metrics: DeliveryMetrics;
    lastOutboxId: string | null;
    priority: DeliveryPriority;
  }>();

  /**
   * Ступень очереди для всего, что отправляется внутри.
   *
   * Отдельным контекстом, а не параметром: приоритет — свойство
   * происходящего, а не одного вызова. Кризисный монитор объявляет его
   * один раз, и всё, что он отправит, включая вложенные вызовы,
   * попадает в очередь на своей ступени.
   */
  private readonly priorityContext = new AsyncLocalStorage<DeliveryPriority>();

  /** Выполнить работу, объявив ступень очереди для её отправок. */
  async withPriority<T>(priority: DeliveryPriority, work: () => Promise<T>): Promise<T> {
    return await this.priorityContext.run(priority, work);
  }

  constructor(config: Config, logger: Logger, db?: Database) {
    this.token = config.telegramBotToken;
    this.baseUrl = config.telegramApiBaseUrl.replace(/\/+$/, "");
    this.logger = logger;
    this.db = db ?? null;
    this.stickers = new TelegramStickerCatalog(
      config.telegramStickerCatalog,
      this.token,
      this.db,
      logger,
    );
  }

  /**
   * The bot's own @handle, used by the landing page to build its deep link.
   * Cached for the process lifetime: it only changes when an operator renames
   * the bot, and a restart picks that up.
   */
  async username(): Promise<string | null> {
    if (!this.token) return null;
    if (this.cachedUsername !== undefined) return this.cachedUsername;
    try {
      const me = await this.call<{ username?: string }>("getMe", {});
      this.cachedUsername = me.username ?? null;
      return this.cachedUsername;
    } catch (error) {
      this.logger.warn("Не удалось получить имя бота через getMe", {
        message: error instanceof Error ? error.message : String(error),
      });
      // Deliberately not cached: a transient failure must not pin `null`.
      return null;
    }
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  setOutbox(outbox: OutboxDelivery): void {
    this.outbox = outbox;
  }

  async withDeliveryContext<T>(
    prefix: string,
    work: () => Promise<T>,
    priority: DeliveryPriority = priorityForContext(prefix),
  ): Promise<T> {
    return await this.deliveryContext.run({
      prefix,
      sequence: 0,
      metrics: { outboxInsertMs: 0, telegramSendMs: 0 },
      lastOutboxId: null,
      priority,
    }, work);
  }

  getDeliveryMetrics(): DeliveryMetrics {
    const metrics = this.deliveryContext.getStore()?.metrics;
    return metrics
      ? { ...metrics }
      : { outboxInsertMs: 0, telegramSendMs: 0 };
  }

  /** Последняя строка outbox, поставленная в этом контексте доставки. */
  getDeliveryOutboxId(): string | null {
    return this.deliveryContext.getStore()?.lastOutboxId ?? null;
  }

  /**
   * Отправка с разметкой.
   *
   * Модель пишет markdown, Telegram его не понимает — без parse_mode
   * пользователь видел сырые «**Сегодня в Перми:**». Переводим в
   * поддерживаемый Telegram HTML.
   *
   * Если разметка почему-то оказалась негодной, сообщение уходит
   * обычным текстом: потерять ответ из-за одной скобки хуже, чем
   * потерять жирный шрифт.
   */
  async sendMessage(
    chatId: number,
    text: string,
    options: Record<string, unknown> = {},
    priority?: DeliveryPriority,
  ): Promise<unknown[]> {
    // Служебные тексты передают parse_mode явно — их не трогаем.
    if (options.parse_mode !== undefined) {
      const results: unknown[] = [];
      for (const chunk of splitTelegramText(text)) {
        results.push(await this.dispatch("sendMessage", chatId, {
          chat_id: chatId, text: chunk, ...options,
        }, priority));
      }
      return results;
    }

    const html = formatEvaReply(text);
    const usable = html.length > 0 && isValidTelegramHtml(html);
    const chunks = usable ? splitTelegramHtml(html) : splitTelegramText(text);
    const results: unknown[] = [];

    // Кнопки, ответ на сообщение и прочие вложения — свойства сообщения
    // целиком, а не каждого куска. Приклеенные к каждой части, они
    // повторились бы столько раз, на сколько частей разбился ответ.
    const { reply_markup: replyMarkup, ...common } = options;

    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        ...common,
        ...(isLast && replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      };
      if (usable) {
        payload.parse_mode = "HTML";
        // Ссылки в ответе — источники, а не украшение: превью на
        // половину экрана мешает читать сам ответ.
        payload.link_preview_options = { is_disabled: true };
      }
      try {
        results.push(await this.dispatch("sendMessage", chatId, payload, priority));
      } catch (error) {
        if (!usable || !isTelegramMarkupError(error)) throw error;
        // Telegram отверг разметку. Исходный текст пишем в лог целиком:
        // без него причину «can't parse entities» не найти, а сообщение
        // всё равно должно дойти — пусть и без оформления.
        this.logger.warn("Telegram отклонил разметку, отправляю без неё", {
          chatId,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error),
          html: chunk.slice(0, 1_000),
        });
        results.push(await this.dispatch("sendMessage", chatId, {
          chat_id: chatId,
          text: stripTags(chunk),
          ...common,
          ...(isLast && replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
        }, priority));
      }
    }
    return results;
  }

  /** Native Rich Message for assistant replies; regular HTML remains the fallback. */
  async sendAssistantMessage(
    chatId: number,
    text: string,
    options: Record<string, unknown> = {},
    priority?: DeliveryPriority,
  ): Promise<unknown[]> {
    const markdown = richMarkdownForTelegram(text);
    if (!markdown || Buffer.byteLength(markdown, "utf8") > 32_768) {
      return await this.sendMessage(chatId, text, options, priority);
    }
    const result = await this.dispatch("sendRichMessage", chatId, {
      chat_id: chatId,
      rich_message: { markdown, skip_entity_detection: false },
      ...options,
      _fallback_text: text,
    }, priority);
    return [result];
  }

  /**
   * Send text byte-for-byte without treating user-controlled content as Markdown.
   *
   * STT transcripts use this path: a phrase such as `_secret_` or `<tag>` must
   * stay the user's words, not turn into formatting or an HTML entity error.
   */
  async sendPlainMessage(
    chatId: number,
    text: string,
    options: Record<string, unknown> = {},
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    const { reply_markup: replyMarkup, ...common } = options;
    const chunks = splitTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      results.push(await this.dispatch("sendMessage", chatId, {
        chat_id: chatId,
        text: chunk,
        ...common,
        ...(index === chunks.length - 1 && replyMarkup !== undefined
          ? { reply_markup: replyMarkup }
          : {}),
      }));
    }
    return results;
  }

  async editPlainMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      ...renderTelegramText(text),
    });
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    await this.dispatch("sendChatAction", chatId, { chat_id: chatId, action }, "status");
  }

  /**
   * Показать ответ, пока модель его пишет.
   *
   * `push` вызывается из потока и ничего не ждёт: он запоминает текст.
   * Отправкой занимается таймер, поэтому генерация не платит за сеть
   * Telegram, а частота обращений остаётся под контролем.
   *
   * Показ — не доставка. Промежуточные состояния идут прямым вызовом
   * мимо outbox: повторять их после перезапуска незачем, они уже
   * неактуальны. Итоговый текст `finish` проводит через outbox — он и
   * есть ответ.
   */
  startLiveMessage(
    chatId: number,
    options: {
      intervalMs?: number;
      now?: () => number;
      /** Первое сообщение отправлено: печатать «typing» больше незачем. */
      onSent?: (messageId: number) => void;
    } = {},
  ): TelegramLiveMessage {
    const intervalMs = Math.max(0, options.intervalMs ?? LIVE_UPDATE_INTERVAL_MS);
    const now = options.now ?? (() => Date.now());
    let pending: string | null = null;
    let shown = "";
    let messageId: number | null = null;
    let richMode: boolean | null = null;
    let updates = 0;
    let lastSentAt = -Infinity;
    /** До этого момента Telegram просил не приходить: 429 с retry_after. */
    let pausedUntil = 0;
    let flushing: Promise<void> | null = null;
    let stopped = false;
    /**
     * Прервать текущее ожидание.
     *
     * Пауза после 429 длится столько, сколько попросил Telegram, — до
     * получаса. Обычным `setTimeout` конец хода эту паузу не будит, и
     * готовый ответ ждал бы её целиком: рейт-лимит промежуточной правки
     * превращался в задержку доставки. Показ — украшение, а доставка
     * ждать его не должна.
     */
    let wake: (() => void) | null = null;
    const sleep = async (ms: number): Promise<void> => {
      if (ms <= 0) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        const timer = setTimeout(done, ms);
        timer.unref?.();
        wake = done;
      });
    };
    const interrupt = (): void => wake?.();

    const write = async (text: string, cursor = true): Promise<void> => {
      const displayed = cursor ? `${text} ${LIVE_CURSOR}` : text;
      const richPayload = renderTelegramRichText(displayed);
      if (messageId === null) {
        let sent: { message_id?: number };
        try {
          sent = await this.call<{ message_id?: number }>("sendRichMessage", {
            chat_id: chatId,
            ...richPayload,
          });
          richMode = true;
        } catch (error) {
          if (!isRichMessageFallbackError(error)) throw error;
          sent = await this.call<{ message_id?: number }>("sendMessage", {
            chat_id: chatId,
            ...renderTelegramText(displayed),
          });
          richMode = false;
        }
        const id = Number(sent?.message_id);
        if (!Number.isSafeInteger(id)) throw new TelegramApiError("Telegram не вернул message_id");
        messageId = id;
        options.onSent?.(id);
      } else if (richMode !== false) {
        try {
          await this.call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            ...richPayload,
          });
          richMode = true;
        } catch (error) {
          if (!isRichMessageFallbackError(error)) throw error;
          await this.call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            ...renderTelegramText(displayed),
          });
          richMode = false;
        }
      } else {
        await this.call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          ...renderTelegramText(displayed),
        });
      }
      shown = text;
      updates += 1;
      lastSentAt = now();
    };

    const flush = async (): Promise<void> => {
      while (!stopped && pending !== null) {
        // Один сон на оба ожидания: и выдержка между правками, и пауза,
        // о которой попросил Telegram. Накопленные состояния при этом
        // схлопываются — уходит только последнее.
        const wait = Math.max(intervalMs - (now() - lastSentAt), pausedUntil - now());
        if (wait > 0) await sleep(wait);
        if (stopped) return;
        const text = pending;
        if (text === null || text === shown) { pending = null; continue; }
        const remainingWords = text.slice(shown.length).trim().split(/\s+/u).filter(Boolean).length;
        // Обычно 6–15 слов; большой backlog догоняется несколькими
        // крупными, но всё ещё читаемыми порциями.
        const words = Math.max(6, Math.min(60, Math.max(15, Math.ceil(remainingWords / 3))));
        const next = nextLivePrefix(shown, text, words);
        try {
          await write(next);
          if (next === pending) pending = null;
        } catch (error) {
          // Показ — украшение. Его отказ не роняет ход и не превращается
          // в повтор: ответ всё равно уйдёт итоговой отправкой.
          if (error instanceof TelegramApiError && error.retryAfterMs !== null) {
            // 429: следующая попытка не раньше названного срока, и без
            // очереди накопленных правок — только последнее состояние.
            pausedUntil = now() + error.retryAfterMs;
            continue;
          }
          this.logger.debug("Telegram не принял промежуточное состояние ответа", {
            chatId,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
    };

    const schedule = (): void => {
      if (flushing) return;
      flushing = flush().finally(() => { flushing = null; });
    };
    const removeCursor = (): void => {
      if (messageId === null || !shown) return;
      void (flushing ?? Promise.resolve()).finally(async () => {
        await this.call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          ...(richMode !== false ? renderTelegramRichText(shown) : renderTelegramText(shown)),
        }).catch(() => undefined);
      });
    };

    return {
      push(text: string): void {
        if (stopped) return;
        const clean = text.trimEnd();
        // Слишком длинный ответ одним сообщением не показывается: он всё
        // равно уйдёт частями, и показывать обрезок значило бы показать
        // не тот текст.
        if (!clean || clean === shown || clean.length > LIVE_MESSAGE_LIMIT) return;
        pending = clean;
        schedule();
      },
      /**
       * Довести ответ до итогового вида и, если Ева просила, приклеить
       * кнопки.
       *
       * Клавиатура появляется только здесь: промежуточные правки её не
       * несут, иначе человек нажимал бы на кнопки под недописанным
       * ответом. Возвращается идентификатор сообщения, к которому она
       * фактически прикреплена, — у длинного ответа это последняя часть,
       * а не то сообщение, с которого поток начался.
       */
      finish: async (
        text: string,
        replyMarkup?: unknown,
      ): Promise<{ delivered: boolean; messageId: number | null; keyboardMessageId: number | null }> => {
        const clean = text.trimEnd();
        const finalWords = clean.slice(shown.length).trim().split(/\s+/u).filter(Boolean).length;
        if (
          messageId !== null && finalWords >= 6
          && clean.length <= LIVE_MESSAGE_LIMIT && clean !== shown
        ) {
          pending = clean;
          schedule();
          await Promise.race([
            flushing ?? Promise.resolve(),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1_600);
              timer.unref?.();
            }),
          ]);
        }
        stopped = true;
        pending = null;
        // Ожидание прерывается до `await`: иначе конец хода встал бы в
        // очередь за паузой, которая касалась только показа.
        interrupt();
        await flushing?.catch(() => undefined);
        if (messageId === null) return { delivered: false, messageId: null, keyboardMessageId: null };
        const keyboardMessageId = await this.finalizeLiveMessage(
          chatId, messageId, text, replyMarkup, richMode !== false,
        );
        return { delivered: true, messageId, keyboardMessageId };
      },
      stop(): void {
        stopped = true;
        pending = null;
        interrupt();
        // Cursor — только UI, не канонический текст. Cancel/error обязан
        // снять его даже без обычной финализации ответа.
        removeCursor();
      },
      get messageId(): number | null { return messageId; },
      get updates(): number { return updates; },
      get shown(): string { return shown; },
    };
  }

  /**
   * Довести растущее сообщение до итогового текста.
   *
   * Правка идёт через outbox: она и есть доставка ответа, а значит
   * переживает перезапуск и повторяется идемпотентно. Хвост, не
   * поместившийся в одно сообщение Telegram, уходит следующими
   * сообщениями — второго ответа при этом не появляется, продолжается
   * тот же.
   */
  private async finalizeLiveMessage(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: unknown,
    useRich = true,
  ): Promise<number | null> {
    const chunks = splitTelegramText(text, LIVE_MESSAGE_LIMIT);
    const head = chunks[0] ?? text.trim();
    const tail = chunks.slice(1);
    // Кнопки относятся к ответу целиком, а значит встают под его концом:
    // клавиатура посреди разбитого ответа выглядит как конец разговора.
    const headKeyboard = tail.length === 0 ? replyMarkup : undefined;
    let keyboardMessageId: number | null = null;
    if (head) {
      await this.dispatch("editMessageText", chatId, {
        chat_id: chatId,
        message_id: messageId,
        ...(useRich ? renderTelegramRichText(head) : renderTelegramText(head)),
        _fallback_text: head,
        ...(headKeyboard === undefined ? {} : { reply_markup: headKeyboard }),
      });
      if (headKeyboard !== undefined) keyboardMessageId = messageId;
    }
    for (const [index, rest] of tail.entries()) {
      const last = index === tail.length - 1;
      const sent = await this.sendAssistantMessage(
        chatId, rest,
        last && replyMarkup !== undefined ? { reply_markup: replyMarkup } : {},
      );
      if (last && replyMarkup !== undefined) {
        keyboardMessageId = telegramMessageIdOf(sent[sent.length - 1]) ?? null;
      }
    }
    return keyboardMessageId;
  }

  /**
   * Ответить Telegram на нажатие кнопки.
   *
   * Вызывается первым делом: пока ответа нет, у человека крутится
   * ожидание на самой кнопке, и это единственное, что он видит. Отказ
   * здесь не должен ронять обработку выбора — сам выбор уже сделан.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.dispatch("answerCallbackQuery", 0, {
      callback_query_id: callbackQueryId,
      ...(text ? { text, show_alert: false } : {}),
    });
  }

  /** Снять клавиатуру: выбор сделан, и второй раз его делать не нужно. */
  async clearInlineKeyboard(chatId: number, messageId: number): Promise<void> {
    await this.dispatch("editMessageReplyMarkup", chatId, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async setReaction(
    chatId: number,
    messageId: number,
    emoji: string,
    target?: ReactionTarget,
  ): Promise<unknown> {
    if (target && this.db && !await isReactionTargetFresh(this.db, target)) {
      return { skipped: true, reason: "stale_reaction_target" };
    }
    try {
      return await this.dispatchConfirmed("setMessageReaction", chatId, {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
        is_big: false,
        ...(target ? { _evaself_reaction_target: target } : {}),
      }, this.deliveryContext.getStore() ? undefined : "status");
    } catch (error) {
      this.logger.warn("Telegram отклонил реакцию", {
        outcome: "failed",
        reason: "telegram_api_error",
        ...safeTelegramApiError(error),
      });
      throw error;
    }
  }

  /**
   * Отправить нативный опрос.
   *
   * Идёт тем же путём доставки, что и обычный ответ: очередь, повторы,
   * лимиты Telegram. Возвращается то, что вернул API, — из него берётся
   * идентификатор опроса, без которого ответ человека не с чем связать.
   */
  async sendPoll(
    chatId: number,
    poll: {
      question: string;
      options: string[];
      isAnonymous: boolean;
      allowsMultiple: boolean;
    },
  ): Promise<unknown> {
    return await this.dispatch("sendPoll", chatId, {
      chat_id: chatId,
      question: poll.question,
      // Bot API принимает варианты объектами `InputPollOption`.
      options: poll.options.map((text) => ({ text })),
      is_anonymous: poll.isAnonymous,
      allows_multiple_answers: poll.allowsMultiple,
      type: "regular",
    });
  }

  async sendVoice(chatId: number, audio: Uint8Array, filename = "eva.ogg"): Promise<void> {
    if (this.outbox) {
      await this.dispatch("sendVoice", chatId, {
        chat_id: chatId,
        audio_base64: Buffer.from(audio).toString("base64"),
        filename,
      });
      return;
    }
    const started = performance.now();
    try {
      await this.sendVoiceDirect(chatId, audio, filename);
    } finally {
      this.addDeliveryMetrics({ telegramSendMs: elapsed(started) });
    }
  }

  async deliver(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const fallbackText = typeof payload._fallback_text === "string" ? payload._fallback_text : "";
    const apiPayload = { ...payload };
    delete apiPayload._fallback_text;
    const reactionTarget = reactionTargetFromPayload(apiPayload._evaself_reaction_target);
    delete apiPayload._evaself_reaction_target;

    if (method === "sendEvaSticker") {
      const chatId = Number(apiPayload.chat_id);
      const intent = typeof apiPayload.intent === "string" ? apiPayload.intent : "";
      if (!Number.isSafeInteger(chatId)) throw new Error("Telegram sticker: неверный chat_id");
      return await this.stickers.send(
        intent,
        async (fileId) => await this.call("sendSticker", { chat_id: chatId, sticker: fileId }),
        async (bytes, filename) => await this.uploadSticker(chatId, bytes, filename),
      );
    }

    if (method === "setMessageReaction" && reactionTarget && this.db) {
      return await this.db.withSystemScope(
        "telegram.reaction.deliver",
        async () => await this.db!.transaction(async (client) => {
          await lockReactionTarget(client, reactionTarget.telegramUserId, reactionTarget.chatId);
          if (await hasNewerRealMessage(client, reactionTarget)) {
            this.logger.info("Доставка Telegram-реакции пропущена", {
              outcome: "skipped",
              reason: "stale_reaction_target",
              updateId: reactionTarget.updateId,
            });
            return { skipped: true, reason: "stale_reaction_target" };
          }
          return await this.call(method, apiPayload);
        }),
        { crossUser: true },
      );
    }

    if (method === "sendRichMessage") {
      try {
        return await this.call(method, apiPayload);
      } catch (error) {
        if (!isRichMessageFallbackError(error)) throw error;
        this.logger.warn("Telegram Rich Messages недоступны, использую regular formatter", {
          chatId: Number(payload.chat_id) || null,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
        const { rich_message: _rich, ...common } = apiPayload;
        return await this.call("sendMessage", {
          ...common,
          ...renderTelegramText(fallbackText),
        });
      }
    }

    if (method === "editMessageText") {
      try {
        return await this.call(method, apiPayload);
      } catch (error) {
        if (isTelegramNotModified(error)) return {};
        const wasRich = "rich_message" in apiPayload;
        if (!isTelegramMarkupError(error) && !(wasRich && isRichMessageFallbackError(error))) throw error;
        this.logger.warn("Telegram отклонил разметку правки, использую regular formatter", {
          chatId: Number(payload.chat_id) || null,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
        const { rich_message: _rich, text: _text, parse_mode: _mode, link_preview_options: _preview, ...common } = apiPayload;
        const source = fallbackText || stripTags(String(apiPayload.text ?? ""));
        const regular = { ...common, ...renderTelegramText(source) };
        try {
          return await this.call(method, regular);
        } catch (retryError) {
          if (isTelegramNotModified(retryError)) return {};
          if (!isTelegramMarkupError(retryError)) throw retryError;
          const plain = { ...common, text: stripTags(formatEvaReply(source)) };
          return await this.call(method, plain);
        }
      }
    }
    if (method === "sendVoice") {
      const encoded = typeof payload.audio_base64 === "string" ? payload.audio_base64 : "";
      if (!encoded) throw new Error("Telegram outbox: отсутствуют данные голосового сообщения");
      const chatId = Number(payload.chat_id);
      if (!Number.isSafeInteger(chatId)) throw new Error("Telegram outbox: неверный chat_id");
      await this.sendVoiceDirect(
        chatId,
        new Uint8Array(Buffer.from(encoded, "base64")),
        typeof payload.filename === "string" ? payload.filename : "eva.ogg",
      );
      return {};
    }
    return await this.call(method, apiPayload);
  }

  private async sendVoiceDirect(
    chatId: number,
    audio: Uint8Array,
    filename: string,
  ): Promise<void> {
    this.assertConfigured();
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("voice", new Blob([audio], { type: "audio/ogg" }), filename);
    const response = await fetch(`${this.baseUrl}/bot${this.token}/sendVoice`, {
      method: "POST",
      body: form,
    });
    await this.parseResponse(response, "sendVoice");
  }

  /**
   * Скачать файл, не веря его размеру на слово.
   *
   * Размер проверяется трижды: по ответу `getFile`, по заголовку длины и
   * по фактически прочитанным байтам. Первые два можно подделать или
   * просто не прислать, а третий — единственный, который действительно
   * ограничивает память процесса: без него один большой файл в чате
   * укладывает сервис.
   */
  async downloadFile(
    fileId: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ bytes: Uint8Array; path: string; contentType: string | null }> {
    const limit = Math.max(1, options.maxBytes ?? DEFAULT_DOWNLOAD_LIMIT_BYTES);
    const file = await this.call<{ file_path?: string; file_size?: number }>(
      "getFile",
      { file_id: fileId },
    );
    if (!file.file_path) throw new Error("Telegram getFile не вернул file_path");
    if ((file.file_size ?? 0) > limit) throw new TelegramFileTooLarge(file.file_size ?? 0, limit);

    const response = await fetch(`${this.baseUrl}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > limit) throw new TelegramFileTooLarge(declared, limit);

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Telegram file download: пустой ответ");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new TelegramFileTooLarge(size, limit);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      path: file.file_path,
      contentType: response.headers.get("content-type"),
    };
  }

  startTyping(chatId: number, intervalMs: number): () => void {
    const controller = this.startChatActionController(chatId, intervalMs);
    controller.transition("typing");
    return () => controller.stop();
  }

  async sendSticker(chatId: number, fileId: string): Promise<unknown> {
    return await this.dispatch("sendSticker", chatId, {
      chat_id: chatId,
      sticker: fileId,
    });
  }

  /** Model supplies only a closed semantic intent; resolution stays server-owned. */
  async sendStickerIntent(chatId: number, intent: string): Promise<unknown> {
    return await this.dispatch("sendEvaSticker", chatId, { chat_id: chatId, intent });
  }

  async stickerDiagnostics(): Promise<StickerRuntimeDiagnostics> {
    return await this.stickers.diagnostics();
  }

  startChatActionController(chatId: number, intervalMs: number): TelegramChatActionController {
    let active: "typing" | "record_voice" | "upload_voice" | null = null;
    let timer: NodeJS.Timeout | null = null;
    const clear = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const tick = () => {
      if (!active) return;
      void this.sendChatAction(chatId, active).catch((error) => {
        this.logger.debug("Не удалось обновить Telegram chat action", {
          chatId,
          action: active,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };
    return {
      transition: (action) => {
        if (active === action) return;
        clear();
        active = action;
        if (!active) return;
        tick();
        timer = setInterval(tick, Math.max(intervalMs, 2_000));
        timer.unref();
      },
      stop: () => {
        active = null;
        clear();
      },
    };
  }

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    this.assertConfigured();
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await this.parseResponse<T>(response, method);
  }

  private async uploadSticker(chatId: number, bytes: Uint8Array, filename: string): Promise<{
    sticker?: { file_id?: string };
  }> {
    this.assertConfigured();
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("sticker", new Blob([Buffer.from(bytes)], { type: "image/webp" }), filename);
    const response = await fetch(`${this.baseUrl}/bot${this.token}/sendSticker`, {
      method: "POST",
      body: form,
    });
    return await this.parseResponse(response, "sendSticker");
  }

  private async dispatch(
    method: string,
    chatId: number,
    payload: Record<string, unknown>,
    priority?: DeliveryPriority,
  ): Promise<unknown> {
    if (!this.outbox) {
      const started = performance.now();
      try {
        return await this.deliver(method, payload);
      } finally {
        this.addDeliveryMetrics({ telegramSendMs: elapsed(started) });
      }
    }
    const context = this.deliveryContext.getStore();
    const idempotencyKey = context
      ? `${context.prefix}:${String(context.sequence++).padStart(3, "0")}:${method}`
      : undefined;
    return await this.outbox.send({
      method,
      chatId,
      payload,
      idempotencyKey,
      priority: priority ?? this.priorityContext.getStore() ?? context?.priority,
      onMetrics: (metrics) => this.addDeliveryMetrics(metrics),
      onEnqueued: (outboxId) => {
        const store = this.deliveryContext.getStore();
        if (store) store.lastOutboxId = outboxId;
      },
    });
  }

  private async dispatchConfirmed(
    method: string,
    chatId: number,
    payload: Record<string, unknown>,
    priority?: DeliveryPriority,
  ): Promise<unknown> {
    const context = this.deliveryContext.getStore();
    const idempotencyKey = context
      ? `${context.prefix}:${String(context.sequence++).padStart(3, "0")}:${method}`
      : undefined;
    const envelope = {
      method,
      chatId,
      payload,
      idempotencyKey,
      priority: priority ?? this.priorityContext.getStore() ?? context?.priority,
      onMetrics: (metrics: Partial<DeliveryMetrics>) => this.addDeliveryMetrics(metrics),
    };
    if (this.outbox?.sendConfirmed) return await this.outbox.sendConfirmed(envelope);
    const started = performance.now();
    try {
      return await this.deliver(method, payload);
    } finally {
      this.addDeliveryMetrics({ telegramSendMs: elapsed(started) });
    }
  }

  private addDeliveryMetrics(metrics: Partial<DeliveryMetrics>): void {
    const store = this.deliveryContext.getStore();
    if (!store) return;
    store.metrics.outboxInsertMs += metrics.outboxInsertMs ?? 0;
    store.metrics.telegramSendMs += metrics.telegramSendMs ?? 0;
  }

  private assertConfigured(): void {
    if (!this.token) throw new Error("EVA_TELEGRAM_BOT_TOKEN не настроен");
  }

  private async parseResponse<T>(response: Response, method: string): Promise<T> {
    const raw = await response.text();
    let body: TelegramResponse<T>;
    try {
      body = JSON.parse(raw) as TelegramResponse<T>;
    } catch {
      throw new Error(`Telegram ${method}: HTTP ${response.status}, невалидный JSON`);
    }
    if (!response.ok || !body.ok) {
      const jsonRetry = Number(body.parameters?.retry_after);
      const headerRetry = parseRetryAfter(response.headers.get("retry-after"));
      const retryAfterMs = Math.max(
        Number.isFinite(jsonRetry) && jsonRetry > 0 ? jsonRetry * 1_000 : 0,
        headerRetry ?? 0,
      );
      throw new TelegramApiError(
        `Telegram ${method}: ${body.description ?? `HTTP ${response.status}`}`.slice(0, 1000),
        retryAfterMs > 0 ? retryAfterMs : null,
        Number.isSafeInteger(body.error_code) ? body.error_code! : response.status || null,
        body.description ?? `HTTP ${response.status}`,
      );
    }
    return body.result as T;
  }
}

function sanitizeTelegramDescription(value: string): string {
  return value
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, 300) || "Telegram API request failed";
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function priorityForContext(prefix: string): DeliveryPriority {
  if (prefix.startsWith("lava-payment:")) return "command";
  if (prefix.startsWith("telegram-command:")) return "command";
  if (prefix.startsWith("telegram-dead:")) return "status";
  return "reply";
}

/**
 * Разметка ответа для одного сообщения.
 *
 * Модель пишет markdown, Telegram понимает своё подмножество HTML.
 * Негодная разметка не стоит потерянного ответа: тогда текст уходит как
 * есть. Незавершённая разметка — обычное дело в середине генерации,
 * поэтому проверка идёт на каждом состоянии, а не один раз.
 */
export function renderTelegramText(text: string): Record<string, unknown> {
  const html = formatEvaReply(text);
  if (!html || !isValidTelegramHtml(html)) return { text };
  return {
    text: html,
    parse_mode: "HTML",
    // Ссылки в ответе — источники, а не украшение: превью на половину
    // экрана мешает читать сам ответ.
    link_preview_options: { is_disabled: true },
  };
}

/** Safe native Rich Message payload; sanitizer excludes media/maps/custom blocks. */
export function renderTelegramRichText(text: string): Record<string, unknown> {
  return {
    rich_message: {
      markdown: richMarkdownForTelegram(text),
      skip_entity_detection: false,
    },
  };
}

function isTelegramNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError
    && /message is not modified/iu.test(error.message);
}

function isTelegramMarkupError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.retryAfterMs !== null) return false;
  return /can't parse entities|can't find end|unsupported start tag|entity byte offset/iu.test(
    error.message,
  );
}

function isRichMessageFallbackError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.retryAfterMs !== null) return false;
  return /method not found|unknown method|sendrichmessage|rich[_ ]message|can't parse|unsupported|bad request/iu.test(
    error.message,
  );
}

export function webhookSecretMatches(presented: unknown, expected: string): boolean {
  if (!expected || typeof presented !== "string") return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function splitTelegramText(text: string, maxLength = 4_000): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxLength) {
    const candidates = [
      rest.lastIndexOf("\n\n", maxLength),
      rest.lastIndexOf("\n", maxLength),
      rest.lastIndexOf(" ", maxLength),
    ];
    const cut = Math.max(...candidates);
    const position = cut > Math.floor(maxLength * 0.6) ? cut : maxLength;
    chunks.push(rest.slice(0, position).trim());
    rest = rest.slice(position).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export const ALLOWED_REACTIONS = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱",
  "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡",
  "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡",
  "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨",
  "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷",
  "🤷‍♂", "🤷‍♀", "😡",
]);

const REACTION_VARIATION_SELECTORS = /[\uFE0E\uFE0F]/gu;
const CANONICAL_REACTIONS = new Map(
  [...ALLOWED_REACTIONS].map((emoji) => [
    emoji.normalize("NFC").replace(REACTION_VARIATION_SELECTORS, ""),
    emoji,
  ]),
);

/** Accept text/emoji presentation variants while sending Telegram's canonical spelling. */
export function normalizeReactionEmoji(value: string): string | null {
  const key = value.trim().normalize("NFC").replace(REACTION_VARIATION_SELECTORS, "");
  return CANONICAL_REACTIONS.get(key) ?? null;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

/**
 * Идентификатор отправленного сообщения из ответа Telegram.
 *
 * Отправка идёт через outbox, и её результат — то, что вернул API, либо
 * запись очереди. Кнопки нужно повесить именно на сообщение, поэтому
 * отсутствие идентификатора здесь означает «повесить не на что», а не
 * «повесим на предыдущее».
 */
export function telegramMessageIdOf(result: unknown): number | null {
  const id = Number((result as { message_id?: unknown } | null)?.message_id);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Опрос из ответа Telegram.
 *
 * Идентификатор опроса выдаёт сам Telegram при отправке, и другого
 * способа узнать его нет. Если ответ его не принёс — доставка отложена,
 * и связать будущий голос с этим опросом будет нечем; отсюда `null`, а
 * не догадка.
 */
export function telegramPollOf(
  result: unknown,
): { pollId: string; messageId: number | null } | null {
  const poll = (result as { poll?: { id?: unknown } } | null)?.poll;
  const id = typeof poll?.id === "string" ? poll.id.trim() : "";
  if (!id) return null;
  return { pollId: id, messageId: telegramMessageIdOf(result) };
}
