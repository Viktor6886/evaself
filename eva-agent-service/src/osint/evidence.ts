/**
 * Доказательства и их отпечатки.
 *
 * Отпечаток нужен, чтобы через месяц сказать «вот ровно это мы видели»,
 * даже если сырой ответ уже удалён по сроку хранения. Поэтому у
 * структурированного ответа хешируется канонический JSON: тот же объект
 * с другим порядком ключей — то же доказательство, а не новое.
 */

import { createHash } from "node:crypto";

import type { Evidence } from "./types.js";

/** Самая длинная цитата, которую имеет смысл хранить как доказательство. */
export const MAX_QUOTE_LENGTH = 2_000;

/** JSON с отсортированными ключами: порядок полей ответа API не меняет отпечаток. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Цитата со страницы.
 *
 * Цитата, которой нет в тексте источника, доказательством не является:
 * так модель выдаёт свою догадку за найденное. Проверка та же, что у
 * `ResearchOrchestrator`: цитата обязана буквально входить в текст.
 */
export function quoteEvidence(quote: string, sourceText: string): Evidence | null {
  const value = quote.trim();
  if (!value || value.length > MAX_QUOTE_LENGTH || !sourceText.includes(value)) return null;
  return { kind: "quote", quote: value, hash: sha256(value) };
}

/** Фрагмент структурированного ответа сборщика: сам фрагмент и его отпечаток. */
export function structuredEvidence(data: unknown): Evidence {
  return { kind: "structured", data, hash: sha256(canonicalJson(data)) };
}
