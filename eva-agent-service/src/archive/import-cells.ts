/**
 * Ячейки присланного архива: сколько разбор читает и как склеивает
 * длинный текст.
 *
 * Excel хранит одинаковый текст один раз, и строка, на которую ссылается
 * тысяча ячеек, весит в файле килобайты. Поэтому всё, что разбор берёт
 * из ячеек, идёт через бюджет: длина считается до склейки и очистки, а
 * превышение — отказ всему файлу, а не минуты процессора.
 */

import { CellError, fold } from "./format.js";
import { ArchiveRejected, type RowError } from "./import-types.js";
import { CONTINUATION, MAX_VALUE_LENGTH, SPILL_CHUNK, type ArchiveSheet } from "./sheets.js";
import type { ReadCell, ReadSheet } from "./xlsx-reader.js";

export type Get = (key: string) => ReadCell;

/** Столько непустых строк листов файл может нести — всех листов вместе, с ошибками. */
export const ARCHIVE_ROW_LIMIT = 30_000;

/**
 * Столько знаков текста разбор прочитает из файла самое большее — считая
 * каждую ссылку на общую строку. Excel хранит одинаковый текст один раз,
 * и строка в два мегабайта, на которую ссылается тысяча ячеек, весит в
 * файле килобайты, а разбор каждой ссылки — проход по двум мегабайтам.
 * Честный архив в 10 МБ несёт в несколько раз меньше.
 */
export const TEXT_BUDGET = 50_000_000;

/**
 * Скобок и запятых во всех значениях JSON файла вместе (листы и анкета):
 * столько объектов разбор JSON может создать самое большее. Честный архив
 * — десятки тысяч; полмиллиона — около половины секунды процессора.
 */
export const JSON_BUDGET = 500_000;

/** Больше частей значению длиной `MAX_VALUE_LENGTH` не нужно. */
const MAX_PARTS = Math.ceil(MAX_VALUE_LENGTH / SPILL_CHUNK);

/** Подпись поля или заголовок столбца длиннее этого — не подпись. */
const MAX_LABEL = 200;

/** Сколько разбор уже прочитал: знаков текста и строк. Превышение — отказ всему файлу. */
export class Budget {
  private textUsed = 0;
  private rowsUsed = 0;
  private jsonUsed = 0;

  text(length: number): void {
    this.textUsed += length;
    if (this.textUsed > TEXT_BUDGET) {
      throw new ArchiveRejected("В файле слишком много текста. Сделай копии файла, оставь в каждой часть листов и загрузи их по очереди.");
    }
  }

  json(structure: number): void {
    this.jsonUsed += structure;
    if (this.jsonUsed > JSON_BUDGET) {
      throw new ArchiveRejected(
        "В файле слишком много списков и вложенных значений. Сделай копии файла, оставь в каждой часть листов и загрузи их по очереди.",
      );
    }
  }

  rows(count: number): void {
    this.rowsUsed += count;
    if (this.rowsUsed > ARCHIVE_ROW_LIMIT) {
      throw new ArchiveRejected(
        `В файле больше ${ARCHIVE_ROW_LIMIT} записей. Сделай копии файла, оставь в каждой часть листов и загрузи их по очереди.`,
      );
    }
  }
}

const lengthOf = (cell: ReadCell | undefined): number =>
  typeof cell === "string" ? cell.length : cell === null || cell === undefined ? 0 : 8;

/**
 * Значение из одной или нескольких ячеек (продолжения длинного текста).
 * Длина считается до склейки и до любой обработки: склеивать и чистить
 * мегабайтную строку в каждой ячейке, которая на неё ссылается, — минуты
 * процессора.
 */
function joinParts(parts: ReadonlyArray<ReadCell | undefined>, budget: Budget): ReadCell {
  let total = 0;
  let present = 0;
  let only: ReadCell = null;
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    total += lengthOf(part);
    present += 1;
    only = part;
  }
  budget.text(total);
  if (total > MAX_VALUE_LENGTH) throw new CellError(`длиннее ${MAX_VALUE_LENGTH} знаков`);
  if (present <= 1) return only;
  // Продолжения склеиваются по порядку и как есть, без обрезки пробелов
  // на стыке.
  let joined = "";
  for (const part of parts) {
    if (part !== null && part !== undefined) joined += String(part);
  }
  return joined;
}

/**
 * Позиции столбцов листа по заголовкам. Столбцов-продолжений «…
 * (продолжение N)» у длинного текста столько, сколько понадобилось
 * выгрузке, — их число не задано заранее, но больше `MAX_PARTS` не бывает.
 */
export function columnsOf(definition: ArchiveSheet, header: ReadCell[]): Map<string, number[]> | null {
  const byHeader = new Map<string, string>();
  for (const column of definition.columns) {
    byHeader.set(fold(column.header), column.key);
    byHeader.set(fold(column.key), column.key);
  }
  const positions = new Map<string, number[]>();
  header.forEach((cell, index) => {
    if (typeof cell !== "string" || cell.length > MAX_LABEL) return;
    let key = byHeader.get(fold(cell));
    let part = 0;
    if (key === undefined) {
      const match = CONTINUATION.exec(cell.trim());
      if (!match) return;
      key = byHeader.get(fold(match[1]!));
      part = Number(match[2]);
      if (key === undefined || part < 1 || part >= MAX_PARTS) return;
    }
    const parts = positions.get(key) ?? [];
    if (parts[part] === undefined) parts[part] = index;
    positions.set(key, parts);
  });
  return positions.size > 0 ? positions : null;
}

export function getter(row: ReadCell[], positions: Map<string, number[]>, budget: Budget): Get {
  return (key) => {
    const parts = positions.get(key);
    if (!parts || parts[0] === undefined) return null;
    const cells: Array<ReadCell | undefined> = [];
    for (const index of parts) cells.push(index === undefined ? undefined : row[index]);
    return joinParts(cells, budget);
  };
}

/** Пустая ли строка. Проверенный текст ячеек — в счёт бюджета: строка из пробелов тоже бывает длинной. */
export function isEmptyRow(row: ReadCell[] | undefined, budget: Budget): boolean {
  if (!row) return true;
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    if (typeof cell !== "string") return false;
    budget.text(cell.length);
    if (cell.trim() !== "") return false;
  }
  return true;
}

/**
 * Лист «поле — значение»: подпись поля → значение и номер строки Excel.
 * Значение длиннее предела не склеивается, а становится ошибкой строки.
 */
export function keyValues(
  source: ReadSheet,
  budget: Budget,
  errors: RowError[],
): Map<string, { cell: ReadCell; row: number }> {
  const values = new Map<string, { cell: ReadCell; row: number }>();
  source.rows.forEach((row, index) => {
    if (index === 0 || !row) return;
    const first = row[0];
    if (typeof first !== "string" || first.length > MAX_LABEL) return;
    const label = fold(first);
    if (!label) return;
    // Продолжения длинного значения лежат в соседних столбцах; столбцов у
    // листа не больше, чем пропускает читатель.
    try {
      const cell = joinParts(row.slice(1), budget);
      if (cell === null) return;
      values.set(label, { cell, row: index + 1 });
    } catch (error) {
      if (!(error instanceof CellError)) throw error;
      errors.push({ sheet: source.name, row: index + 1, message: error.message });
    }
  });
  return values;
}
