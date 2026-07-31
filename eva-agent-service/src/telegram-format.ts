/**
 * Markdown модели → разметка, которую понимает Telegram.
 *
 * Модель пишет обычным markdown: **жирный**, списки, заголовки, ссылки
 * вида [текст](url). Telegram markdown не понимает — сообщения уходили
 * без parse_mode, и пользователь видел сырые звёздочки: «**Сегодня в
 * Перми:** +21..+23°C».
 *
 * Почему HTML, а не MarkdownV2. В MarkdownV2 экранировать нужно
 * восемнадцать символов, включая точку, минус и скобки, — то есть почти
 * любой обычный текст. Один пропущенный символ превращает сообщение в
 * HTTP 400, и ответ Евы просто не доходит. В HTML экранируются ровно
 * три символа: < > &.
 *
 * Telegram поддерживает не весь HTML, а короткий список тегов. Всё
 * остальное — ошибка запроса, поэтому здесь генерируются только
 * b, i, s, u, code, pre, a, blockquote.
 */

/** Теги, которые Telegram принимает в parse_mode=HTML. */
const SUPPORTED_TAGS = ["b", "i", "s", "u", "code", "pre", "a", "blockquote"] as const;

/** Экранирование по правилам Telegram: ровно три символа. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Ссылка в href должна быть безопасной.
 *
 * javascript: и data: в Telegram не сработают, но и отдавать их клиенту
 * незачем: модель может подставить туда что угодно из результата поиска.
 */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed) && !/^tg:\/\//i.test(trimmed)) return null;
  if (trimmed.includes("\n") || trimmed.length > 2_000) return null;
  return escapeHtml(trimmed);
}

/**
 * Инлайновая разметка внутри одной строки.
 *
 * Порядок важен: сначала код, потому что внутри `…` разметка не
 * действует, и звёздочки там должны остаться звёздочками.
 */
function inline(text: string): string {
  const codeSpans: string[] = [];
  // Код вырезается до экранирования и возвращается на место последним:
  // иначе ** внутри `a ** b` превратились бы в жирный шрифт.
  let out = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    // Метка из приватной области Unicode: в тексте модели её быть не
    // может, и escapeHtml её не трогает. Разделитель вроде « 0 » не
    // годится — под него попал бы любой номер в тексте пользователя.
    return `\u{E000}${codeSpans.length - 1}\u{E001}`;
  });

  out = escapeHtml(out);

  // Ссылки [текст](url). Обрабатываются до жирного: текст ссылки может
  // содержать собственную разметку.
  out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const href = safeHref(url);
    if (!href) return label || match;
    return `<a href="${href}">${label.trim() || href}</a>`;
  });

  // Голый URL в скобках после текста — частый вывод моделей:
  // «- [59.ru — новости](https://59.ru/…)» уже покрыт выше, а вот
  // «Полная лента: https://59.ru/» Telegram распознаёт сам, трогать не надо.

  out = out
    // ***жирный курсив*** — до ** и *, иначе разберётся неправильно
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    // __жирный__ и _курсив_ — подчёркивание внутри слова не трогаем,
    // иначе имена вроде file_name_here развалятся
    .replace(/(^|[\s(])__(?=\S)([\s\S]*?\S)__(?=[\s).,!?:;]|$)/g, "$1<b>$2</b>")
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>");

  // Возврат кода на место.
  out = out.replace(
    /\u{E000}(\d+)\u{E001}/gu,
    (match, index: string) => codeSpans[Number(index)] ?? match,
  );
  return out;
}

/**
 * Полное преобразование ответа модели.
 *
 * Блочные конструкции обрабатываются построчно, инлайновые — внутри
 * строки. Заголовки становятся жирной строкой: собственных заголовков в
 * Telegram нет, а «###» в тексте выглядит как мусор.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const source = markdown.replace(/\r\n/g, "\n").trim();
  if (!source) return "";

  const out: string[] = [];
  const lines = source.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    // Блок кода ```lang … ```
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1; // закрывающая ограда
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      out.push(`<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Заголовок ###
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[2]!.trim())}</b>`);
      index += 1;
      continue;
    }

    // Горизонтальная черта — в Telegram её нет, заменяем видимой линией
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push("──────────");
      index += 1;
      continue;
    }

    // Цитата >
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      const body: string[] = [quote[1]!];
      index += 1;
      while (index < lines.length) {
        const next = /^\s{0,3}>\s?(.*)$/.exec(lines[index]!);
        if (!next) break;
        body.push(next[1]!);
        index += 1;
      }
      out.push(`<blockquote>${inline(body.join("\n"))}</blockquote>`);
      continue;
    }

    // Маркированный список: дефис и звёздочка выглядят в Telegram
    // одинаково сиротливо, поэтому ставим настоящий буллет.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = "  ".repeat(Math.min(Math.floor(bullet[1]!.length / 2), 3));
      out.push(`${indent}• ${inline(bullet[2]!)}`);
      index += 1;
      continue;
    }

    // Нумерованный список — номер сохраняем, он несёт смысл
    const numbered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const indent = "  ".repeat(Math.min(Math.floor(numbered[1]!.length / 2), 3));
      out.push(`${indent}${numbered[2]}. ${inline(numbered[3]!)}`);
      index += 1;
      continue;
    }

    out.push(inline(line));
    index += 1;
  }

  // Больше одной пустой строки подряд Telegram всё равно схлопывает,
  // а в исходнике модели их бывает много.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Проверка, что получившийся HTML Telegram примет.
 *
 * Если модель напишет что-то, из чего получится незакрытый или чужой
 * тег, Telegram ответит 400 и сообщение не дойдёт вовсе. Дешевле
 * проверить здесь и отправить обычным текстом, чем потерять ответ.
 */
export function isValidTelegramHtml(html: string): boolean {
  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-z]+)(\s[^>]*)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    if (!SUPPORTED_TAGS.includes(name as (typeof SUPPORTED_TAGS)[number])) return false;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

/**
 * Разбиение длинного ответа с учётом разметки.
 *
 * Резать по символам нельзя: разрез внутри тега даёт невалидный HTML в
 * обеих половинах. Режем по границам строк верхнего уровня и следим,
 * чтобы открытые теги закрывались внутри своего куска.
 */
export function splitTelegramHtml(html: string, maxLength = 3_500): string[] {
  if (html.length <= maxLength) return html ? [html] : [];

  const chunks: string[] = [];
  let current = "";

  for (const block of html.split("\n")) {
    const candidate = current ? `${current}\n${block}` : block;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // Одна строка длиннее лимита — режем её по словам, следя за тегами.
    if (block.length > maxLength) {
      let rest = block;
      while (rest.length > maxLength) {
        let cut = rest.lastIndexOf(" ", maxLength);
        if (cut < maxLength * 0.5) cut = maxLength;
        // Не режем внутри тега.
        const opened = rest.lastIndexOf("<", cut);
        const closed = rest.lastIndexOf(">", cut);
        if (opened > closed) cut = opened;
        const piece = rest.slice(0, cut);
        chunks.push(isValidTelegramHtml(piece) ? piece : stripTags(piece));
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    current = block;
  }
  if (current) chunks.push(current);

  return chunks
    .map((chunk) => (isValidTelegramHtml(chunk) ? chunk : stripTags(chunk)))
    .filter((chunk) => chunk.trim().length > 0);
}

/** Аварийный откат: текст без разметки, но с читаемыми символами. */
export function stripTags(html: string): string {
  return html
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
