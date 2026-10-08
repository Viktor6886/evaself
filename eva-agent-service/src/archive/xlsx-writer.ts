/**
 * Книга Excel (XLSX) из готовых таблиц.
 *
 * XLSX — это zip с несколькими XML-частями (ECMA-376, SpreadsheetML).
 * Пишется на уже установленном jszip, без пакета электронных таблиц:
 * новая зависимость — это ещё один пакет в аудите и в образе ради
 * того, что укладывается в две сотни строк.
 *
 * Строки идут через таблицу общих строк (`sharedStrings.xml`), а не
 * inline: так пишет сам Excel, и просмотрщики телефонов, которыми
 * человек откроет выгрузку, понимают именно эту форму.
 */

import JSZip from "jszip";

export type ColumnKind = "text" | "longtext" | "int" | "number" | "date" | "datetime" | "bool";

export interface WorkbookColumn {
  header: string;
  kind: ColumnKind;
  /** Ширина в символах; без неё — по типу столбца. */
  width?: number;
}

/**
 * Значение ячейки. Дата — строка `YYYY-MM-DD`, время — `YYYY-MM-DDTHH:mm`
 * по стенным часам человека: перевод в его пояс делает вызывающий, книга
 * часовых поясов не знает.
 */
export type CellInput = string | number | boolean | null | undefined;

export interface WorkbookSheet {
  name: string;
  columns: WorkbookColumn[];
  rows: CellInput[][];
}

export interface WorkbookMeta {
  title: string;
  creator: string;
  created: Date;
}

/** Предел длины текста в ячейке Excel. Длиннее файл не откроется. */
export const EXCEL_CELL_LIMIT = 32_767;

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SHEET_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

/** Номера стилей в `styles.xml`. */
const STYLE = { header: 1, date: 2, datetime: 3, wrap: 4 } as const;

const DEFAULT_WIDTH: Record<ColumnKind, number> = {
  text: 24, longtext: 60, int: 10, number: 12, date: 12, datetime: 17, bool: 8,
};

// XML 1.0 не допускает управляющих символов и одиноких суррогатов:
// файл с ними Excel отказывается открывать целиком, а не одну ячейку.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xmlText(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;");
}

/**
 * Excel читает `_xHHHH_` внутри строки как экранированный символ. Текст
 * человека, где такая последовательность встретилась буквально, иначе
 * вернулся бы из файла другим: подчёркивание экранируется само.
 */
function excelString(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1");
}

export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

const EPOCH_1900 = Date.UTC(1899, 11, 30);

/** Дата и время по стенным часам → порядковый номер дня Excel. */
export function excelSerial(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const time = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const check = new Date(time);
  // 2026-02-31 не дата, а опечатка: Date.UTC молча перенёс бы её на март.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) return null;
  if (year! < 1900 || year! > 9999) return null;
  return (time - EPOCH_1900) / 86_400_000;
}

/** Проверка имени листа по правилам Excel; нарушение — ошибка программы. */
function assertSheetNames(sheets: readonly WorkbookSheet[]): void {
  const seen = new Set<string>();
  for (const sheet of sheets) {
    const name = sheet.name;
    if (!name || name.length > 31 || /[[\]:*?/\\]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
      throw new Error(`Недопустимое имя листа: ${name}`);
    }
    const key = name.toLocaleLowerCase("ru");
    if (seen.has(key)) throw new Error(`Повтор имени листа: ${name}`);
    seen.add(key);
  }
}

class SharedStrings {
  private readonly index = new Map<string, number>();
  private readonly values: string[] = [];
  references = 0;

  add(value: string): number {
    this.references += 1;
    const known = this.index.get(value);
    if (known !== undefined) return known;
    const position = this.values.length;
    this.values.push(value);
    this.index.set(value, position);
    return position;
  }

  xml(): string {
    const items = this.values.map((value) => {
      const preserve = /^\s|\s$/.test(value) || value.includes("\n") ? " xml:space=\"preserve\"" : "";
      return `<si><t${preserve}>${xmlText(value)}</t></si>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
      + `<sst xmlns="${MAIN_NS}" count="${this.references}" uniqueCount="${this.values.length}">${items.join("")}</sst>`;
  }
}

interface CellBuild {
  xml: string;
  truncated: boolean;
}

function textCell(ref: string, value: string, strings: SharedStrings, style: number | null): CellBuild {
  const clean = excelString(value).replace(INVALID_XML, "");
  const truncated = clean.length > EXCEL_CELL_LIMIT;
  const text = truncated ? `${clean.slice(0, EXCEL_CELL_LIMIT - 1)}…` : clean;
  const styleAttr = style === null ? "" : ` s="${style}"`;
  return { xml: `<c r="${ref}" t="s"${styleAttr}><v>${strings.add(text)}</v></c>`, truncated };
}

function cell(ref: string, kind: ColumnKind, value: CellInput, strings: SharedStrings): CellBuild | null {
  if (value === null || value === undefined || value === "") return null;
  if (kind === "bool" || typeof value === "boolean") {
    if (typeof value === "boolean") return textCell(ref, value ? "да" : "нет", strings, null);
    return textCell(ref, String(value), strings, null);
  }
  if ((kind === "int" || kind === "number") && typeof value === "number" && Number.isFinite(value)) {
    return { xml: `<c r="${ref}"><v>${value}</v></c>`, truncated: false };
  }
  if ((kind === "date" || kind === "datetime") && typeof value === "string") {
    const serial = excelSerial(value);
    if (serial !== null) {
      const style = kind === "date" ? STYLE.date : STYLE.datetime;
      return { xml: `<c r="${ref}" s="${style}"><v>${serial}</v></c>`, truncated: false };
    }
  }
  return textCell(ref, String(value), strings, kind === "longtext" ? STYLE.wrap : null);
}

function sheetXml(sheet: WorkbookSheet, strings: SharedStrings): { xml: string; truncated: number } {
  const columns = sheet.columns;
  let truncated = 0;
  const rows: string[] = [];
  const header = columns.map((column, index) => textCell(`${columnLetter(index)}1`, column.header, strings, STYLE.header).xml);
  rows.push(`<row r="1">${header.join("")}</row>`);
  sheet.rows.forEach((values, rowIndex) => {
    const number = rowIndex + 2;
    const cells: string[] = [];
    columns.forEach((column, index) => {
      const built = cell(`${columnLetter(index)}${number}`, column.kind, values[index], strings);
      if (!built) return;
      if (built.truncated) truncated += 1;
      cells.push(built.xml);
    });
    rows.push(cells.length > 0 ? `<row r="${number}">${cells.join("")}</row>` : `<row r="${number}"/>`);
  });
  const last = `${columnLetter(Math.max(columns.length - 1, 0))}${sheet.rows.length + 1}`;
  const widths = columns.map((column, index) => {
    const width = Math.min(Math.max(column.width ?? DEFAULT_WIDTH[column.kind], 6), 100);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
    + `<dimension ref="A1:${last}"/>`
    // Закреплённая строка заголовков: на телефоне без неё длинный лист
    // через пару экранов превращается в таблицу без подписей.
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    + `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + (widths.length > 0 ? `<cols>${widths.join("")}</cols>` : "")
    + `<sheetData>${rows.join("")}</sheetData>`
    + `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`
    + `</worksheet>`;
  return { xml, truncated };
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + `<styleSheet xmlns="${MAIN_NS}">`
  + `<numFmts count="2"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy hh:mm"/></numFmts>`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>`
  + `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFEDE7F6"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="5">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`
  + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`
  + `</cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
  + `</styleSheet>`;

/**
 * Собрать книгу. Возвращает байты файла и число ячеек, обрезанных до
 * предела Excel, — о них вызывающий честно пишет в описании выгрузки.
 */
export async function writeWorkbook(
  sheets: readonly WorkbookSheet[],
  meta: WorkbookMeta,
): Promise<{ bytes: Buffer; truncatedCells: number }> {
  if (sheets.length === 0) throw new Error("Книга без листов");
  assertSheetNames(sheets);
  const strings = new SharedStrings();
  const zip = new JSZip();
  const built = sheets.map((sheet) => sheetXml(sheet, strings));
  const overrides = sheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${SHEET_MIME}"/>`);
  // [Content_Types].xml — первой частью архива: часть читателей ищет его
  // в начале и не листает архив дальше.
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + overrides.join("")
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
    + `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`
    + `</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Relationships xmlns="${PKG_REL_NS}">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>`
    + `</Relationships>`);
  const created = meta.created.toISOString().replace(/\.\d{3}Z$/, "Z");
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" `
    + `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${xmlText(meta.title)}</dc:title><dc:creator>${xmlText(meta.creator)}</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>`
    + `</cp:coreProperties>`);
  zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">`
    + `<Application>${xmlText(meta.creator)}</Application></Properties>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
    + `<bookViews><workbookView activeTab="0"/></bookViews><sheets>`
    + sheets.map((sheet, index) =>
      `<sheet name="${xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")
    + `</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Relationships xmlns="${PKG_REL_NS}">`
    + sheets.map((_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId${sheets.length + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>`
    + `</Relationships>`);
  zip.file("xl/styles.xml", STYLES_XML);
  built.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheet.xml));
  zip.file("xl/sharedStrings.xml", strings.xml());
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return { bytes, truncatedCells: built.reduce((sum, sheet) => sum + sheet.truncated, 0) };
}
