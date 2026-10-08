/**
 * Общее для записи архива: клиент транзакции, режим, счётчики и правила
 * повтора.
 *
 * Предпросмотр и запись — один и тот же код. Предпросмотр идёт в
 * транзакции только для чтения и не выполняет ни одной записи: каждая
 * вставка проходит через `insert`/`run`, которые в этом режиме ничего не
 * пишут, а вместо идентификатора новой строки отдают условный. Числа
 * предпросмотра совпадают с записью, а таблицы и WAL не раздуваются
 * вставками, которые тут же откатываются.
 */

import { createHash } from "node:crypto";

import { CONTROL_CODES, EDGE_SPACE_CODES, cleanText, instantOf, wallClock } from "./format.js";
import { pacer } from "./pace.js";
import type { ParsedArchive, RowError } from "./import-types.js";
import type { SheetId } from "./sheets.js";

export interface ApplyClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Добавлено новых строк; уже было; дополнено пустое место в существующей. */
export interface Counter {
  added: number;
  existing: number;
  filled: number;
}

export type ApplyMode = "preview" | "apply";

export interface ApplyContext {
  client: ApplyClient;
  userId: number;
  parsed: ParsedArchive;
  now: Date;
  mode: ApplyMode;
  errors: RowError[];
  warnings: string[];
  count(id: SheetId): Counter;
  /** Повторяющееся предупреждение — одной строкой с номерами строк. */
  notice(message: string, row: number): void;
  /** Стенные часы файла → момент времени. */
  instant(wall: string | null): Date | null;
  /** Момент → стенные часы пояса файла. */
  wall(moment: Date | null): string | null;
  /**
   * Пауза для цикла событий, как только подряд набежало `QUANTUM_MS`:
   * предпросмотр не ждёт базы, и без пауз десятки тысяч строк шли бы
   * одним куском.
   */
  pace(): Promise<void>;
  /** Момент создания из файла; будущее — опечатка, а не история. */
  createdAt(wall: string | null): string | null;
  /** Вставка с `RETURNING id`: при записи — настоящий id, в предпросмотре — условный. */
  insert(sql: string, values: unknown[]): Promise<number>;
  /** Запись без результата; в предпросмотре не выполняется. */
  run(sql: string, values: unknown[]): Promise<void>;
}

const CACHE_LIMIT = 50_000;

export function createContext(input: {
  client: ApplyClient;
  userId: number;
  parsed: ParsedArchive;
  now: Date;
  mode: ApplyMode;
}): ApplyContext & { notices: Map<string, number[]>; counters: Map<SheetId, Counter> } {
  const counters = new Map<SheetId, Counter>();
  const notices = new Map<string, number[]>();
  let simulated = 0;
  // Перевод времени между поясами — форматирование Intl, десятки
  // микросекунд; в файле одни и те же сроки повторяются.
  const instants = new Map<string, Date | null>();
  const walls = new Map<number, string | null>();
  const instant = (wall: string | null): Date | null => {
    if (wall === null) return null;
    let value = instants.get(wall);
    if (value === undefined) {
      value = instantOf(wall, input.parsed.zone);
      if (instants.size < CACHE_LIMIT) instants.set(wall, value);
    }
    return value;
  };
  return {
    ...input,
    errors: [...input.parsed.errors],
    warnings: [...input.parsed.warnings],
    counters,
    notices,
    count(id) {
      const known = counters.get(id);
      if (known) return known;
      const created = { added: 0, existing: 0, filled: 0 };
      counters.set(id, created);
      return created;
    },
    notice(message, row) {
      const rows = notices.get(message) ?? [];
      rows.push(row);
      notices.set(message, rows);
    },
    instant,
    wall(moment) {
      if (moment === null) return null;
      const key = moment.getTime();
      let value = walls.get(key);
      if (value === undefined) {
        value = wallClock(moment, input.parsed.zone);
        if (walls.size < CACHE_LIMIT) walls.set(key, value);
      }
      return value;
    },
    pace: pacer(),
    createdAt(wall) {
      const value = instant(wall);
      return value && value.getTime() <= input.now.getTime() ? value.toISOString() : null;
    },
    async insert(sql, values) {
      if (input.mode === "preview") {
        simulated += 1;
        return -simulated;
      }
      const { rows } = await input.client.query<{ id: string }>(sql, values);
      if (!rows[0]) throw new Error("вставка не вернула идентификатор");
      return Number(rows[0].id);
    },
    async run(sql, values) {
      if (input.mode === "preview") return;
      await input.client.query(sql, values);
    },
  };
}

/**
 * Повторы считаются по количеству, а не множеством: в базе одна покупка
 * «200 ₽ в аптеке», в файле две такие же — добавится одна; на чистом
 * аккаунте — обе. Множество теряло бы одинаковые строки молча.
 */
export class Multiset<T = true> {
  private readonly items = new Map<string, T[]>();

  add(key: string, value: T): void {
    const list = this.items.get(key);
    if (list) list.push(value);
    else this.items.set(key, [value]);
  }

  /** Забрать одно вхождение ключа; `undefined` — таких больше нет. */
  take(key: string): T | undefined {
    const list = this.items.get(key);
    if (!list || list.length === 0) return undefined;
    return list.shift();
  }
}

const sqlChars = (codes: readonly number[]) => codes.map((code) => `chr(${code})`).join(" || ");
const CONTROL_SQL = sqlChars(CONTROL_CODES.filter((code) => code !== 0));
const EDGE_SQL = sqlChars(EDGE_SPACE_CODES);

/**
 * Хэш содержания в SQL — пара к `contentHash`. Наборы символов берутся из
 * тех же констант, что и `cleanText`, поэтому представления в коде и в
 * базе не расходятся: управляющие символы вырезаются, `\r\n` и `\r` → `\n`,
 * пробелы по краям срезаются.
 */
export function hashSql(column: string): string {
  return `md5(btrim(replace(replace(translate(${column}, ${CONTROL_SQL}, ''), chr(13) || chr(10), chr(10)), chr(13), chr(10)), ${EDGE_SQL}))`;
}

export function contentHash(value: string): string {
  return createHash("md5").update(cleanText(value), "utf8").digest("hex");
}
