/**
 * Снимок страницы для модели.
 *
 * Не HTML, а дерево доступности (`page.ariaSnapshot({ mode: "ai" })`):
 * роли, имена и значения элементов со ссылками `[ref=e12]`, по которым
 * модель нажимает и печатает. Он в десятки раз короче разметки и не несёт
 * скриптов, стилей и скрытого текста — того, чем чаще всего прячут
 * инструкции для модели.
 *
 * Перед отдачей снимок чистится: значение поля пароля и одноразового
 * кода скрывается, распространённые форматы ключей и токенов, которые
 * страница показала на экране, маскируются. Длинный снимок обрезается по
 * границе строки — элемент не рвётся посередине.
 *
 * Идея усечения по строкам и маскирования секретов на границе модели —
 * из Hermes Agent (tools/browser_tool_snapshot.py, MIT, Nous Research).
 */

import type { Page } from "playwright-core";

export interface PageSnapshot {
  url: string;
  title: string;
  snapshot: string;
  truncated: boolean;
  totalLines: number;
  nextOffset: number | null;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

export function redactSecrets(text: string): string {
  let value = text;
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, "[секрет скрыт]");
  return value;
}

/** Строка поля со значением: `- textbox "Пароль" [ref=e5]: значение`. */
const FIELD_WITH_VALUE = /^(\s*- (?:textbox|searchbox|combobox)\b[^\n]*?\[ref=([A-Za-z0-9]+)\][^\n]*?): (.+)$/gm;
const MAX_FIELDS_CHECKED = 50;

/**
 * Скрыть значения полей, которые нельзя показывать модели: пароли,
 * одноразовые коды, номера карт. Роль `textbox` у них та же, что у
 * обычного поля, поэтому тип спрашивается у самого элемента.
 */
export async function redactSensitiveFields(page: Page, snapshot: string, timeoutMs: number): Promise<string> {
  const candidates = [...snapshot.matchAll(FIELD_WITH_VALUE)].slice(0, MAX_FIELDS_CHECKED);
  const sensitive = new Set<string>();
  await Promise.all(candidates.map(async (match) => {
    const ref = match[2]!;
    const hidden = await page.locator(`aria-ref=${ref}`).evaluate((element) => {
      const input = element as { type?: string; autocomplete?: string };
      const type = String(input.type ?? "").toLowerCase();
      const autocomplete = String(input.autocomplete ?? "").toLowerCase();
      return type === "password" || /cc-|one-time-code|current-password|new-password/.test(autocomplete);
    }, undefined, { timeout: timeoutMs }).catch(() => true);
    if (hidden) sensitive.add(ref);
  }));
  if (!sensitive.size) return snapshot;
  return snapshot.replace(FIELD_WITH_VALUE, (line, head: string, ref: string) => (sensitive.has(ref) ? `${head}: [скрыто]` : line));
}

/**
 * Часть снимка с строки `offset`. Дерево доступности охватывает весь
 * документ, а не видимую область: хвост длинной страницы прокруткой не
 * достать, его отдаёт следующий вызов с `offset`.
 */
export function truncateLines(text: string, maxChars: number, offset = 0): {
  text: string; truncated: boolean; totalLines: number; nextOffset: number | null;
} {
  const all = text.split("\n");
  const start = Math.min(Math.max(0, offset), all.length);
  const lines = all.slice(start);
  const kept: string[] = [];
  let size = 0;
  const reserve = Math.min(160, Math.floor(maxChars / 4));
  for (const line of lines) {
    if (size + line.length + 1 > maxChars - reserve) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length === lines.length) return { text: kept.join("\n"), truncated: false, totalLines: all.length, nextOffset: null };
  const nextOffset = start + kept.length;
  kept.push(`[… показаны строки ${start + 1}–${nextOffset} из ${all.length}: продолжение — browser_snapshot с offset=${nextOffset}]`);
  return { text: kept.join("\n"), truncated: true, totalLines: all.length, nextOffset };
}

export async function takeSnapshot(page: Page, options: { maxChars: number; timeoutMs: number; offset?: number }): Promise<PageSnapshot> {
  const raw = await page.ariaSnapshot({ mode: "ai", timeout: options.timeoutMs });
  const clean = redactSecrets(await redactSensitiveFields(page, raw, Math.min(2_000, options.timeoutMs)));
  const { text, truncated, totalLines, nextOffset } = truncateLines(clean, options.maxChars, options.offset ?? 0);
  const title = await page.title().catch(() => "");
  return { url: page.url(), title: redactSecrets(title.slice(0, 300)), snapshot: text, truncated, totalLines, nextOffset };
}
