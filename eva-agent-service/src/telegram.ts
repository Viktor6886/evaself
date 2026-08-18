import {
  formatEvaReply,
  isValidTelegramHtml,
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
import type { Logger } from "./logger.js";

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

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "TelegramApiError";
  }
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
  finish(text: string): Promise<{ delivered: boolean; messageId: number | null }>;
  /** Прекратить всё: ход отменён или оборвался. Поздние правки не уйдут. */
  stop(): void;
  /** Идентификатор сообщения, которое растёт. `null` — его ещё нет. */
  readonly messageId: number | null;
  /** Сколько обращений к Telegram сделал показ: отправка и правки. */
  readonly updates: number;
  /** Что человек видит сейчас. */
  readonly shown: string;
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

export class TelegramClient implements OutboxTransport {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly logger: Logger;
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

  constructor(config: Config, logger: Logger) {
    this.token = config.telegramBotToken;
    this.baseUrl = config.telegramApiBaseUrl.replace(/\/+$/, "");
    this.logger = logger;
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
    let updates = 0;
    let lastSentAt = -Infinity;
    /** До этого момента Telegram просил не приходить: 429 с retry_after. */
    let pausedUntil = 0;
    let flushing: Promise<void> | null = null;
    let stopped = false;

    const write = async (text: string): Promise<void> => {
      const payload = renderTelegramText(text);
      if (messageId === null) {
        const sent = await this.call<{ message_id?: number }>("sendMessage", {
          chat_id: chatId,
          ...payload,
        });
        const id = Number(sent?.message_id);
        if (!Number.isSafeInteger(id)) throw new TelegramApiError("Telegram не вернул message_id");
        messageId = id;
        options.onSent?.(id);
      } else {
        await this.call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          ...payload,
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
        if (wait > 0) await delay(wait);
        if (stopped) return;
        const text = pending;
        pending = null;
        if (text === null || text === shown) continue;
        try {
          await write(text);
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
      finish: async (text: string): Promise<{ delivered: boolean; messageId: number | null }> => {
        stopped = true;
        pending = null;
        await flushing?.catch(() => undefined);
        if (messageId === null) return { delivered: false, messageId: null };
        await this.finalizeLiveMessage(chatId, messageId, text);
        return { delivered: true, messageId };
      },
      stop(): void {
        stopped = true;
        pending = null;
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
  ): Promise<void> {
    const chunks = splitTelegramText(text, LIVE_MESSAGE_LIMIT);
    const head = chunks[0] ?? text.trim();
    if (head) {
      await this.dispatch("editMessageText", chatId, {
        chat_id: chatId,
        message_id: messageId,
        ...renderTelegramText(head),
      });
    }
    for (const rest of chunks.slice(1)) {
      await this.sendMessage(chatId, rest);
    }
  }

  async setReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.dispatch("setMessageReaction", chatId, {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
      is_big: false,
    }, "status");
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
    if (method === "editMessageText") {
      try {
        return await this.call(method, payload);
      } catch (error) {
        // Итоговый текст уже показан целиком: править нечего. Для
        // Telegram это ошибка, для доставки — доставленный ответ.
        if (isTelegramNotModified(error)) return {};
        if (!isTelegramMarkupError(error)) throw error;
        // Разметку Telegram не принял: ответ уходит без оформления, но
        // уходит. Текст в лог не пишется — он пользовательский.
        this.logger.warn("Telegram отклонил разметку правки, отправляю без неё", {
          chatId: Number(payload.chat_id) || null,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
        const plain = { ...payload };
        delete plain.parse_mode;
        plain.text = stripTags(String(payload.text ?? ""));
        try {
          return await this.call(method, plain);
        } catch (retryError) {
          if (isTelegramNotModified(retryError)) return {};
          throw retryError;
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
    return await this.call(method, payload);
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

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram getFile не вернул file_path");
    const response = await fetch(`${this.baseUrl}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      path: file.file_path,
    };
  }

  startTyping(chatId: number, intervalMs: number): () => void {
    let stopped = false;
    const tick = () => {
      if (!stopped) {
        void this.sendChatAction(chatId).catch((error) => {
          this.logger.debug("Не удалось обновить Telegram typing", {
            chatId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
    tick();
    const timer = setInterval(tick, Math.max(intervalMs, 2_000));
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
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

  private async dispatch(
    method: string,
    chatId: number,
    payload: Record<string, unknown>,
    priority?: DeliveryPriority,
  ): Promise<unknown> {
    if (!this.outbox) {
      const started = performance.now();
      try {
        return await this.call(method, payload);
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
      );
    }
    return body.result as T;
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}
