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

const XML_ENTITY = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(XML_ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? whole;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

/** Обратное к экранированию Excel `_xHHHH_` (так он пишет, например, `\r`). */
function excelUnescape(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function attributes(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    result.set(match[1]!, decodeXml(match[2] ?? match[3] ?? ""));
  }
  return result;
}

/** Атрибут без учёта префикса: `r:id` у одних и `x:id`/`id` у других. */
function attribute(attrs: Map<string, string>, local: string): string | undefined {
  if (attrs.has(local)) return attrs.get(local);
  for (const [key, value] of attrs) {
    if (key.endsWith(`:${local}`)) return value;
  }
  return undefined;
}

const P = "(?:[A-Za-z_][\\w.-]*:)?";

function elements(xml: string, tag: string): Array<{ attrs: string; body: string | null }> {
  const pattern = new RegExp(`<${P}${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}${tag}>)`, "g");
  const found: Array<{ attrs: string; body: string | null }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    found.push({ attrs: match[1] ?? "", body: match[2] ?? null });
  }
  return found;
}

/** Текст строки: все `<t>`, кроме фонетических подсказок `<rPh>`. */
function stringItem(body: string): string {
  const withoutPhonetic = body.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, "g"), "");
  const parts = elements(withoutPhonetic, "t").map((item) => decodeXml(item.body ?? ""));
  return excelUnescape(parts.join(""));
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

function relationships(xml: string): Array<{ id: string; type: string; target: string }> {
  return elements(xml, "Relationship").map((item) => {
    const attrs = attributes(item.attrs);
    return { id: attrs.get("Id") ?? "", type: attrs.get("Type") ?? "", target: attrs.get("Target") ?? "" };
  });
}

function columnIndex(ref: string): number | null {
  const match = /^([A-Z]{1,3})\d*$/i.exec(ref);
  if (!match) return null;
  let value = 0;
  for (const letter of match[1]!.toUpperCase()) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value - 1;
}

function rowIndex(ref: string): number | null {
  const match = /^[A-Z]{0,3}(\d+)$/i.exec(ref);
  return match ? Number(match[1]) - 1 : null;
}

function cellValue(attrs: Map<string, string>, body: string | null, strings: readonly string[]): ReadCell {
  if (body === null) return null;
  const type = attrs.get("t") ?? "n";
  if (type === "inlineStr") {
    const inline = elements(body, "is")[0]?.body;
    return inline === undefined || inline === null ? null : stringItem(inline);
  }
  const raw = elements(body, "v")[0]?.body;
  if (raw === undefined || raw === null) return null;
  const text = decodeXml(raw);
  switch (type) {
    case "s": {
      const index = Number(text);
      return Number.isSafeInteger(index) && index >= 0 && index < strings.length ? strings[index]! : null;
    }
    case "str":
    case "d":
      return excelUnescape(text);
    case "b":
      return text.trim() === "1" || text.trim().toLowerCase() === "true";
    case "e":
      return null;
    default: {
      const number = Number(text);
      return text.trim() !== "" && Number.isFinite(number) ? number : null;
    }
  }
}

function parseSheet(xml: string, strings: readonly string[], limits: ReadLimits): ReadCell[][] {
  const data = new RegExp(`<${P}sheetData\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}sheetData>)`).exec(xml);
  const body = data?.[1] ?? "";
  const rows: ReadCell[][] = [];
  let nextRow = 0;
  for (const row of elements(body, "row")) {
    const rowAttrs = attributes(row.attrs);
    const declared = rowAttrs.get("r");
    const index = declared && /^\d+$/.test(declared) ? Number(declared) - 1 : nextRow;
    // Номер строки только растёт: файл, где строка 5 идёт после 9-й,
    // склеивал бы чужие ячейки в одну запись.
    if (index < nextRow) throw new WorkbookFormatError("xlsx_rows_unordered");
    if (index >= limits.maxRows) throw new WorkbookFormatError("xlsx_too_many_rows");
    nextRow = index + 1;
    const values: ReadCell[] = [];
    let nextColumn = 0;
    for (const item of elements(row.body ?? "", "c")) {
      const attrs = attributes(item.attrs);
      const ref = attrs.get("r");
      const column = ref ? columnIndex(ref) : nextColumn;
      if (column === null) continue;
      if (ref) {
        const referenced = rowIndex(ref);
        if (referenced !== null && referenced !== index) continue;
      }
      nextColumn = column + 1;
      if (column >= limits.maxColumns) continue;
      const value = cellValue(attrs, item.body, strings);
      if (value === null) continue;
      while (values.length < column) values.push(null);
      values[column] = value;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = values;
  }
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
    const rootRels = zip.entries.has("_rels/.rels") ? relationships(await zip.read("_rels/.rels")) : [];
    const office = rootRels.find((rel) => /\/officeDocument$/.test(rel.type));
    const workbookPath = office ? joinPath("", office.target) : "xl/workbook.xml";
    if (!zip.entries.has(workbookPath)) throw new WorkbookFormatError("xlsx_not_workbook");
    const workbook = await zip.read(workbookPath);
    const baseDir = workbookPath.includes("/") ? workbookPath.slice(0, workbookPath.lastIndexOf("/")) : "";
    const rels = zip.entries.has(relsPath(workbookPath)) ? relationships(await zip.read(relsPath(workbookPath))) : [];
    const pr = elements(workbook, "workbookPr")[0];
    const date1904Value = pr ? attributes(pr.attrs).get("date1904") : undefined;
    const date1904 = date1904Value === "1" || date1904Value === "true";

    const sharedRel = rels.find((rel) => /\/sharedStrings$/.test(rel.type));
    const sharedPath = sharedRel ? joinPath(baseDir, sharedRel.target) : null;
    const strings: string[] = [];
    if (sharedPath && zip.entries.has(sharedPath)) {
      for (const item of elements(await zip.read(sharedPath), "si")) {
        if (strings.length >= limits.maxSharedStrings) throw new WorkbookFormatError("xlsx_too_many_strings");
        strings.push(stringItem(item.body ?? ""));
      }
    }

    const sheets: ReadSheet[] = [];
    for (const item of elements(workbook, "sheet")) {
      const attrs = attributes(item.attrs);
      const name = attrs.get("name") ?? "";
      if (!name || (options.wanted && !options.wanted(name))) continue;
      const relId = attribute(attrs, "id");
      const rel = rels.find((candidate) => candidate.id === relId);
      if (!rel || !/\/worksheet$/.test(rel.type)) continue;
      const path = joinPath(baseDir, rel.target);
      if (!zip.entries.has(path)) continue;
      sheets.push({ name, rows: parseSheet(await zip.read(path), strings, limits) });
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
