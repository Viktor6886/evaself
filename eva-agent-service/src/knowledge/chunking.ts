/**
 * Нарезка документа с учётом структуры (docs/knowledge-base.md, K3).
 *
 * Прежняя нарезка резала сплошной поток знаков: фрагмент начинался в
 * середине одного раздела и кончался в другом, а у фрагмента не было ни
 * страницы, ни раздела — «покажи источник» было нечем ответить.
 *
 * Здесь документ идёт по строкам: заголовки (markdown `#`, нумерованные
 * «2.1 …», «Глава», «Раздел», строки заглавными) задают раздел и подраздел,
 * абзацы собираются во фрагменты не длиннее заданного, фрагмент не
 * пересекает границу раздела, а перекрытие повторяет конец предыдущего
 * фрагмента того же раздела. У каждого фрагмента — страницы, раздел,
 * подраздел и ближайший заголовок.
 *
 * Модуль чистый: ни базы, ни сети, ни модели.
 */

import { createHash } from "node:crypto";

export interface ChunkingOptions {
  /** Предельная длина фрагмента, знаков. */
  size: number;
  /** Сколько знаков конца предыдущего фрагмента повторить в начале следующего. */
  overlap: number;
}

export interface StructuredChunk {
  ordinal: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  subsection: string | null;
  heading: string | null;
  contentHash: string;
  /** Оценка: ~4 знака на токен. Для бюджета контекста, не для биллинга. */
  tokenCount: number;
}

interface Paragraph {
  text: string;
  page: number | null;
}

interface HeadingPath {
  section: string | null;
  subsection: string | null;
  heading: string | null;
}

const MAX_HEADING = 160;

/** Уровень заголовка строки или null — строка не заголовок. */
export function headingLevel(line: string): { level: number; title: string } | null {
  const text = line.trim();
  if (!text || text.length > MAX_HEADING) return null;
  const markdown = /^(#{1,6})\s+(.+)$/u.exec(text);
  if (markdown) return { level: markdown[1]!.length, title: markdown[2]!.replace(/\s+#+\s*$/u, "").trim() };
  // «1. Общие положения», «2.3 Порядок работы»: номер, пробел, заглавная
  // буква, без точки в конце — строка оглавления, а не пункт списка.
  const numbered = /^(\d{1,3}(?:\.\d{1,3}){0,3})\.?\s+([A-ZА-ЯЁ«"].*)$/u.exec(text);
  if (numbered && !/[.;:,]$/u.test(text) && text.length <= 100) {
    return { level: Math.min(numbered[1]!.split(".").filter(Boolean).length, 3), title: text };
  }
  if (/^(?:глава|раздел|часть)\s+\S+/iu.test(text) && !/[.;,]$/u.test(text)) return { level: 1, title: text };
  if (/^(?:статья|параграф|§)\s*\S+/iu.test(text) && !/[;,]$/u.test(text)) return { level: 2, title: text };
  // Строка заглавными — заголовок, если в ней есть буквы и она короткая:
  // «ОБЩИЕ ПОЛОЖЕНИЯ», но не «Р-168-5УН» и не «ООО».
  const letters = text.replace(/[^A-Za-zА-Яа-яЁё]/gu, "");
  if (letters.length >= 6 && text.length <= 80 && letters === letters.toUpperCase() && /\s/u.test(text)) {
    return { level: 1, title: text };
  }
  return null;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Хвост текста для перекрытия — с границы предложения или слова. */
function tail(text: string, length: number): string {
  if (length <= 0 || text.length <= length) return length <= 0 ? "" : text;
  const slice = text.slice(text.length - length);
  const sentence = slice.search(/[.!?…]\s+\S/u);
  if (sentence >= 0 && sentence < slice.length / 2) return slice.slice(sentence + 1).trim();
  const space = slice.indexOf(" ");
  return (space >= 0 ? slice.slice(space + 1) : slice).trim();
}

/** Разбить слишком длинный абзац: по предложениям, а предложение — по словам. */
function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+|$)\s*/gu) ?? [text];
  const parts: string[] = [];
  let current = "";
  const push = (piece: string): void => {
    if (piece.length <= size) {
      if ((current + piece).length > size && current) {
        parts.push(current.trim());
        current = "";
      }
      current += piece;
      return;
    }
    // Одно «предложение» длиннее фрагмента (таблица, перечень без точек):
    // режется по словам.
    for (const word of piece.split(/(\s+)/u)) {
      if ((current + word).length > size && current.trim()) {
        parts.push(current.trim());
        current = "";
      }
      current += word.length > size ? word.slice(0, size) : word;
    }
  };
  for (const sentence of sentences) push(sentence);
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Нарезать страницы документа. `paged` — страницы настоящие (номер
 * страницы = индекс + 1); иначе страниц у фрагментов нет.
 */
export function chunkDocument(pages: readonly string[], paged: boolean, options: ChunkingOptions): StructuredChunk[] {
  const size = Math.max(100, Math.floor(options.size));
  const overlap = Math.min(Math.max(0, Math.floor(options.overlap)), Math.floor(size / 2));

  // 1. Абзацы с заголовками над ними.
  const blocks: Array<{ path: HeadingPath; paragraphs: Paragraph[] }> = [];
  let path: HeadingPath = { section: null, subsection: null, heading: null };
  let current: Paragraph[] = [];
  let buffer: string[] = [];
  let bufferPage: number | null = null;
  const closeParagraph = (): void => {
    const text = buffer.join(" ").replace(/\s+/gu, " ").trim();
    if (text) current.push({ text, page: bufferPage });
    buffer = [];
  };
  const closeBlock = (): void => {
    closeParagraph();
    if (current.length) blocks.push({ path, paragraphs: current });
    current = [];
  };
  pages.forEach((page, index) => {
    const pageNumber = paged ? index + 1 : null;
    for (const raw of page.normalize("NFKC").split(/\r?\n/u)) {
      // Управляющие знаки (из PDF их приходит немало) — пробелы.
      const line = raw.replace(/\p{Cc}/gu, " ").trim();
      if (!line) {
        closeParagraph();
        continue;
      }
      const heading = headingLevel(line);
      if (heading) {
        closeBlock();
        path = heading.level <= 1
          ? { section: heading.title, subsection: null, heading: heading.title }
          : heading.level === 2
            ? { section: path.section, subsection: heading.title, heading: heading.title }
            : { section: path.section, subsection: path.subsection, heading: heading.title };
        continue;
      }
      if (!buffer.length) bufferPage = pageNumber;
      buffer.push(line);
    }
    // Абзац не переходит через страницу: номер страницы фрагмента — это
    // то, что человек откроет, чтобы проверить цитату.
    closeParagraph();
  });
  closeBlock();

  // 2. Фрагменты внутри блока одного раздела.
  const chunks: StructuredChunk[] = [];
  for (const block of blocks) {
    let text = "";
    let pageStart: number | null = null;
    let pageEnd: number | null = null;
    let previous = "";
    const flush = (): void => {
      const content = text.trim();
      if (content) {
        chunks.push({
          ordinal: chunks.length,
          content,
          pageStart,
          pageEnd,
          section: block.path.section,
          subsection: block.path.subsection,
          heading: block.path.heading,
          contentHash: hash(content),
          tokenCount: Math.ceil(content.length / 4),
        });
        previous = content;
      }
      text = "";
      pageStart = null;
      pageEnd = null;
    };
    const append = (piece: string, page: number | null): void => {
      if (!text && previous && overlap > 0) {
        const carried = tail(previous, overlap);
        if (carried && carried.length + 1 + piece.length <= size) text = `${carried} `;
      }
      text = text ? `${text}${/\s$/u.test(text) ? "" : "\n\n"}${piece}` : piece;
      if (page !== null) {
        pageStart = pageStart === null ? page : Math.min(pageStart, page);
        pageEnd = pageEnd === null ? page : Math.max(pageEnd, page);
      }
    };
    // Длинный абзац режется с запасом под перекрытие: куски ровно по
    // пределу не оставили бы ему места, и оно молча пропадало бы.
    const pieceSize = Math.max(50, size - overlap - 1);
    for (const paragraph of block.paragraphs) {
      for (const piece of splitLong(paragraph.text, pieceSize)) {
        if (text && text.length + 2 + piece.length > size) flush();
        append(piece, paragraph.page);
      }
    }
    flush();
  }
  return chunks;
}

/**
 * Текст для вектора: путь заголовков и фрагмент. Заголовок несёт смысл,
 * которого нет в самом абзаце («Порядок увольнения» над «в течение двух
 * недель»), и без него фрагмент хуже находится.
 */
export function embeddingText(chunk: Pick<StructuredChunk, "content" | "section" | "subsection" | "heading">): string {
  const path = [chunk.section, chunk.subsection, chunk.heading]
    .filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index);
  return path.length ? `${path.join(" › ")}\n${chunk.content}` : chunk.content;
}
