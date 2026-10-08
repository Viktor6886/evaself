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
    // Стек не собирается: это ответ человеку, а не сбой кода, а в файле на
    // десятки тысяч строк с ошибками сбор стека стоил секунды процессора.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(message);
    Error.stackTraceLimit = limit;
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

/**
 * Пробелы по краям — тот же набор, что срезает `String.prototype.trim`.
 * Он же — в SQL хэша содержания (`hashSql`): у кода и базы одно и то же
 * представление «того же текста», иначе неразрывный пробел на краю
 * заметки превращал повторную загрузку в новую заметку.
 */
export const EDGE_SPACE_CODES: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/**
 * Управляющие символы, которых нет в XML 1.0: файл Excel их не переносит
 * (запись вырезает их), а PostgreSQL не хранит NUL. Они вырезаются из
 * всего, что пришло из файла, и не учитываются при сравнении.
 */
export const CONTROL_CODES: readonly number[] = [
  ...Array.from({ length: 9 }, (_, index) => index),
  0x0b, 0x0c,
  ...Array.from({ length: 18 }, (_, index) => 0x0e + index),
  0xfffe, 0xffff,
];

/** Пробел ли на краю — одно обращение к таблице по коду: строка из одних пробелов бывает длинной. */
const EDGE = new Uint8Array(0x10000);
for (const code of EDGE_SPACE_CODES) EDGE[code] = 1;
/** Управляющий ли знак — одно обращение к таблице по коду. */
const CONTROL = new Uint8Array(0x10000);
for (const code of CONTROL_CODES) CONTROL[code] = 1;
const controlClass = `[${CONTROL_CODES.map((code) => `\\u${code.toString(16).padStart(4, "0")}`).join("")}]`;
const HAS_CONTROL = new RegExp(controlClass);
const NEEDS_SCRUB = new RegExp(`${controlClass}|\\r`);

type WellFormed = { isWellFormed(): boolean; toWellFormed(): string };

/**
 * Половина суррогатной пары → «�». Так её записал бы и UTF-8 при
 * сохранении, а в JSON она уходила бы экранированной, и jsonb её не
 * принимает.
 */
function wellFormed(value: string): string {
  const text = value as unknown as WellFormed;
  return text.isWellFormed() ? value : text.toWellFormed();
}

/**
 * Управляющие символы прочь, затем (если `lines`) `\r\n` и `\r` → `\n` —
 * в том же порядке, что в SQL хэша. Код за кодом по массиву: регулярное
 * выражение на тексте, где управляющий символ или `\r` через знак, тратит
 * на каждое совпадение в десять раз больше, а такой текст в файле стоит
 * копейки.
 */
function scrubCodes(value: string, lines: boolean): string {
  const bytes = Buffer.from(value, "utf16le");
  const codes = bytes.byteOffset % 2 === 0
    ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
    : new Uint16Array(new Uint8Array(bytes).buffer);
  let size = 0;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if (CONTROL[code] === 0) codes[size++] = code;
  }
  if (lines) {
    let kept = 0;
    for (let index = 0; index < size; index += 1) {
      const code = codes[index]!;
      if (code !== 0x0d) {
        codes[kept++] = code;
        continue;
      }
      codes[kept++] = 0x0a;
      if (index + 1 < size && codes[index + 1] === 0x0a) index += 1;
    }
    size = kept;
  }
  return Buffer.from(codes.buffer, codes.byteOffset, size * 2).toString("utf16le");
}

const CONTROLS = new RegExp(controlClass, "g");

/** Тот же результат регулярными выражениями — для машины с обратным порядком байтов. */
function scrubPatterns(value: string, lines: boolean): string {
  const withoutControls = value.replace(CONTROLS, "");
  return lines ? withoutControls.replace(/\r\n?/g, "\n") : withoutControls;
}

/**
 * `scrubCodes` читает байты UTF-16LE как массив 16-битных кодов, а это
 * верно только на машине с прямым порядком байтов (x86, ARM).
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const scrub = LITTLE_ENDIAN ? scrubCodes : scrubPatterns;

/**
 * Текст в том виде, в каком его сравнивают и хранят: без управляющих
 * символов, с `\n` вместо `\r\n` и `\r`, без половин суррогатных пар и
 * без пробелов по краям — в том же порядке шагов, что `hashSql` в базе.
 * Края — циклом: `\s+$` на длинной строке пробелов квадратичен.
 */
export function cleanText(value: string): string {
  const text = wellFormed(NEEDS_SCRUB.test(value) ? scrub(value, true) : value);
  let start = 0;
  let end = text.length;
  while (start < end && EDGE[text.charCodeAt(start)] === 1) start += 1;
  while (end > start && EDGE[text.charCodeAt(end - 1)] === 1) end -= 1;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

/** Глубже этого JSON из файла не бывает у выгрузки; глубже — не данные, а ловушка для стека. */
const MAX_JSON_DEPTH = 32;

/**
 * Скобок и запятых в одном значении JSON больше этого у выгрузки не
 * бывает. Больше — не данные, а способ заставить разбор создать сотни
 * тысяч объектов из килобайтов текста: отказ до `JSON.parse`.
 */
export const MAX_JSON_STRUCTURE = 4_000;

/** Скобок `[`, `{` и запятых в тексте: столько объектов самое большее создаст `JSON.parse`. */
export function jsonStructure(value: string): number {
  let structure = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x2c || code === 0x5b || code === 0x7b) structure += 1;
  }
  return structure;
}

/**
 * JSON из ячейки: сначала счёт скобок и запятых (их число — в `spend`, в
 * бюджет разбора), потом `JSON.parse`. Не JSON — `undefined`.
 */
export function parseJsonCell(value: string, name: string, spend: (structure: number) => void = () => undefined): unknown {
  const structure = jsonStructure(value);
  spend(structure);
  if (structure > MAX_JSON_STRUCTURE) throw new CellError(`«${name}»: слишком сложное значение`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Строки внутри JSON из файла. `JSON.parse` пропускает `\u0000` и
 * одиночную половину суррогатной пары, а jsonb PostgreSQL их не принимает:
 * запись падала бы целиком уже после предпросмотра, который их не видит.
 * Узлов не больше, чем скобок и запятых, а их число уже ограничено
 * `parseJsonCell`.
 */
export function cleanJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return wellFormed(HAS_CONTROL.test(value) ? scrub(value, false) : value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_JSON_DEPTH) throw new CellError("слишком глубокая вложенность JSON");
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanJson(key) as string, cleanJson(item, depth + 1)]));
}

export function text(cell: ReadCell, max: number): string | null {
  if (cell === null || cell === undefined) return null;
  const value = typeof cell === "boolean" ? (cell ? "да" : "нет") : String(cell);
  // Заведомо длинное значение отвергается до очистки: очистка — проход по
  // всему тексту, а одна длинная строка файла может стоять в тысяче ячеек.
  if (value.length > max * 2) throw new CellError(`длиннее ${max} знаков`);
  const clean = cleanText(value);
  if (!clean) return null;
  if (clean.length > max) throw new CellError(`длиннее ${max} знаков`);
  return clean;
}

export function requiredText(cell: ReadCell, max: number, name: string): string {
  const value = text(cell, max);
  if (value === null) throw new CellError(`не заполнено поле «${name}»`);
  return value;
}

/**
 * Длиннее этого число, дата или «да/нет» не бывают: длинная строка в таком
 * столбце — ошибка сразу, без прохода по ней.
 */
const SHORT_CELL = 100;

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
  if (typeof cell === "boolean" || cell.length > SHORT_CELL) throw new CellError(`«${name}»: нужно число`);
  const normalized = cell.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!normalized) return null;
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) throw new CellError(`«${name}»: нужно число`);
  return Number(normalized);
}

const YES = new Set(["да", "yes", "true", "1", "истина", "вкл", "+", "y", "д"]);
const NO = new Set(["нет", "no", "false", "0", "ложь", "выкл", "-", "n", "н"]);

export function yesNo(cell: ReadCell, name: string): boolean | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "boolean") return cell;
  if (typeof cell === "string" && cell.length > SHORT_CELL) throw new CellError(`«${name}»: ожидается «да» или «нет»`);
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
  if (typeof cell === "boolean" || cell.length > SHORT_CELL) throw new CellError(`«${name}»: не похоже на дату`);
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
 * Список строк из ячейки: построчно или JSON-массивом строк — так его
 * пишет выгрузка, если в пункте есть перевод строки.
 */
export function stringList(
  cell: ReadCell,
  maxItems: number,
  maxLength: number,
  name: string,
  spend?: (structure: number) => void,
): string[] {
  const value = text(cell, maxItems * (maxLength + 8));
  if (value === null) return [];
  if (value.startsWith("[")) {
    const parsed = parseJsonCell(value, name, spend);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      // Число пунктов — до очистки каждого.
      if (parsed.length > maxItems) throw new CellError(`«${name}»: больше ${maxItems} пунктов`);
      const items = (cleanJson(parsed) as string[]).map((item) => item.trim()).filter(Boolean);
      if (items.length > maxItems) throw new CellError(`«${name}»: больше ${maxItems} пунктов`);
      if (items.some((item) => item.length > maxLength)) throw new CellError(`«${name}»: пункт длиннее ${maxLength} знаков`);
      return items;
    }
  }
  return list(cell, maxItems, maxLength, name);
}

/**
 * Значение jsonb: выгрузка пишет список строк построчно, а всё прочее —
 * JSON. Разбор возвращает то же, что было в базе.
 */
export function jsonValue(cell: ReadCell, name: string, spend?: (structure: number) => void): unknown {
  const value = text(cell, 100_000);
  if (value === null) return null;
  // Не JSON — обычный текст, который начинается со скобки: он делится на
  // пункты построчно, как список.
  const parsed = /^[[{"]/.test(value) ? parseJsonCell(value, name, spend) : undefined;
  if (parsed !== undefined) {
    if (Array.isArray(parsed) && parsed.length > 200) throw new CellError(`«${name}»: больше 200 пунктов`);
    return cleanJson(parsed);
  }
  const items = value.split("\n").map((item) => item.trim()).filter(Boolean);
  if (items.length > 200) throw new CellError(`«${name}»: больше 200 пунктов`);
  return items;
}

/**
 * Свёрнутые подписи и коды → код, один раз на набор подписей: свёртка —
 * `toLocaleLowerCase`, и сворачивать весь набор на каждую ячейку дорого.
 * Первая запись набора выигрывает, как и при переборе по порядку.
 */
const labelIndexes = new WeakMap<object, Map<string, string>>();
function labelIndex(labels: Readonly<Record<string, string>>): Map<string, string> {
  let index = labelIndexes.get(labels);
  if (!index) {
    index = new Map();
    for (const [code, label] of Object.entries(labels)) {
      for (const key of [fold(code), fold(label)]) {
        if (!index.has(key)) index.set(key, code);
      }
    }
    labelIndexes.set(labels, index);
  }
  return index;
}

/** Значение из подписи: принимает и подпись, и исходный код. */
export function labelled<T extends string>(
  cell: ReadCell,
  labels: Readonly<Record<T, string>>,
  name: string,
): T | null {
  const value = text(cell, 200);
  if (value === null) return null;
  const code = labelIndex(labels).get(fold(value));
  if (code !== undefined) return code as T;
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
