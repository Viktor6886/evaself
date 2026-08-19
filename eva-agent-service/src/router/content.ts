/**
 * Содержимое сообщения и непрозрачное состояние провайдера.
 *
 * Два разных повода тронуть внутренний формат роутера, и оба про потерю
 * данных на границе.
 *
 * Первый — изображения. Сообщение приводилось к строке, поэтому картинка
 * до модели не доходила никогда: путь `content[] → string` оставлял от
 * неё пустое место. Теперь текстовая выжимка остаётся в `content` (её
 * читает половина роутера — журнал, лимиты, классификация), а полное
 * содержимое едет рядом, в `parts`.
 *
 * Второй — служебные поля reasoning-моделей. Провайдер требует вернуть
 * их вместе с результатом инструмента без изменений; роутер их не читает
 * и не показывает, а только переносит: провайдер → роутер → Letta →
 * результат инструмента → роутер → тот же провайдер. Содержимое этих
 * полей нигде не разбирается и не логируется (инвариант 19).
 */

import type { LlmContentPart, LlmMessage } from "./types.js";

/**
 * Поля, которые переносятся как непрозрачное состояние.
 *
 * Список закрытый: произвольные поля ответа провайдера пересылать обратно
 * нельзя — среди них бывают идентификаторы запроса и учётные данные.
 */
export const PROVIDER_STATE_KEYS = [
  "reasoning",
  "reasoning_details",
  "reasoning_content",
  "thinking",
  "thinking_blocks",
  "redacted_reasoning",
  "signature",
  "encrypted_content",
] as const;

export function pickProviderState(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const state: Record<string, unknown> = {};
  for (const key of PROVIDER_STATE_KEYS) {
    if (source[key] !== undefined && source[key] !== null) state[key] = source[key];
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

interface ParsedContent {
  /** Текстовая выжимка: то, что раньше было единственным содержимым. */
  text: string;
  /** Полное содержимое, если в нём есть что-то кроме текста. */
  parts?: LlmContentPart[];
}

/** Разобрать содержимое сообщения OpenAI-совместимого запроса. */
export function parseContent(content: unknown): ParsedContent {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };

  const parts: LlmContentPart[] = [];
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) { texts.push(item); parts.push({ type: "text", text: item }); }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "image_url" || record.image_url) {
      const url = typeof record.image_url === "string"
        ? record.image_url
        : typeof (record.image_url as { url?: unknown })?.url === "string"
          ? String((record.image_url as { url: string }).url)
          : "";
      if (url) parts.push({ type: "image_url", url });
      continue;
    }
    if (type === "image" && record.source && typeof record.source === "object") {
      // Форма Anthropic и Letta Agent SDK: base64 внутри `source`.
      const source = record.source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
      if (typeof source.data === "string" && typeof source.media_type === "string") {
        parts.push({ type: "image", media_type: source.media_type, data: source.data });
      } else if (typeof source.url === "string") {
        parts.push({ type: "image_url", url: source.url });
      }
      continue;
    }
    if (typeof record.text === "string" && record.text) {
      texts.push(record.text);
      parts.push({ type: "text", text: record.text });
    }
  }
  const text = texts.join("\n").trim();
  return parts.some((part) => part.type !== "text")
    ? { text, parts }
    : { text };
}

/** Есть ли в запросе изображение. Отвечает само содержимое, а не заявление. */
export function containsImage(messages: LlmMessage[]): boolean {
  return messages.some((message) =>
    message.parts?.some((part) => part.type !== "text") === true);
}

/** Разобрать `data:`-адрес в пару «тип, base64». */
export function decodeDataUri(url: string): { media_type: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/is.exec(url.trim());
  if (!match) return null;
  return { media_type: match[1]!.toLowerCase(), data: match[2]! };
}
