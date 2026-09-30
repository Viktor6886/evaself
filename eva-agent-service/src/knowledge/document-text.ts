/**
 * Текст из файла — один разбор на весь продукт.
 *
 * Этот разбор появился для приёма документов в базу знаний, а Telegram
 * читал вложения сам и умел ровно один формат — plain text. Второй
 * парсер здесь не нужен и опасен: проверки на подделку типа, zip-бомбу и
 * размер должны быть одни и те же независимо от того, откуда пришёл
 * файл.
 *
 * Содержимое файла — данные, а не инструкции: заворачивать его в конверт
 * недоверенного содержимого обязан вызывающий (`sanitizeUntrustedContent`).
 */

import { fileTypeFromBuffer } from "file-type";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import yauzl from "yauzl";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Что читается. Список закрытый: формат, которого здесь нет, отвергается
 * до чтения, а не разбирается «как получится».
 */
export const SUPPORTED_DOCUMENT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/yaml",
  "application/yaml",
  "application/x-yaml",
  "application/json",
  "application/pdf",
  DOCX_MIME,
]);

export interface DocumentLimits {
  pages: number;
  entries: number;
  paragraphs: number;
  sections: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  pages: 200,
  entries: 2_000,
  paragraphs: 20_000,
  sections: 500,
};

/** Расширение → тип. Telegram присылает `mime_type` не всегда и не всегда верный. */
const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/csv",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: DOCX_MIME,
});

/**
 * Тип файла по имени и заявленному типу.
 *
 * Заявленному типу веры меньше, чем расширению: Telegram проставляет
 * `application/octet-stream` любому файлу, отправленному с телефона.
 * Настоящее содержимое всё равно проверяется дальше, при разборе.
 */
export function documentMimeOf(filename: string, declared?: string | null): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  const byExtension = extension ? EXTENSION_MIME[extension] : undefined;
  if (byExtension) return byExtension;
  const clean = declared?.split(";")[0]?.trim().toLowerCase();
  if (clean && SUPPORTED_DOCUMENT_MIME.has(clean)) return clean;
  return null;
}

const utf8 = (buffer: Buffer): string => {
  const text = buffer.toString("utf8");
  if (Buffer.from(text, "utf8").compare(buffer) !== 0) throw new Error("document_utf8_invalid");
  return text;
};

/**
 * DOCX — это zip, и с ним приходят все радости zip: обход каталогов,
 * бомба сжатия, отсутствующие обязательные части. Проверяется всё это до
 * распаковки.
 */
async function validateDocx(buffer: Buffer, entriesLimit: number): Promise<void> {
  await new Promise<void>((resolve, reject) => yauzl.fromBuffer(
    buffer,
    { lazyEntries: true, validateEntrySizes: true },
    (error, zip) => {
      if (error || !zip) return reject(new Error("document_docx_malformed"));
      let entries = 0;
      let total = 0;
      let hasContent = false;
      let hasDocument = false;
      const fail = (code: string): void => { zip.close(); reject(new Error(code)); };
      zip.on("entry", (entry) => {
        entries += 1;
        total += entry.uncompressedSize;
        if (
          entries > entriesLimit
          || entry.uncompressedSize > 10 * 1024 * 1024
          || total > 30 * 1024 * 1024
          || entry.uncompressedSize > Math.max(1024, entry.compressedSize) * 100
        ) return fail("document_docx_zip_bomb");
        if (entry.fileName === "[Content_Types].xml") hasContent = true;
        if (entry.fileName === "word/document.xml") hasDocument = true;
        if (entry.fileName.includes("..") || entry.fileName.startsWith("/")) {
          return fail("document_docx_entry_invalid");
        }
        zip.readEntry();
      });
      zip.on("end", () => hasContent && hasDocument
        ? resolve()
        : reject(new Error("document_docx_malformed")));
      zip.on("error", () => reject(new Error("document_docx_malformed")));
      zip.readEntry();
    },
  ));
}

/**
 * Разобрать файл на страницы текста.
 *
 * Заявленный тип сверяется с настоящим содержимым: PDF обязан начинаться
 * с `%PDF-`, DOCX — быть настоящим zip нужной формы, а текстовый файл —
 * не содержать двоичной подписи и нулевых байтов.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mime: string,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): Promise<string[]> {
  if (!SUPPORTED_DOCUMENT_MIME.has(mime)) throw new Error("document_type_unsupported");
  const detected = await fileTypeFromBuffer(buffer);

  if (mime === "application/pdf") {
    if (detected?.mime !== "application/pdf" || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("document_mime_mismatch");
    }
    const parser = new PDFParse({ data: buffer });
    try {
      let info;
      try {
        info = await parser.getInfo();
      } catch {
        throw new Error("document_pdf_malformed_or_encrypted");
      }
      if (info.total < 1 || info.total > limits.pages) throw new Error("document_pages_exceeded");
      try {
        return (await parser.getText()).pages.map((page) => page.text);
      } catch {
        throw new Error("document_pdf_malformed_or_encrypted");
      }
    } finally {
      await parser.destroy();
    }
  }

  if (mime === DOCX_MIME) {
    if (detected?.mime !== DOCX_MIME) throw new Error("document_mime_mismatch");
    await validateDocx(buffer, limits.entries);
    let value: string;
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.messages.some((message) => message.type === "error")) throw new Error();
      value = result.value;
    } catch {
      throw new Error("document_docx_xml_invalid");
    }
    const paragraphs = value.split(/\r?\n/u).filter(Boolean);
    const sections = (value.match(/\f/gu)?.length ?? 0) + 1;
    if (paragraphs.length > limits.paragraphs) throw new Error("document_paragraphs_exceeded");
    if (sections > limits.sections) throw new Error("document_sections_exceeded");
    return paragraphs;
  }

  // Дальше только текстовые форматы: двоичная подпись или нулевой байт
  // означает, что заявленный тип не тот.
  if (detected || buffer.includes(0)) throw new Error("document_mime_mismatch");
  let text = utf8(buffer);
  if (mime === "application/json") {
    try {
      text = JSON.stringify(JSON.parse(text));
    } catch {
      throw new Error("document_json_invalid");
    }
  }
  if (mime === "text/html" && !/<(?:!doctype|html|head|body|p|div|article|main)\b/i.test(text)) {
    throw new Error("document_html_invalid");
  }
  const pages = text.split(/\f/u);
  if (pages.length > limits.pages) throw new Error("document_pages_exceeded");
  return pages;
}

/** Документ с сохранённой структурой — для нарезки базы знаний. */
export interface DocumentOutline {
  /** Текст по страницам; заголовки — строками markdown `#`. */
  pages: string[];
  /** Номера страниц настоящие (PDF, текст с разрывами) или их нет (DOCX, HTML). */
  paged: boolean;
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/giu, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Вырезать то, чего человек не видит: скрипты, стили, формы, комментарии и
 * скрытые элементы. Встречается и в markdown, и в «простом» тексте.
 */
export function stripHiddenMarkup(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<([a-z0-9]+)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden))[^>]*>[\s\S]*?<\/\1>/giu, " ");
}

/**
 * HTML → строки с заголовками `#`. Скрытое, скрипты и формы вырезаются
 * до того, как текст станет фрагментом: невидимый человеку текст — любимое
 * место для инструкций, адресованных модели.
 */
export function htmlToOutline(html: string): string {
  const stripTags = (value: string): string => value.replace(/<[^>]+>/gu, " ");
  let text = stripHiddenMarkup(html);
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_whole, level: string, inner: string) =>
    `\n\n${"#".repeat(Number(level))} ${stripTags(inner).replace(/\s+/gu, " ").trim()}\n\n`);
  text = text
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|tr|table|ul|ol|section|article|blockquote|header|footer|main)>/giu, "\n\n");
  text = decodeEntities(stripTags(text));
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Разобрать файл с сохранением структуры: заголовки DOCX и HTML, страницы
 * PDF. Проверки типа, размера и zip-бомбы — те же, что у
 * `extractDocumentText`: он же и выполняет их первым.
 */
export async function extractDocumentOutline(
  buffer: Buffer,
  mime: string,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): Promise<DocumentOutline> {
  const pages = await extractDocumentText(buffer, mime, limits);
  if (mime === DOCX_MIME) {
    // Сырой текст DOCX теряет заголовки; HTML того же разбора их хранит.
    let html: string;
    try {
      const result = await mammoth.convertToHtml({ buffer });
      if (result.messages.some((message) => message.type === "error")) throw new Error();
      html = result.value;
    } catch {
      throw new Error("document_docx_xml_invalid");
    }
    return { pages: [htmlToOutline(html)], paged: false };
  }
  if (mime === "text/html") return { pages: pages.map(htmlToOutline), paged: false };
  if (mime === "application/pdf") return { pages, paged: true };
  return { pages: pages.map(stripHiddenMarkup), paged: pages.length > 1 };
}
