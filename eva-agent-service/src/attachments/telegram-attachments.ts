/**
 * Что пришло вместе с сообщением: картинка, звук или файл.
 *
 * Раньше Telegram-путь разбирал вложения сам и по одному правилу на
 * каждый вид: фотография уходила отдельным запросом к модели за
 * описанием (до агента доезжал текст, а не изображение), документ читался
 * только как plain text, а файл, отправленный «документом», не
 * распознавался ни как картинка, ни как голос — хотя ровно так их и
 * отправляют с телефона.
 *
 * Здесь один разбор: вид вложения определяется по типу и имени файла,
 * текст файла достаёт общий с базой знаний парсер, а изображение уходит
 * дальше как изображение.
 *
 * Всё, что пришло файлом, — недоверенные данные. Подпись человека к ним
 * не относится: она остаётся его репликой.
 */

import {
  SUPPORTED_DOCUMENT_MIME,
  documentMimeOf,
  extractDocumentText,
} from "../knowledge/document-text.js";
import { sanitizeUntrustedContent } from "../knowledge/security.js";
import type { TelegramFile, TelegramMessage } from "../telegram.js";

/** Что модель принимает изображением. Список — из Agent SDK. */
export const VISION_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type MediaKind = "text" | "voice" | "image" | "document" | "unsupported";

export interface AttachmentImage {
  mediaType: string;
  base64: string;
}

export interface AttachmentLimits {
  /** Потолок изображения. */
  imageBytes: number;
  /** Потолок документа: тот же, что у приёма в базу знаний. */
  documentBytes: number;
  /** Сколько знаков текста документа уходит в ход. */
  documentCharacters: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  imageBytes: 10 * 1024 * 1024,
  documentBytes: 10 * 1024 * 1024,
  documentCharacters: 60_000,
};

/**
 * Вид сообщения.
 *
 * Файл, отправленный документом, разбирается по своему типу: снимок
 * экрана остаётся изображением, голосовая запись — голосом. Именно так
 * их и присылают: «отправить как файл» в Telegram — обычное действие.
 */
export function telegramMediaKind(message: TelegramMessage): MediaKind {
  if (message.voice || message.audio) return "voice";
  if (message.photo?.length) return "image";
  const document = message.document;
  if (document) {
    const mime = document.mime_type?.split(";")[0]?.trim().toLowerCase() ?? "";
    const name = document.file_name ?? "";
    if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name)) return "image";
    if (mime.startsWith("audio/") || /\.(ogg|oga|mp3|m4a|wav|opus|aac|flac)$/i.test(name)) {
      return "voice";
    }
    return "document";
  }
  if (message.text || message.caption) return "text";
  return "unsupported";
}

/** Файл изображения сообщения: снимок наибольшего размера или документ. */
export function imageFileOf(message: TelegramMessage): TelegramFile | undefined {
  return message.photo?.at(-1) ?? message.document;
}

/** Файл звука сообщения: голосовое, аудио или тот же документ. */
export function audioFileOf(message: TelegramMessage): TelegramFile | undefined {
  return message.voice ?? message.audio ?? message.document;
}

interface Downloader {
  downloadFile(
    fileId: string,
    options?: { maxBytes?: number },
  ): Promise<{ bytes: Uint8Array; path: string; contentType: string | null }>;
}

export class TelegramAttachmentReader {
  private readonly limits: AttachmentLimits;

  constructor(
    private readonly telegram: Downloader,
    limits: Partial<AttachmentLimits> = {},
    private readonly detect: (bytes: Uint8Array) => Promise<string | null> = detectImageMime,
  ) {
    this.limits = { ...DEFAULT_ATTACHMENT_LIMITS, ...limits };
  }

  /**
   * Изображение для модели.
   *
   * Тип берётся у содержимого, а не у имени файла: `photo.png`, внутри
   * которого лежит что угодно, изображением от этого не становится.
   */
  async image(file: TelegramFile): Promise<AttachmentImage> {
    if ((file.file_size ?? 0) > this.limits.imageBytes) {
      throw new AttachmentError("attachment_too_large", "Изображение больше допустимого размера");
    }
    const downloaded = await this.telegram.downloadFile(file.file_id, {
      maxBytes: this.limits.imageBytes,
    });
    const mediaType = await this.detect(downloaded.bytes);
    if (!mediaType || !VISION_MEDIA_TYPES.has(mediaType)) {
      throw new AttachmentError(
        "attachment_not_an_image",
        "Файл не похож на изображение: поддерживаются PNG, JPEG, GIF и WebP",
      );
    }
    return { mediaType, base64: Buffer.from(downloaded.bytes).toString("base64") };
  }

  /**
   * Текст документа — данные, а не инструкции.
   *
   * Разбор общий с приёмом в базу знаний: те же проверки подделки типа,
   * zip-бомбы и предела страниц.
   */
  async document(file: TelegramFile): Promise<string> {
    const filename = file.file_name ?? "файл";
    const mime = documentMimeOf(filename, file.mime_type ?? null);
    if (!mime || !SUPPORTED_DOCUMENT_MIME.has(mime)) {
      throw new AttachmentError(
        "attachment_type_unsupported",
        "Пока читаю PDF, DOCX, TXT, MD, JSON, CSV, YAML и HTML",
      );
    }
    if ((file.file_size ?? 0) > this.limits.documentBytes) {
      throw new AttachmentError("attachment_too_large", "Документ больше допустимого размера");
    }
    const downloaded = await this.telegram.downloadFile(file.file_id, {
      maxBytes: this.limits.documentBytes,
    });
    const pages = await extractDocumentText(Buffer.from(downloaded.bytes), mime);
    const text = pages.join("\n\n").slice(0, this.limits.documentCharacters);
    if (!text.trim()) {
      throw new AttachmentError("attachment_empty", "В документе не нашлось текста");
    }
    return [
      `Файл: ${filename.slice(0, 200)}`,
      sanitizeUntrustedContent(text),
    ].join("\n");
  }
}

/** Отказ вложения с кодом: человеку — фраза, в журнал — код. */
export class AttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

async function detectImageMime(bytes: Uint8Array): Promise<string | null> {
  const { fileTypeFromBuffer } = await import("file-type");
  const detected = await fileTypeFromBuffer(bytes);
  return detected?.mime ?? null;
}
