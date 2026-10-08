/**
 * Перевод значений между базой и ячейками архива — в обе стороны.
 *
 * Выгрузка и загрузка обязаны понимать одно и то же представление: дата,
 * записанная одной стороной, читается другой без потерь. Поэтому оба
 * направления живут в одном модуле.
 *
 * Ячейку человек мог поправить руками, а Excel — переписать по-своему:
 * дата превращается в номер дня, «да» — в TRUE, число — в текст с
 * запятой. Разбор принимает всё это, а не только то, что пишет выгрузка.
 */

import { DateTime } from "luxon";

import { excelSerial } from "./xlsx-writer.js";
import { serialToLocal, type ReadCell } from "./xlsx-reader.js";

/** Ошибка значения ячейки; текст показывается человеку как есть. */
export class CellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CellError";
  }
}

// ---------------------------------------------------------------------
// база → ячейка
// ---------------------------------------------------------------------

/** Момент времени → стенные часы человека `YYYY-MM-DDTHH:mm`. */
export function wallClock(value: unknown, zone: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const local = DateTime.fromJSDate(date, { zone });
  return local.isValid ? local.toFormat("yyyy-LL-dd'T'HH:mm") : null;
}

/** Стенные часы в поясе человека → момент времени. */
export function instantOf(wall: string, zone: string): Date | null {
  const local = DateTime.fromISO(wall, { zone });
  return local.isValid ? local.toJSDate() : null;
}

/** Значение jsonb для ячейки: список строк — по строке на пункт. */
export function jsonCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((item) => typeof item === "string" && !item.includes("\n"))) return value.join("\n");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return value || null;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return null;
  return JSON.stringify(value);
}

export function listCell(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length > 0 ? items.join("\n") : null;
}

export function labelCell(value: unknown, labels: Readonly<Record<string, string>>): string | null {
  if (typeof value !== "string" || !value) return null;
  return labels[value] ?? value;
}

export function numberCell(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

// ---------------------------------------------------------------------
// ячейка → значение для записи
// ---------------------------------------------------------------------

export function text(cell: ReadCell, max: number): string | null {
  if (cell === null || cell === undefined) return null;
  const value = typeof cell === "boolean" ? (cell ? "да" : "нет") : String(cell);
  const clean = value.replace(/\r\n?/g, "\n").trim();
  if (!clean) return null;
  if (clean.length > max) throw new CellError(`длиннее ${max} знаков`);
  return clean;
}

export function requiredText(cell: ReadCell, max: number, name: string): string {
  const value = text(cell, max);
  if (value === null) throw new CellError(`не заполнено поле «${name}»`);
  return value;
}

export function integer(cell: ReadCell, min: number, max: number, name: string): number | null {
  const value = decimal(cell, name);
  if (value === null) return null;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CellError(`«${name}»: нужно целое число от ${min} до ${max}`);
  }
  return value;
}

/** Число из ячейки: и настоящее число, и текст вроде «1 234,50». */
export function decimal(cell: ReadCell, name: string): number | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number") return cell;
  if (typeof cell === "boolean") throw new CellError(`«${name}»: нужно число`);
  const normalized = cell.trim().replace(/[\s  ]/g, "").replace(",", ".");
  if (!normalized) return null;
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) throw new CellError(`«${name}»: нужно число`);
  return Number(normalized);
}

const YES = new Set(["да", "yes", "true", "1", "истина", "вкл", "+", "y", "д"]);
const NO = new Set(["нет", "no", "false", "0", "ложь", "выкл", "-", "n", "н"]);

export function yesNo(cell: ReadCell, name: string): boolean | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "boolean") return cell;
  const value = String(cell).trim().toLocaleLowerCase("ru");
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new CellError(`«${name}»: ожидается «да» или «нет»`);
}

function realDate(year: number, month: number, day: number): boolean {
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    && year >= 1900 && year <= 9999;
}

const pad = (value: number | string) => String(value).padStart(2, "0");

/**
 * Дата и время из ячейки → стенные часы `YYYY-MM-DDTHH:mm` в поясе файла.
 * Понимает номер дня Excel, ISO и привычное «07.10.2026 14:30». Момент со
 * смещением (`…+03:00`, `…Z`) переводится в пояс файла.
 */
export function dateTime(cell: ReadCell, options: { date1904: boolean; zone: string }, name: string): string | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number") {
    const value = serialToLocal(cell, options.date1904);
    if (!value) throw new CellError(`«${name}»: не похоже на дату`);
    return value;
  }
  if (typeof cell === "boolean") throw new CellError(`«${name}»: не похоже на дату`);
  const value = cell.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const moment = DateTime.fromISO(value, { setZone: true });
    if (!moment.isValid) throw new CellError(`«${name}»: не похоже на дату`);
    return moment.setZone(options.zone).toFormat("yyyy-LL-dd'T'HH:mm");
  }
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(value);
  let parts: [number, number, number, number, number] | null = null;
  if (match) {
    parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0)];
  } else {
    match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(value);
    if (match) parts = [Number(match[3]), Number(match[2]), Number(match[1]), Number(match[4] ?? 0), Number(match[5] ?? 0)];
  }
  if (!parts) throw new CellError(`«${name}»: не похоже на дату — нужно 07.10.2026 или 2026-10-07`);
  const [year, month, day, hour, minute] = parts;
  if (!realDate(year, month, day) || hour > 23 || minute > 59) throw new CellError(`«${name}»: такой даты нет`);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

export function date(cell: ReadCell, options: { date1904: boolean; zone: string }, name: string): string | null {
  const value = dateTime(cell, options, name);
  return value === null ? null : value.slice(0, 10);
}

/** Список: по пункту на строку ячейки. */
export function list(cell: ReadCell, maxItems: number, maxLength: number, name: string): string[] {
  const value = text(cell, maxItems * (maxLength + 1));
  if (value === null) return [];
  const items = value.split("\n").map((item) => item.trim()).filter(Boolean);
  if (items.length > maxItems) throw new CellError(`«${name}»: больше ${maxItems} пунктов`);
  if (items.some((item) => item.length > maxLength)) throw new CellError(`«${name}»: пункт длиннее ${maxLength} знаков`);
  return items;
}

/**
 * Значение jsonb: выгрузка пишет список строк построчно, а всё прочее —
 * JSON. Разбор возвращает то же, что было в базе.
 */
export function jsonValue(cell: ReadCell, name: string): unknown {
  const value = text(cell, 100_000);
  if (value === null) return null;
  if (/^[[{"]/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Не JSON — обычный текст, который начинается со скобки.
    }
  }
  const items = value.split("\n").map((item) => item.trim()).filter(Boolean);
  if (items.length > 200) throw new CellError(`«${name}»: больше 200 пунктов`);
  return items;
}

/** Значение из подписи: принимает и подпись, и исходный код. */
export function labelled<T extends string>(
  cell: ReadCell,
  labels: Readonly<Record<T, string>>,
  name: string,
): T | null {
  const value = text(cell, 200);
  if (value === null) return null;
  const wanted = fold(value);
  for (const [code, label] of Object.entries(labels) as Array<[T, string]>) {
    if (fold(code) === wanted || fold(label) === wanted) return code;
  }
  throw new CellError(`«${name}»: значение «${value.slice(0, 40)}» не из списка (${Object.values(labels).join(", ")})`);
}

/** Сравнение подписей без регистра, лишних пробелов и различия «е»/«ё». */
export function fold(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** Проверка, что строка — настоящая дата/время для записи в Excel. */
export function validWall(value: string | null): string | null {
  return value !== null && excelSerial(value) !== null ? value : null;
}

// ---------------------------------------------------------------------
// строка базы → значение ячейки
// ---------------------------------------------------------------------

export const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export const intOf = (value: unknown): number | null => {
  const number = numberCell(value);
  return number === null ? null : Math.trunc(number);
};

export const boolOf = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** Копейки → рубли. Округление до копейки: в базе — целое число копеек. */
export function minorToMajor(value: unknown): number | null {
  const number = numberCell(value);
  return number === null ? null : Math.round(number) / 100;
}
