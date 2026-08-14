/**
 * Разбор входных данных дневника.
 *
 * Отдельно от сервиса по одной причине: это единственная часть, которая
 * читает всё, что прислал браузер, и она обязана быть скучной и
 * целиком видимой. Сервис ниже уже работает с проверенными значениями и
 * не должен снова гадать, что пришло.
 */

import { badRequest } from "../../errors.js";
import type { JournalLink } from "./service.js";

const MAX_PEOPLE_PER_ENTRY = 20;
const MAX_LINKS_PER_ENTRY = 20;

/**
 * Нормализация имени выполняется в SQL, а не в JavaScript: значение
 * попадает и в `INSERT`, и в `ON CONFLICT`, и расхождение между двумя
 * реализациями свёртки регистра дало бы дубли карточек, которые снаружи
 * выглядят одинаково.
 */
export function normalizeSql(param: string): string {
  return `btrim(lower(regexp_replace(${param}, '\\s+', ' ', 'g')))`;
}

export function personNames(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest("Ожидается список людей");
  const names: string[] = [];
  for (const item of value.slice(0, MAX_PEOPLE_PER_ENTRY)) {
    const name = typeof item === "string"
      ? item
      : item && typeof item === "object"
        ? (item as { display_name?: unknown }).display_name
        : null;
    const text = typeof name === "string" ? name.trim().slice(0, 200) : "";
    if (text) names.push(text);
  }
  return names;
}

export function entryLinks(value: unknown): JournalLink[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest("Ожидается список связей");
  const links: JournalLink[] = [];
  for (const item of value.slice(0, MAX_LINKS_PER_ENTRY)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { target_type?: unknown; target_id?: unknown };
    const type = optionalEnum(
      raw.target_type,
      ["goal", "task", "checkin"] as const,
      "Тип связи",
    );
    if (!type) continue;
    links.push({ target_type: type, target_id: String(positiveId(raw.target_id, "связи")) });
  }
  return links;
}

export function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${name}: требуется текст`);
  }
  return value.trim().slice(0, max);
}

export function optionalText(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw badRequest("Ожидается текст");
  return value.trim().slice(0, max) || null;
}

export function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`Ожидается целое число от ${min} до ${max}`);
  }
  return parsed;
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${name}: недопустимое значение`);
  }
  return value as T;
}

export function optionalDate(value: unknown): string | null {
  const text = optionalText(value, 10);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw badRequest("Ожидается дата YYYY-MM-DD");
  }
  return text;
}

export function positiveId(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw badRequest(`Некорректный ID ${name}`);
  }
  return parsed;
}

export function clampInteger(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
