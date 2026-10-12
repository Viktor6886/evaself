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
  constructor(readonly code: "xlsx_xml_malformed" | "xlsx_text_too_long" = "xlsx_xml_malformed") {
    super(code);
    this.name = "XmlFormatError";
  }
}

export type XmlToken =
  | { kind: "open"; name: string; attrs: ReadonlyMap<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/** Больше атрибутов у одного тега в книге Excel не бывает. */
const MAX_ATTRIBUTES = 64;

/** Значение атрибута длиннее этого — не адрес, стиль или имя листа, а ловушка. */
const MAX_ATTRIBUTE_LENGTH = 65_536;

/**
 * Текст одного узла длиннее этого Евой не загружается: ячейка Excel
 * вмещает 32 767 знаков (выгрузка Евы пишет не больше 32 000, Google
 * Таблицы — 50 000), а в XML каждый знак самое большее семь: `_x000D_`,
 * `&quot;`. Без предела один узел на мегабайты раскодировался бы одним
 * куском, не отдавая цикл событий.
 */
export const MAX_TEXT_LENGTH = 262_144;

/**
 * Тег длиннее этого — не тег книги: у Excel самый длинный — корневой, с
 * объявлениями пространств имён, на пару килобайт. Без предела тег из
 * мегабайтов пробелов читался бы одним шагом, без паузы для цикла
 * событий.
 */
export const MAX_TAG_LENGTH = 65_536;

/**
 * Работа сканера, которую оплачивает вызывающий: токен — единица,
 * каждый `&` — единица, каждые `TAG_CHARS_PER_UNIT` знаков внутри тега —
 * единица, каждый атрибут сверх `FREE_ATTRIBUTES` — единица. Отказ —
 * исключение из `spend`.
 */
export type Spend = (units: number) => void;

/** Знаков тега на единицу работы: тег читается дважды, знак за знаком. */
export const TAG_CHARS_PER_UNIT = 32;

/**
 * Столько атрибутов у тега — в цене самого тега: у ячейки их три
 * (`r`, `s`, `t`). Каждый следующий — единица: тег из 64 коротких
 * атрибутов читается вдвое дольше, чем стоят его знаки.
 */
export const FREE_ATTRIBUTES = 4;

const free: Spend = () => undefined;

const NAMED = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", "\""], ["apos", "'"]]);
const DECIMAL = /^\d{1,7}$/;
const HEX = /^[0-9a-fA-F]{1,6}$/;

/** Тело сущности без `&` и `;` → знак; не сущность — `undefined`. */
function entity(body: string): string | undefined {
  if (body.charCodeAt(0) !== 0x23) return NAMED.get(body);
  const hex = body.charCodeAt(1) === 0x78;
  const digits = body.slice(hex ? 2 : 1);
  if (!(hex ? HEX : DECIMAL).test(digits)) return undefined;
  const code = hex ? Number.parseInt(digits, 16) : Number(digits);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  return String.fromCodePoint(code);
}

/** Длиннее `&#1114111;` и `&#x10FFFF;` сущности не бывает: `;` — не дальше девятого знака от `&`. */
const ENTITY_REACH = 9;

/**
 * Пять стандартных сущностей и числовые. Один проход по `&`: регулярное
 * выражение с функцией замены на тексте из одних сущностей тратило по
 * микросекунде на каждую. `;` ищется только в пределах сущности: поиск
 * до конца текста от каждого `&` делал строку из `&` и одной `;` в конце
 * квадратичной. Каждый `&` — единица работы в `spend`.
 */
export function decodeXml(text: string, spend: Spend = free): string {
  let amp = text.indexOf("&");
  if (amp < 0) return text;
  let out = "";
  let last = 0;
  let seen = 0;
  while (amp >= 0) {
    seen += 1;
    const reach = Math.min(text.length - 1, amp + ENTITY_REACH);
    let end = -1;
    for (let index = amp + 2; index <= reach; index += 1) {
      if (text.charCodeAt(index) === 0x3b) {
        end = index;
        break;
      }
    }
    const decoded = end < 0 ? undefined : entity(text.slice(amp + 1, end));
    if (decoded === undefined) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    out += text.slice(last, amp) + decoded;
    last = end + 1;
    amp = text.indexOf("&", last);
  }
  spend(seen);
  return out + text.slice(last);
}

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** Имя без префикса пространства имён: `x:row` и `row` — один элемент. */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Атрибуты тега без атрибутов — одна общая пустая таблица: у большинства тегов книги атрибутов нет. */
const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

function parseAttributes(source: string, start: number, spend: Spend): ReadonlyMap<string, string> {
  const length = source.length;
  let index = start;
  while (index < length && isSpace(source.charCodeAt(index))) index += 1;
  if (index >= length) return NO_ATTRIBUTES;
  const attrs = new Map<string, string>();
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
    if (attrs.size >= MAX_ATTRIBUTES || end - index > MAX_ATTRIBUTE_LENGTH) throw new XmlFormatError();
    attrs.set(name, decodeXml(source.slice(index + 1, end), spend));
    if (attrs.size > FREE_ATTRIBUTES) spend(1);
    index = end + 1;
  }
  return attrs;
}

/**
 * Токены XML по порядку. Текст между тегами отдаётся уже раскодированным;
 * CDATA — как есть. Работу сканер списывает в `spend` по ходу: шаг — до
 * того, как отдать токен, тег и сущности — как только видна их длина, а
 * она уже ограничена (`MAX_TAG_LENGTH`, `MAX_TEXT_LENGTH`).
 */
export function* scanXml(xml: string, spend: Spend = free): Generator<XmlToken> {
  const length = xml.length;
  let index = 0;
  while (index < length) {
    const open = xml.indexOf("<", index);
    const textEnd = open < 0 ? length : open;
    if (textEnd - index > MAX_TEXT_LENGTH) throw new XmlFormatError("xlsx_text_too_long");
    if (open < 0) {
      spend(1);
      yield { kind: "text", text: decodeXml(xml.slice(index), spend) };
      return;
    }
    if (open > index) {
      spend(1);
      yield { kind: "text", text: decodeXml(xml.slice(index, open), spend) };
    }
    const next = xml.charCodeAt(open + 1);
    // Комментарий и объявление — тоже шаг: миллионы `<!---->` иначе
    // обходили бы счёт работы.
    if (next === 0x3f || next === 0x21) spend(1);
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
        if (end - open > MAX_TEXT_LENGTH) throw new XmlFormatError("xlsx_text_too_long");
        yield { kind: "text", text: xml.slice(open + 9, end) };
        index = end + 3;
        continue;
      }
      // <!DOCTYPE и прочие объявления в частях книги не нужны и опасны.
      throw new XmlFormatError();
    }
    // Конец тега — первый `>` вне кавычек: внутри значения атрибута `>`
    // допустим. Дальше `MAX_TAG_LENGTH` от начала тега его не ищут.
    const reach = Math.min(length, open + MAX_TAG_LENGTH);
    let cursor = open + 1;
    let quote = 0;
    while (cursor < reach) {
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
    if (cursor >= reach) throw new XmlFormatError();
    spend(1 + Math.floor((cursor - open) / TAG_CHARS_PER_UNIT));
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
    yield { kind: "open", name: localName(body.slice(0, nameEnd)), attrs: parseAttributes(body, nameEnd, spend), selfClosing };
  }
}

/** Атрибут без учёта префикса: `r:id` у одних и `x:id`/`id` у других. */
export function attribute(attrs: ReadonlyMap<string, string>, local: string): string | undefined {
  if (attrs.has(local)) return attrs.get(local);
  for (const [key, value] of attrs) {
    if (key.endsWith(`:${local}`)) return value;
  }
  return undefined;
}
