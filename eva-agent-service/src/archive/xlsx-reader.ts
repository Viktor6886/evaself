/**
 * Чтение книги Excel, которую прислал человек.
 *
 * Файл — недоверенные данные. Это zip, и с ним приходит всё, что умеет
 * zip: бомба сжатия, тысячи частей, обход каталогов. Поэтому архив
 * сначала осматривается по оглавлению, распаковываются только нужные
 * части и каждая — с пересчётом настоящих байтов, а не заявленных.
 *
 * XML разбирается узким сканером, а не парсером общего назначения: DTD и
 * сущности здесь не раскрываются вовсе (книга с `<!DOCTYPE` отвергается),
 * поэтому «миллиард смешков» негде устроить. Понимает он то, что пишут
 * Excel, LibreOffice, Google Таблицы и Numbers: общие и встроенные
 * строки, форматированный текст, ячейки без адреса, префиксы пространств
 * имён, кавычки обоих видов и календарь 1904 года.
 */

import yauzl from "yauzl";

import { attribute, scanXml, XmlFormatError, type XmlToken } from "./xml-scan.js";

export { decodeXml } from "./xml-scan.js";

export type ReadCell = string | number | boolean | null;

export interface ReadSheet {
  name: string;
  /** Строки листа по порядку; пустые строки сохраняют своё место. */
  rows: ReadCell[][];
}

export interface ReadWorkbook {
  sheets: ReadSheet[];
  /** Даты книги считаются от 1904 года (старые Numbers и Excel для Mac). */
  date1904: boolean;
}

export interface ReadLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
  maxRows: number;
  maxColumns: number;
  maxSharedStrings: number;
  maxSheets: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxEntries: 500,
  maxEntryBytes: 40 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
  // XML таблицы сжимается в десятки раз; сотни — уже признак бомбы.
  maxRatio: 200,
  maxRows: 20_000,
  maxColumns: 100,
  maxSharedStrings: 500_000,
  // В архиве Евы 27 листов; тысячи `<sheet>` в книге — не таблица, а
  // способ заставить разбор читать одно и то же раз за разом.
  maxSheets: 256,
};

/** Ошибка формата с кодом: текст для человека подбирает вызывающий. */
export class WorkbookFormatError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkbookFormatError";
  }
}

interface ZipEntry {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
}

interface OpenedZip {
  entries: Map<string, ZipEntry>;
  read(name: string): Promise<string>;
  close(): void;
}

function openZip(buffer: Buffer, limits: ReadLimits): Promise<OpenedZip> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new WorkbookFormatError("xlsx_not_zip"));
      const entries = new Map<string, ZipEntry & { raw: yauzl.Entry }>();
      let declared = 0;
      const fail = (code: string): void => {
        zip.close();
        reject(new WorkbookFormatError(code));
      };
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entries.size + 1 > limits.maxEntries) return fail("xlsx_too_many_parts");
        const name = entry.fileName;
        if (name.includes("..") || name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
          return fail("xlsx_part_name_invalid");
        }
        declared += entry.uncompressedSize;
        if (
          entry.uncompressedSize > limits.maxEntryBytes
          || declared > limits.maxTotalBytes
          || entry.uncompressedSize > Math.max(4096, entry.compressedSize) * limits.maxRatio
        ) return fail("xlsx_zip_bomb");
        entries.set(name, {
          fileName: name,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          raw: entry,
        });
        zip.readEntry();
      });
      zip.on("error", () => reject(new WorkbookFormatError("xlsx_zip_malformed")));
      zip.on("end", () => {
        let spent = 0;
        resolve({
          entries,
          close: () => zip.close(),
          read: async (name: string) => {
            const entry = entries.get(name);
            if (!entry) throw new WorkbookFormatError("xlsx_part_missing");
            const bytes = await new Promise<Buffer>((done, failed) => {
              zip.openReadStream(entry.raw, (streamError, stream) => {
                if (streamError || !stream) return failed(new WorkbookFormatError("xlsx_zip_malformed"));
                const chunks: Buffer[] = [];
                let size = 0;
                stream.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  // Заявленный размер проверен по оглавлению, но верить
                  // ему нельзя: считаются настоящие байты распаковки.
                  if (size > limits.maxEntryBytes || spent + size > limits.maxTotalBytes) {
                    stream.destroy();
                    failed(new WorkbookFormatError("xlsx_zip_bomb"));
                    return;
                  }
                  chunks.push(chunk);
                });
                stream.on("error", () => failed(new WorkbookFormatError("xlsx_zip_malformed")));
                stream.on("end", () => done(Buffer.concat(chunks)));
              });
            });
            spent += bytes.length;
            const text = bytes.toString("utf8");
            if (/<!DOCTYPE/i.test(text.slice(0, 2048))) throw new WorkbookFormatError("xlsx_doctype_forbidden");
            return text;
          },
        });
      });
      zip.readEntry();
    });
  });
}

/** Обратное к экранированию Excel `_xHHHH_` (так он пишет, например, `\r`). */
function excelUnescape(text: string): string {
  return text.includes("_x")
    ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    : text;
}

/**
 * Разбор отдаёт управление циклу событий каждые столько токенов: большой
 * лист не должен замораживать остальные запросы сервиса.
 */
const YIELD_EVERY = 20_000;
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Токены части книги. Перебор синхронный, а паузу делает вызывающий
 * (`pacer`): асинхронный генератор создавал по промису на каждый токен,
 * а под AsyncLocalStorage сервиса каждый промис ещё проходит через async
 * hooks — разбор большого листа становился в 2,5–10 раз дороже.
 */
function* tokens(xml: string): Generator<XmlToken> {
  try {
    yield* scanXml(xml);
  } catch (error) {
    if (error instanceof XmlFormatError) throw new WorkbookFormatError("xlsx_xml_malformed");
    throw error;
  }
}

/** Счётчик токенов: `true` раз в `YIELD_EVERY` — пора отдать цикл событий. */
function pacer(): () => boolean {
  let count = 0;
  return () => {
    count += 1;
    if (count < YIELD_EVERY) return false;
    count = 0;
    return true;
  };
}

function joinPath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash < 0 ? `_rels/${part}.rels` : `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

async function relationships(xml: string): Promise<Array<{ id: string; type: string; target: string }>> {
  const found: Array<{ id: string; type: string; target: string }> = [];
  const due = pacer();
  for (const token of tokens(xml)) {
    if (due()) await pause();
    if (token.kind !== "open" || token.name !== "Relationship") continue;
    found.push({
      id: token.attrs.get("Id") ?? "",
      type: token.attrs.get("Type") ?? "",
      target: token.attrs.get("Target") ?? "",
    });
  }
  return found;
}

async function workbookInfo(
  xml: string,
  limits: ReadLimits,
): Promise<{ date1904: boolean; sheets: Array<{ name: string; relId: string | undefined }> }> {
  let date1904 = false;
  const sheets: Array<{ name: string; relId: string | undefined }> = [];
  const due = pacer();
  for (const token of tokens(xml)) {
    if (due()) await pause();
    if (token.kind !== "open") continue;
    if (token.name === "workbookPr") {
      const value = token.attrs.get("date1904");
      date1904 = value === "1" || value === "true";
    } else if (token.name === "sheet") {
      if (sheets.length >= limits.maxSheets) throw new WorkbookFormatError("xlsx_too_many_sheets");
      sheets.push({ name: token.attrs.get("name") ?? "", relId: attribute(token.attrs, "id") });
    }
  }
  return { date1904, sheets };
}

/** Общие строки: все `<t>` элемента `<si>`, кроме фонетических подсказок `<rPh>`. */
async function sharedStrings(xml: string, limits: ReadLimits): Promise<string[]> {
  const strings: string[] = [];
  let item: string[] | null = null;
  let phonetic = 0;
  let text: string[] | null = null;
  const due = pacer();
  for (const token of tokens(xml)) {
    if (due()) await pause();
    if (token.kind === "text") {
      if (text) text.push(token.text);
    } else if (token.kind === "open") {
      if (token.name === "si") {
        if (item) throw new WorkbookFormatError("xlsx_xml_malformed");
        if (strings.length >= limits.maxSharedStrings) throw new WorkbookFormatError("xlsx_too_many_strings");
        if (token.selfClosing) strings.push("");
        else item = [];
      } else if (item && token.name === "rPh" && !token.selfClosing) {
        phonetic += 1;
      } else if (item && token.name === "t" && !token.selfClosing) {
        if (text) throw new WorkbookFormatError("xlsx_xml_malformed");
        text = [];
      }
    } else if (token.name === "t" && text) {
      if (phonetic === 0) item?.push(text.join(""));
      text = null;
    } else if (token.name === "rPh" && phonetic > 0) {
      phonetic -= 1;
    } else if (token.name === "si" && item) {
      strings.push(excelUnescape(item.join("")));
      item = null;
      phonetic = 0;
    }
  }
  if (item || text) throw new WorkbookFormatError("xlsx_xml_malformed");
  return strings;
}

/** Адрес ячейки длиннее этого — не адрес, а мусор. */
const MAX_REF = 16;

function columnIndex(ref: string): number | null {
  const match = ref.length <= MAX_REF ? /^([A-Z]{1,3})\d*$/i.exec(ref) : null;
  if (!match) return null;
  let value = 0;
  for (const letter of match[1]!.toUpperCase()) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value - 1;
}

function rowIndex(ref: string): number | null {
  const match = ref.length <= MAX_REF ? /^[A-Z]{0,3}(\d+)$/i.exec(ref) : null;
  return match ? Number(match[1]) - 1 : null;
}

function cellValue(type: string, raw: string | null, inline: string | null, strings: readonly string[]): ReadCell {
  if (type === "inlineStr") return inline === null ? null : excelUnescape(inline);
  if (raw === null) return null;
  switch (type) {
    case "s": {
      const index = Number(raw);
      return Number.isSafeInteger(index) && index >= 0 && index < strings.length ? strings[index]! : null;
    }
    case "str":
    case "d":
      return excelUnescape(raw);
    case "b":
      return raw.trim() === "1" || raw.trim().toLowerCase() === "true";
    case "e":
      return null;
    default: {
      const number = Number(raw);
      return raw.trim() !== "" && Number.isFinite(number) ? number : null;
    }
  }
}

/**
 * Строки листа. Вложенность проверяется по ходу: строка внутри строки или
 * ячейка вне строки — ошибка формата, а не повод искать закрывающий тег
 * где-то дальше.
 */
async function parseSheet(xml: string, strings: readonly string[], limits: ReadLimits): Promise<ReadCell[][]> {
  const rows: ReadCell[][] = [];
  const malformed = () => new WorkbookFormatError("xlsx_xml_malformed");
  type RowState = { index: number; values: ReadCell[]; nextColumn: number };
  type CellState = { column: number | null; type: string; raw: string[] | null; inline: string[] | null };
  let inData = false;
  let row = null as RowState | null;
  let nextRow = 0;
  let cell = null as CellState | null;
  // Текущая ячейка читается через функцию: её меняют вложенные функции,
  // и сужение типа по месту объявления здесь было бы неверным.
  const currentCell = (): CellState | null => cell;
  let capture: string[] | null = null;
  let inInline = false;
  let phonetic = 0;

  const openRow = (attrs: Map<string, string>) => {
    if (row) throw malformed();
    const declared = attrs.get("r");
    const index = declared && /^\d{1,7}$/.test(declared) ? Number(declared) - 1 : nextRow;
    // Номер строки только растёт: файл, где строка 5 идёт после 9-й,
    // склеивал бы чужие ячейки в одну запись.
    if (index < nextRow) throw new WorkbookFormatError("xlsx_rows_unordered");
    if (index >= limits.maxRows) throw new WorkbookFormatError("xlsx_too_many_rows");
    nextRow = index + 1;
    row = { index, values: [], nextColumn: 0 };
  };
  const closeRow = () => {
    if (!row) return;
    while (rows.length < row.index) rows.push([]);
    rows[row.index] = row.values;
    row = null;
  };
  const openCell = (attrs: Map<string, string>) => {
    if (!row || cell) throw malformed();
    const ref = attrs.get("r");
    let column: number | null = ref ? columnIndex(ref) : row.nextColumn;
    if (ref && column !== null) {
      const referenced = rowIndex(ref);
      // Ячейка с адресом чужой строки — не этой строки.
      if (referenced !== null && referenced !== row.index) column = null;
    }
    if (column !== null) row.nextColumn = column + 1;
    cell = { column, type: attrs.get("t") ?? "n", raw: null, inline: null };
  };
  const closeCell = () => {
    if (!row || !cell) throw malformed();
    const { column } = cell;
    if (column !== null && column < limits.maxColumns) {
      const value = cellValue(cell.type, cell.raw ? cell.raw.join("") : null, cell.inline ? cell.inline.join("") : null, strings);
      if (value !== null) {
        while (row.values.length < column) row.values.push(null);
        row.values[column] = value;
      }
    }
    cell = null;
  };

  const due = pacer();
  for (const token of tokens(xml)) {
    if (due()) await pause();
    if (token.kind === "text") {
      if (capture) capture.push(token.text);
      continue;
    }
    if (token.name === "sheetData") {
      if (token.kind === "open") inData = !token.selfClosing;
      else inData = false;
      continue;
    }
    if (!inData) continue;
    if (token.kind === "open") {
      switch (token.name) {
        case "row":
          openRow(token.attrs);
          if (token.selfClosing) closeRow();
          break;
        case "c":
          openCell(token.attrs);
          if (token.selfClosing) closeCell();
          break;
        case "v": {
          const active = currentCell();
          if (!active || capture) throw malformed();
          if (!token.selfClosing) capture = active.raw = [];
          break;
        }
        case "is": {
          const active = currentCell();
          if (!active) throw malformed();
          if (!token.selfClosing) {
            inInline = true;
            active.inline = [];
          }
          break;
        }
        case "rPh":
          if (inInline && !token.selfClosing) phonetic += 1;
          break;
        case "t":
          if (inInline && !token.selfClosing) {
            if (capture) throw malformed();
            capture = [];
          }
          break;
        default:
          break;
      }
      continue;
    }
    switch (token.name) {
      case "row":
        if (currentCell()) throw malformed();
        closeRow();
        break;
      case "c":
        closeCell();
        break;
      case "v":
        capture = null;
        break;
      case "t":
        if (inInline && capture) {
          if (phonetic === 0) currentCell()?.inline?.push(capture.join(""));
          capture = null;
        }
        break;
      case "rPh":
        if (phonetic > 0) phonetic -= 1;
        break;
      case "is":
        inInline = false;
        phonetic = 0;
        break;
      default:
        break;
    }
  }
  if (row || currentCell()) throw malformed();
  return rows;
}

/**
 * Прочитать книгу. `wanted` ограничивает разбор нужными листами: лист,
 * который вызывающему не нужен, не распаковывается вовсе.
 */
export async function readWorkbook(
  buffer: Buffer,
  options: { wanted?: (sheetName: string) => boolean; limits?: Partial<ReadLimits> } = {},
): Promise<ReadWorkbook> {
  const limits = { ...DEFAULT_READ_LIMITS, ...options.limits };
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new WorkbookFormatError("xlsx_not_zip");
  const zip = await openZip(buffer, limits);
  try {
    if (!zip.entries.has("[Content_Types].xml")) throw new WorkbookFormatError("xlsx_not_workbook");
    const rootRels = zip.entries.has("_rels/.rels") ? await relationships(await zip.read("_rels/.rels")) : [];
    const office = rootRels.find((rel) => /\/officeDocument$/.test(rel.type));
    const workbookPath = office ? joinPath("", office.target) : "xl/workbook.xml";
    if (!zip.entries.has(workbookPath)) throw new WorkbookFormatError("xlsx_not_workbook");
    const workbook = await workbookInfo(await zip.read(workbookPath), limits);
    const baseDir = workbookPath.includes("/") ? workbookPath.slice(0, workbookPath.lastIndexOf("/")) : "";
    const rels = zip.entries.has(relsPath(workbookPath)) ? await relationships(await zip.read(relsPath(workbookPath))) : [];
    const date1904 = workbook.date1904;

    const sharedRel = rels.find((rel) => /\/sharedStrings$/.test(rel.type));
    const sharedPath = sharedRel ? joinPath(baseDir, sharedRel.target) : null;
    const strings = sharedPath && zip.entries.has(sharedPath) ? await sharedStrings(await zip.read(sharedPath), limits) : [];

    const relById = new Map<string, { id: string; type: string; target: string }>();
    for (const rel of rels) {
      if (!relById.has(rel.id)) relById.set(rel.id, rel);
    }
    const sheets: ReadSheet[] = [];
    const names = new Set<string>();
    const parts = new Set<string>();
    for (const item of workbook.sheets) {
      if (!item.name || (options.wanted && !options.wanted(item.name))) continue;
      // Имена листов Excel уникальны без учёта регистра: второй лист с тем
      // же именем не читается.
      const name = item.name.toLocaleLowerCase("ru");
      if (names.has(name)) continue;
      names.add(name);
      const rel = item.relId === undefined ? undefined : relById.get(item.relId);
      if (!rel || !/\/worksheet$/.test(rel.type)) continue;
      const path = joinPath(baseDir, rel.target);
      if (!zip.entries.has(path)) continue;
      // Одна часть — один лист: иначе большую часть читали бы раз за разом.
      if (parts.has(path)) throw new WorkbookFormatError("xlsx_xml_malformed");
      parts.add(path);
      sheets.push({ name: item.name, rows: await parseSheet(await zip.read(path), strings, limits) });
    }
    return { sheets, date1904 };
  } finally {
    zip.close();
  }
}

const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * Номер дня Excel → стенные часы `YYYY-MM-DDTHH:mm`. Время округляется
 * до минуты: дробная часть дня в файле хранится с погрешностью.
 */
export function serialToLocal(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  const minutes = Math.round(serial * 24 * 60);
  const date = new Date(epoch + minutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
