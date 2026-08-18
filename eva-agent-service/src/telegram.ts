import {
  formatEvaReply,
  isValidTelegramHtml,
  splitTelegramHtml,
  stripTags,
} from "./telegram-format.js";
import { randomInt, timingSafeEqual } from "node:crypto";
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

export interface TelegramMessageDraft {
  readonly chatId: number;
  readonly draftId: number;
  stop(): void;
}

const DRAFT_WORDS_PER_UPDATE = 4;
const DRAFT_UPDATE_DELAY_MS = 500;
const DRAFT_KEEPALIVE_MS = 20_000;
/**
 * Как часто черновик догоняет поток модели.
 *
 * Токены приходят десятками в секунду, а Telegram считает частоту
 * обращений к чату: обновлять черновик на каждый срез значит выбрать
 * лимит на первых секундах ответа и получить 429 на самой доставке.
 * Промежуточные срезы поэтому не отправляются вовсе — уходит только
 * последнее состояние текста, и человек всё равно видит, как ответ
 * растёт.
 */
const DRAFT_STREAM_INTERVAL_MS = 900;

/**
 * Черновик, который догоняет поток модели.
 *
 * `push` вызывается из потока и ничего не ждёт: он лишь запоминает
 * текст. Отправкой занимается таймер, поэтому генерация не платит за
 * сеть Telegram, а частота обращений остаётся под контролем.
 */
export interface TelegramStreamingDraft {
  /** Показать этот текст целиком. Промежуточные состояния схлопываются. */
  push(text: string): void;
  /** Дождаться отправки последнего состояния и остановить таймер. */
  finish(): Promise<void>;
  /** Остановить, ничего не досылая: ход отменён или оборвался. */
  stop(): void;
  /** Сколько раз черновик реально обновлялся: для проверок и разбора. */
  readonly updates: number;
  /** Что показано человеку сейчас. */
  readonly shown: string;
}

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
   * Reserve space for the answer before the model finishes. Bot API 10.0
   * explicitly allows an empty draft and renders it as a “Thinking…”
   * placeholder. It is refreshed because Telegram drafts are ephemeral.
   */
  async startMessageDraft(chatId: number): Promise<TelegramMessageDraft | null> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return null;
    const draftId = randomInt(1, 2_147_483_647);
    let stopped = false;
    let refreshing = false;
    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        await this.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: draftId,
          text: "",
        });
      } finally {
        refreshing = false;
      }
    };

    try {
      await refresh();
    } catch (error) {
      stopped = true;
      this.logger.debug("Telegram не поддержал пустой черновик", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const timer = setInterval(() => {
      void refresh().catch((error) => {
        this.logger.debug("Не удалось обновить пустой Telegram-черновик", {
          chatId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, DRAFT_KEEPALIVE_MS);
    timer.unref();

    return {
      chatId,
      draftId,
      stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * Черновик, который показывает ответ, пока модель его пишет.
   *
   * Раньше человек видел пустой черновик всё время генерации, а текст
   * появлялся разом в конце: обычный ход не пользовался потоком вовсе.
   * Здесь тот же черновик обновляется по ходу, но не чаще, чем раз в
   * `DRAFT_STREAM_INTERVAL_MS`, и всегда последним состоянием — очередь
   * промежуточных состояний не копится.
   *
   * Отказ Telegram черновик не роняет ход: показ — украшение, ответ
   * доставляется отдельным durable-сообщением.
   */
  startStreamingDraft(
    chatId: number,
    draft: TelegramMessageDraft | null | Promise<TelegramMessageDraft | null>,
    options: { intervalMs?: number; now?: () => number } = {},
  ): TelegramStreamingDraft {
    const intervalMs = Math.max(0, options.intervalMs ?? DRAFT_STREAM_INTERVAL_MS);
    const now = options.now ?? (() => Date.now());
    const resolveDraft = Promise.resolve(draft).catch(() => null);
    let pending: string | null = null;
    let shown = "";
    let updates = 0;
    let lastSentAt = -Infinity;
    let flushing: Promise<void> | null = null;
    let stopped = false;
    // Досылка последнего состояния не ждёт промежутка: ход уже кончился,
    // и держать доставку ради выдержки между черновиками незачем.
    let forced = false;

    const write = async (text: string): Promise<void> => {
      const target = await resolveDraft;
      const draftId = target?.draftId;
      if (draftId === undefined) return;
      await this.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text });
      shown = text;
      updates += 1;
      lastSentAt = now();
    };

    const flush = async (): Promise<void> => {
      while (!stopped && pending !== null) {
        const wait = forced ? 0 : intervalMs - (now() - lastSentAt);
        if (wait > 0) await delay(wait);
        if (stopped) return;
        const text = pending;
        pending = null;
        if (text === null || text === shown) continue;
        try {
          await write(text);
        } catch (error) {
          // Черновик — не доставка. Его отказ не должен ни ронять ход,
          // ни превращаться в повтор: ответ уйдёт обычным сообщением.
          this.logger.debug("Telegram не принял потоковый черновик", {
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
        if (!clean || clean === shown) return;
        pending = clean;
        schedule();
      },
      async finish(): Promise<void> {
        forced = true;
        await flushing;
        // Последнее состояние могло прийти позже последней отправки.
        if (!stopped && pending !== null && pending !== shown) {
          schedule();
          await flushing;
        }
        stopped = true;
      },
      stop(): void {
        stopped = true;
        pending = null;
      },
      get updates(): number { return updates; },
      get shown(): string { return shown; },
    };
  }

  /**
   * Reveals a completed answer by whole words in the same animated Telegram
   * draft. Only the final sendMessage is durable and stored in the outbox.
   */
  async sendProgressiveMessage(
    chatId: number,
    text: string,
    draft?: TelegramMessageDraft | null,
  ): Promise<unknown[]> {
    const clean = text.trim();
    draft?.stop();
    if (chatId <= 0 || clean.length === 0 || clean.length > 4_096) {
      return await this.sendMessage(chatId, clean);
    }

    const activeDraft = draft === undefined
      ? await this.startMessageDraft(chatId)
      : draft;
    activeDraft?.stop();
    const draftId = activeDraft?.draftId ?? randomInt(1, 2_147_483_647);

    try {
      for (const draftText of progressiveTelegramDrafts(clean)) {
        await this.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: draftId,
          text: draftText,
        });
        await delay(DRAFT_UPDATE_DELAY_MS);
      }
    } catch (error) {
      this.logger.debug("Telegram не поддержал пословный черновик", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return await this.sendMessage(chatId, clean);
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

/**
 * Build cumulative draft snapshots without ever cutting a word or changing
 * the whitespace inside the generated answer.
 */
export function progressiveTelegramDrafts(
  text: string,
  wordsPerUpdate = DRAFT_WORDS_PER_UPDATE,
): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const tokens = clean.match(/\S+\s*/gu) ?? [];
  const step = Math.max(1, Math.floor(wordsPerUpdate));
  const snapshots: string[] = [];
  for (let end = step; end < tokens.length; end += step) {
    snapshots.push(tokens.slice(0, end).join("").trimEnd());
  }
  if (snapshots.length === 0) snapshots.push(clean);
  return snapshots;
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
