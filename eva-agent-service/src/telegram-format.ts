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

/**
 * Теги, которые Telegram принимает в parse_mode=HTML.
 *
 * Список закрытый: любой другой тег — HTTP 400 и потерянное сообщение,
 * поэтому генерируем только эти и только их пропускаем при проверке.
 */
const SUPPORTED_TAGS = [
  "b", "i", "s", "u", "code", "pre", "a", "blockquote", "tg-spoiler",
] as const;

/**
 * Блочные теги, внутри которых нельзя разрезать сообщение.
 *
 * Половина цитаты в одном сообщении и половина в другом выглядит как
 * сломанная вёрстка, а спойлер, разорванный пополам, вообще перестаёт
 * быть спойлером.
 */
const UNBREAKABLE_TAGS = new Set(["blockquote", "tg-spoiler", "pre"]);

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
    // ||спойлер|| — соглашение Discord, модели его знают. Обрабатывается
    // до жирного: внутри спойлера разметка тоже должна работать.
    .replace(/\|\|(?=\S)([\s\S]*?\S)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
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

    // Цитата: > обычная, >> сворачиваемая.
    //
    // Сворачиваемая нужна для длинных пояснений: показывать их целиком
    // сразу — значит утопить в них сам ответ, а прятать в спойлер —
    // намекнуть, что там что-то деликатное, чего в пояснении нет.
    const quote = /^\s{0,3}(>>?)\s?(.*)$/.exec(line);
    if (quote) {
      const expandable = quote[1] === ">>";
      const body: string[] = [quote[2]!];
      index += 1;
      while (index < lines.length) {
        const next = /^\s{0,3}>>?\s?(.*)$/.exec(lines[index]!);
        if (!next) break;
        body.push(next[1]!);
        index += 1;
      }
      const rendered = inline(body.join("\n"));
      out.push(
        expandable
          ? `<blockquote expandable>${rendered}</blockquote>`
          : `<blockquote>${rendered}</blockquote>`,
      );
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
  const tagPattern = /<(\/?)([a-z][a-z-]*)(\s[^>]*)?>/gi;
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
 * Предел Telegram — 4096 символов после разбора entities. Берём с
 * запасом: HTML-теги в лимит не входят, но считать их вклад точнее, чем
 * «с запасом», значит повторять разбор Telegram на своей стороне.
 *
 * Резать по символам нельзя по двум причинам. Разрез внутри тега даёт
 * невалидный HTML в обеих половинах. Разрез внутри цитаты или спойлера
 * валиден, но выглядит как сломанная вёрстка: половина цитаты в одном
 * сообщении, половина в другом.
 */
export function splitTelegramHtml(html: string, maxLength = 3_500): string[] {
  const source = html.trim();
  if (!source) return [];
  if (visibleLength(source) <= maxLength) return [source];

  // Сначала делим на неделимые единицы: блочный тег целиком либо
  // обычная строка.
  const units = splitIntoUnits(source);
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current}\n${unit}` : unit;
    if (visibleLength(candidate) <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (visibleLength(unit) <= maxLength) {
      current = unit;
      continue;
    }
    // Единица сама длиннее лимита. Блочный тег в таком случае теряет
    // обёртку: показать текст без цитаты лучше, чем не показать его.
    for (const piece of hardSplit(unwrapBlock(unit), maxLength)) chunks.push(piece);
  }
  if (current) chunks.push(current);

  return chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => (isValidTelegramHtml(chunk) ? chunk : stripTags(chunk)));
}

/** Длина без учёта тегов: в лимит Telegram они не входят. */
function visibleLength(html: string): number {
  return html.replace(/<\/?[a-z][a-z-]*[^>]*>/gi, "").length;
}

/**
 * Разбор на неделимые единицы: блочный тег целиком либо строка.
 */
function splitIntoUnits(html: string): string[] {
  const units: string[] = [];
  const blockPattern = new RegExp(
    `<(${[...UNBREAKABLE_TAGS].join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
    "gi",
  );
  let position = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(html)) !== null) {
    const before = html.slice(position, match.index);
    for (const line of before.split("\n")) {
      if (line.trim()) units.push(line);
    }
    units.push(match[0]);
    position = match.index + match[0].length;
  }
  for (const line of html.slice(position).split("\n")) {
    if (line.trim()) units.push(line);
  }
  return units;
}

/** Снимает внешний блочный тег, оставляя содержимое. */
function unwrapBlock(unit: string): string {
  const match = new RegExp(
    `^<(${[...UNBREAKABLE_TAGS].join("|")})\\b[^>]*>([\\s\\S]*)<\\/\\1\\s*>$`,
    "i",
  ).exec(unit.trim());
  return match ? match[2]!.trim() : unit;
}

/** Последнее средство: режем по словам, не рассекая тег. */
function hardSplit(text: string, maxLength: number): string[] {
  const pieces: string[] = [];
  let rest = text;

  while (visibleLength(rest) > maxLength) {
    let cut = rest.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    const opened = rest.lastIndexOf("<", cut);
    const closed = rest.lastIndexOf(">", cut);
    if (opened > closed) cut = opened;
    const piece = rest.slice(0, cut);
    pieces.push(isValidTelegramHtml(piece) ? piece : stripTags(piece));
    rest = rest.slice(cut).trim();
  }
  if (rest.trim()) pieces.push(isValidTelegramHtml(rest) ? rest : stripTags(rest));
  return pieces;
}

/** Аварийный откат: текст без разметки, но с читаемыми символами. */
export function stripTags(html: string): string {
  return html
    .replace(/<\/?[a-z][a-z-]*[^>]*>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Безопасное подмножество Rich Markdown для ответов Евы.
 *
 * Telegram Rich Markdown допускает произвольный HTML, media, карты и
 * специальные блоки. Модель не должна получать через оформление право
 * выполнять такие действия, поэтому наружу проходят только текстовые
 * конструкции и details/summary/underline.
 */
export function richMarkdownForTelegram(markdown: string): string {
  const source = markdown.replace(/\r\n/g, "\n").trim();
  if (!source) return "";

  const expandedLines: string[] = [];
  const sourceLines = source.split("\n");
  for (let index = 0; index < sourceLines.length; index += 1) {
    const first = /^>>\s?(.*)$/.exec(sourceLines[index]!);
    if (!first) {
      expandedLines.push(sourceLines[index]!);
      continue;
    }
    const body = [first[1]!];
    while (index + 1 < sourceLines.length) {
      const next = /^>>\s?(.*)$/.exec(sourceLines[index + 1]!);
      if (!next) break;
      body.push(next[1]!);
      index += 1;
    }
    expandedLines.push("<details><summary>Подробнее</summary>", ...body, "</details>");
  }
  const expandedSource = expandedLines.join("\n");

  // Code is content, not markup. Protect it before removing media/map HTML,
  // otherwise an example such as `<img>` would disappear from a code block.
  const codeSegments: string[] = [];
  const protectCode = (segment: string): string => {
    codeSegments.push(segment);
    return `\u{E200}${codeSegments.length - 1}\u{E201}`;
  };
  const protectedSource = expandedSource
    .replace(/```[\s\S]*?```/g, protectCode)
    .replace(/`[^`\n]+`/g, protectCode);

  const allowedTags: string[] = [];
  const keep = (tag: string): string => {
    allowedTags.push(tag);
    return `\u{E100}${allowedTags.length - 1}\u{E101}`;
  };

  let safe = protectedSource
    .replace(/!\[[^\]\n]*\]\([^\n)]*\)/g, "")
    .replace(/<(tg-collage|tg-slideshow|figure|video|audio|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:tg-map|img|video|audio|tg-thinking)\b[^>]*\/?\s*>/gi, "")
    .replace(/<\/?(?:details|summary|u|ins)\b[^>]*>/gi, (tag) => keep(tag.replace(/\s+open(?=[\s>])/i, "")))
    .replace(/<[^>\n]+>/g, "")
    .replace(/\u{E100}(\d+)\u{E101}/gu, (_match, index: string) => allowedTags[Number(index)] ?? "")
    .replace(/\u{E200}(\d+)\u{E201}/gu, (_match, index: string) => codeSegments[Number(index)] ?? "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) =>
      /^https?:\/\//i.test(url) ? match : label)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const opens = (safe.match(/<details>/gi) ?? []).length;
  const closes = (safe.match(/<\/details>/gi) ?? []).length;
  const summaries = (safe.match(/<summary>/gi) ?? []).length;
  const summaryCloses = (safe.match(/<\/summary>/gi) ?? []).length;
  if (opens !== closes || summaries !== summaryCloses || summaries > opens) {
    safe = safe.replace(/<\/?(?:details|summary)>/gi, "");
  }
  return safe;
}

/** Смысловой текст ответа для TTS, без Rich Markdown и таблиц. */
export function speechTextFromReply(reply: string): string {
  const lines = richMarkdownForTelegram(reply).split("\n");
  const spoken: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    let line = raw.trim();
    if (!line || inFence || /^\|?\s*:?-{3,}/.test(line)) continue;
    if (/^\|(?!\|).*\|$/.test(line) && (line.match(/\|/g) ?? []).length >= 3) {
      const cells = line.slice(1, -1).split("|")
        .map((cell) => cell.trim().replace(/(?:\*\*|__|~~|`)/g, ""))
        .filter(Boolean);
      if (cells.length > 0) {
        const sentence = cells.join(". ");
        spoken.push(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);
      }
      continue;
    }
    line = line
      .replace(/<\/?(?:details|summary|u|ins)>/gi, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>{1,2}\s?/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\|\|([\s\S]*?)\|\|/g, "$1")
      .replace(/\[([^\]]+)]\((?:https?:\/\/)[^)]+\)/g, "$1")
      .replace(/(?:\*\*|__|~~|`)/g, "")
      .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
      .trim();
    if (line) spoken.push(line);
  }
  return spoken.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// =====================================================================
// Сборка сообщения из структуры
// =====================================================================
/**
 * Разделы сообщения Евы.
 *
 * Смысл структуры — в том, что решение «что во что оборачивать»
 * принимает код, а не модель. Модель называет роль куска текста
 * («это главный вывод», «это подробности»), а какими тегами это
 * показать и в каком порядке — решается здесь, одинаково для всех
 * сообщений: и для ответа агента, и для напоминания, и для сообщения
 * о квоте.
 */
export interface EvaMessageParts {
  /** Заголовок. Одна строка, жирным. */
  title?: string;
  /** Вводный абзац перед главным выводом. */
  intro?: string;
  /** Главный вывод. Всегда попадает в обычную цитату — он один. */
  key_point?: string;
  /** Основной текст: абзацы или пункты списка. */
  body?: string[];
  /** Второстепенное, что уместно открыть нажатием. */
  hidden_text?: string;
  /** Длинное пояснение. Свернётся, если длиннее порога. */
  details?: string;
  /** Конкретное следующее действие или вопрос к пользователю. */
  action?: string;
}

/** С какой длины пояснение прячется под «Подробнее». */
const EXPANDABLE_THRESHOLD = 280;

/** Заголовки блоков. Вынесены, чтобы не расходились между сообщениями. */
const BLOCK_TITLES = { key: "Главное", details: "Подробнее" } as const;

/**
 * Структура → безопасный HTML.
 *
 * Весь текст экранируется: сюда приходит и вывод модели, и данные
 * пользователя, и ни то ни другое не должно уметь закрыть чужой тег.
 * Пустые разделы не выводятся вовсе — пустая цитата выглядит как
 * ошибка вёрстки.
 */
export function renderEvaMessage(parts: EvaMessageParts): string {
  const blocks: string[] = [];
  const clean = (value?: string) => (value ?? "").trim();

  const title = clean(parts.title);
  const intro = clean(parts.intro);
  const keyPoint = clean(parts.key_point);
  const body = (parts.body ?? []).map(clean).filter(Boolean);
  const hidden = clean(parts.hidden_text);
  const details = clean(parts.details);
  const action = clean(parts.action);

  // Короткий ответ не нужно наряжать: одна мысль в цитате и с
  // заголовком выглядит как бюрократическая записка, а не как реплика
  // в разговоре.
  const isTerse =
    !title && !keyPoint && !hidden && !details && body.length <= 1 && intro.length < 200;
  if (isTerse) {
    const only = [intro, ...body, action].filter(Boolean).join("\n\n");
    return markdownToTelegramHtml(only);
  }

  if (title) blocks.push(`<b>${inline(title)}</b>`);
  if (intro) blocks.push(inline(intro));

  if (keyPoint) {
    blocks.push(
      `<blockquote><b>${escapeHtml(BLOCK_TITLES.key)}</b>\n${inline(keyPoint)}</blockquote>`,
    );
  }

  if (body.length === 1) {
    blocks.push(inline(body[0]!));
  } else if (body.length > 1) {
    // Несколько пунктов — это список, а не абзацы: так его и покажем.
    blocks.push(body.map((item) => `• ${inline(item)}`).join("\n"));
  }

  if (hidden) blocks.push(`<tg-spoiler>${inline(hidden)}</tg-spoiler>`);

  if (details) {
    // Короткое пояснение прятать незачем — лишний клик ради двух строк.
    blocks.push(
      details.length > EXPANDABLE_THRESHOLD
        ? `<blockquote expandable><b>${escapeHtml(BLOCK_TITLES.details)}</b>\n`
          + `${inline(details)}</blockquote>`
        : inline(details),
    );
  }

  // Вопрос или следующий шаг — последним и жирным: это то, с чем
  // пользователь остаётся после прочтения.
  if (action) blocks.push(`<b>${inline(action)}</b>`);

  return blocks.filter(Boolean).join("\n\n").trim();
}

/**
 * Разбор структуры из ответа модели.
 *
 * Модель может прислать JSON с известными полями — тогда сообщение
 * собирается детерминированно. Если не прислала, это не ошибка: обычный
 * markdown работает и дальше. Требовать JSON от агента в цикле с
 * инструментами — верный способ иногда получать пустое сообщение вместо
 * ответа.
 */
export function parseEvaMessage(text: string): EvaMessageParts | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const known = ["title", "intro", "key_point", "body", "hidden_text", "details", "action"];
  // Случайный JSON в ответе (например, кусок API) не должен принимать
  // вид сообщения Евы: требуем хотя бы одно осмысленное поле.
  if (!known.some((key) => key in source)) return null;

  const asText = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    title: asText(source.title),
    intro: asText(source.intro),
    key_point: asText(source.key_point),
    body: Array.isArray(source.body) ? source.body.map(asText).filter(Boolean) : [],
    hidden_text: asText(source.hidden_text),
    details: asText(source.details),
    action: asText(source.action),
  };
}

/**
 * Готовый HTML из ответа модели: структура, если она есть, иначе markdown.
 */
export function formatEvaReply(text: string): string {
  const parts = parseEvaMessage(text);
  return parts ? renderEvaMessage(parts) : markdownToTelegramHtml(text);
}
