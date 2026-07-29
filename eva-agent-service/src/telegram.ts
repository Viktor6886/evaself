import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { Config } from "./config.js";
import type { OutboxDelivery, OutboxTransport } from "./delivery/outbox.js";
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
}

export class TelegramClient implements OutboxTransport {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private outbox: OutboxDelivery | null = null;
  private readonly deliveryContext = new AsyncLocalStorage<{ prefix: string; sequence: number }>();

  constructor(config: Config, logger: Logger) {
    this.token = config.telegramBotToken;
    this.baseUrl = config.telegramApiBaseUrl.replace(/\/+$/, "");
    this.logger = logger;
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  setOutbox(outbox: OutboxDelivery): void {
    this.outbox = outbox;
  }

  async withDeliveryContext<T>(prefix: string, work: () => Promise<T>): Promise<T> {
    return await this.deliveryContext.run({ prefix, sequence: 0 }, work);
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: Record<string, unknown> = {},
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    const chunks = splitTelegramText(text);
    for (const chunk of chunks) {
      results.push(await this.dispatch("sendMessage", chatId, {
        chat_id: chatId,
        text: chunk,
        ...options,
      }));
    }
    return results;
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action });
  }

  /**
   * Reproduces the old progressive welcome without persisting dozens of
   * partial messages. Telegram drafts are ephemeral; the final sendMessage is
   * always used to store the complete text.
   */
  async sendProgressiveMessage(chatId: number, text: string): Promise<unknown[]> {
    const clean = text.trim();
    if (chatId <= 0 || clean.length === 0 || clean.length > 4_096) {
      return await this.sendMessage(chatId, clean);
    }
    const draftId = Math.max(1, Date.now() % 2_147_483_647);
    const words = clean.split(/\s+/);
    const stepSize = Math.max(1, Math.ceil(words.length / 12));
    try {
      for (let end = stepSize; end < words.length; end += stepSize) {
        await this.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: draftId,
          text: words.slice(0, end).join(" "),
        });
        await delay(120);
      }
    } catch (error) {
      this.logger.debug("Telegram не поддержал динамический черновик", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return await this.sendMessage(chatId, clean);
  }

  async setReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
      is_big: false,
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
    await this.sendVoiceDirect(chatId, audio, filename);
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
  ): Promise<unknown> {
    if (!this.outbox) return await this.call(method, payload);
    const context = this.deliveryContext.getStore();
    const idempotencyKey = context
      ? `${context.prefix}:${String(context.sequence++).padStart(3, "0")}:${method}`
      : undefined;
    return await this.outbox.send({ method, chatId, payload, idempotencyKey });
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
      throw new Error(
        `Telegram ${method}: ${body.description ?? `HTTP ${response.status}`}`.slice(0, 1000),
      );
    }
    return body.result as T;
  }
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
