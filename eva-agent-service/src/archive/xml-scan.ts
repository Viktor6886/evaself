/**
 * Линейный сканер XML для частей книги Excel.
 *
 * Регулярное выражение вида `<tag>([\s\S]*?)</tag>` на враждебном входе
 * квадратично: от каждого незакрытого начала тега оно заново читает
 * остаток текста, и файл в пару килобайт держит процессор минутами (и
 * весь сервис вместе с ним: разбор идёт в общем цикле событий). Здесь
 * текст проходит один раз: каждый символ читается ограниченное число раз,
 * а незакрытый тег, комментарий или значение атрибута — ошибка формата,
 * а не повод перечитать хвост.
 *
 * DTD не разбирается вовсе: `<!DOCTYPE` — ошибка формата, сущности кроме
 * пяти стандартных и числовых не раскрываются.
 */

export class XmlFormatError extends Error {
  constructor() {
    super("xlsx_xml_malformed");
    this.name = "XmlFormatError";
  }
}

export type XmlToken =
  | { kind: "open"; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/** Больше атрибутов у одного тега в книге Excel не бывает. */
const MAX_ATTRIBUTES = 64;

const XML_ENTITY = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeXml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(XML_ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? whole;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** Имя без префикса пространства имён: `x:row` и `row` — один элемент. */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function parseAttributes(source: string, start: number): Map<string, string> {
  const attrs = new Map<string, string>();
  const length = source.length;
  let index = start;
  while (index < length) {
    while (index < length && isSpace(source.charCodeAt(index))) index += 1;
    if (index >= length) break;
    const nameStart = index;
    while (index < length) {
      const code = source.charCodeAt(index);
      if (isSpace(code) || code === 0x3d) break;
      index += 1;
    }
    const name = source.slice(nameStart, index);
    while (index < length && isSpace(source.charCodeAt(index))) index += 1;
    if (!name || source.charCodeAt(index) !== 0x3d) throw new XmlFormatError();
    index += 1;
    while (index < length && isSpace(source.charCodeAt(index))) index += 1;
    const quote = source[index];
    if (quote !== "\"" && quote !== "'") throw new XmlFormatError();
    const end = source.indexOf(quote, index + 1);
    if (end < 0) throw new XmlFormatError();
    if (attrs.size >= MAX_ATTRIBUTES) throw new XmlFormatError();
    attrs.set(name, decodeXml(source.slice(index + 1, end)));
    index = end + 1;
  }
  return attrs;
}

/**
 * Токены XML по порядку. Текст между тегами отдаётся уже раскодированным;
 * CDATA — как есть.
 */
export function* scanXml(xml: string): Generator<XmlToken> {
  const length = xml.length;
  let index = 0;
  while (index < length) {
    const open = xml.indexOf("<", index);
    if (open < 0) {
      yield { kind: "text", text: decodeXml(xml.slice(index)) };
      return;
    }
    if (open > index) yield { kind: "text", text: decodeXml(xml.slice(index, open)) };
    const next = xml.charCodeAt(open + 1);
    if (next === 0x3f) {
      // <?xml … ?>
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) throw new XmlFormatError();
      index = end + 2;
      continue;
    }
    if (next === 0x21) {
      if (xml.startsWith("<!--", open)) {
        const end = xml.indexOf("-->", open + 4);
        if (end < 0) throw new XmlFormatError();
        index = end + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", open)) {
        const end = xml.indexOf("]]>", open + 9);
        if (end < 0) throw new XmlFormatError();
        yield { kind: "text", text: xml.slice(open + 9, end) };
        index = end + 3;
        continue;
      }
      // <!DOCTYPE и прочие объявления в частях книги не нужны и опасны.
      throw new XmlFormatError();
    }
    // Конец тега — первый `>` вне кавычек: внутри значения атрибута `>`
    // допустим.
    let cursor = open + 1;
    let quote = 0;
    while (cursor < length) {
      const code = xml.charCodeAt(cursor);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === 0x22 || code === 0x27) {
        quote = code;
      } else if (code === 0x3e) {
        break;
      } else if (code === 0x3c) {
        throw new XmlFormatError();
      }
      cursor += 1;
    }
    if (cursor >= length) throw new XmlFormatError();
    const inner = xml.slice(open + 1, cursor);
    index = cursor + 1;
    if (inner.charCodeAt(0) === 0x2f) {
      yield { kind: "close", name: localName(inner.slice(1).trim()) };
      continue;
    }
    const selfClosing = inner.charCodeAt(inner.length - 1) === 0x2f;
    const body = selfClosing ? inner.slice(0, -1) : inner;
    let nameEnd = 0;
    while (nameEnd < body.length && !isSpace(body.charCodeAt(nameEnd))) nameEnd += 1;
    if (nameEnd === 0) throw new XmlFormatError();
    yield { kind: "open", name: localName(body.slice(0, nameEnd)), attrs: parseAttributes(body, nameEnd), selfClosing };
  }
}

/** Атрибут без учёта префикса: `r:id` у одних и `x:id`/`id` у других. */
export function attribute(attrs: Map<string, string>, local: string): string | undefined {
  if (attrs.has(local)) return attrs.get(local);
  for (const [key, value] of attrs) {
    if (key.endsWith(`:${local}`)) return value;
  }
  return undefined;
}
