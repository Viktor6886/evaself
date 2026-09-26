/**
 * Поисковые варианты идентификатора.
 *
 * Варианты строит код, а не модель: у ФИО и телефона их конечное и
 * известное множество, и генерировать его «творчески» значит тратить
 * бюджет исследования на запросы, которые ничего не добавляют. Модель
 * может предложить план поверх этих вариантов, но проверяет его и
 * ограничивает оркестратор.
 *
 * Потолок жёсткий: `MAX_QUERIES_PER_IDENTIFIER`. Тысяча запросов по
 * одному имени — это не тщательность, а бан поисковика.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";

import type { NormalizedIdentifier } from "./identifiers.js";

export const MAX_QUERIES_PER_IDENTIFIER = 12;

/**
 * Открытые страницы соцсетей, которые поисковики индексируют. Запрос с
 * `site:` находит публичный профиль или пост там, где общий запрос
 * тонет в тёзках. Закрытые профили поисковик не видит — и мы тоже.
 */
export const SOCIAL_SITES = ["vk.com", "ok.ru", "t.me"] as const;

/** Транслитерация как в загранпаспорте РФ (ICAO Doc 9303). */
const ICAO: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "ie", ы: "y",
  ь: "", э: "e", ю: "iu", я: "ia",
};

/** Бытовой вариант, которым люди подписывают профили сами. */
const POPULAR: Readonly<Record<string, string>> = { ...ICAO, й: "y", ъ: "", ю: "yu", я: "ya" };

export function transliterate(value: string, table: Readonly<Record<string, string>> = ICAO): string {
  return [...value.toLocaleLowerCase("ru")]
    .map((char) => table[char] ?? char)
    .join("")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

const PATRONYMIC = /(?:ович|евич|ич|овна|евна|ична|инична)$/iu;

const quote = (value: string): string => `"${value.replace(/"/g, "")}"`;

const capitalize = (value: string): string =>
  value.split(/([\s-])/).map((part) => part.charAt(0).toLocaleUpperCase("ru") + part.slice(1)).join("");

/**
 * Варианты имени человека.
 *
 * «Петров Иван Сергеевич» ищется и так, и «Иван Петров», и «Петров И.С.»,
 * и латиницей — именно в этих формах человек встречается в реестрах,
 * профилях и документах. Отчество распознаётся по окончанию: порядок
 * слов во вводе бывает любым.
 */
export function personNameVariants(normalizedName: string): string[] {
  const tokens = normalizedName.split(" ").filter(Boolean).map(capitalize);
  if (tokens.length < 2) return tokens;
  const patronymicIndex = tokens.findIndex((token, index) => index > 0 && PATRONYMIC.test(token));
  const patronymic = patronymicIndex > 0 ? tokens[patronymicIndex]! : null;
  let first: string;
  let last: string;
  if (patronymic && patronymicIndex === 1) {
    // «Иван Сергеевич Петров»: отчество стоит за именем.
    first = tokens[0]!;
    last = tokens[2] ?? "";
  } else if (patronymic) {
    // «Петров Иван Сергеевич» — порядок документов и реестров.
    last = tokens[0]!;
    first = tokens[1]!;
  } else {
    // Без отчества порядок неизвестен; обратный порядок всё равно
    // попадает в варианты ниже.
    first = tokens[0]!;
    last = tokens[1]!;
  }
  const variants = [
    tokens.join(" "),
    `${first} ${last}`,
    `${last} ${first}`,
    patronymic ? `${last} ${first[0]}.${patronymic[0]}.` : `${last} ${first[0]}.`,
    transliterate(`${first} ${last}`),
    transliterate(`${first} ${last}`, POPULAR),
  ];
  return [...new Set(variants.map((variant) => variant.trim()).filter((variant) => variant.length > 2))];
}

/** Записи телефона, в которых он встречается на страницах. */
export function phoneVariants(e164: string): string[] {
  const phone = parsePhoneNumberFromString(e164);
  if (!phone) return [e164];
  const national = phone.formatNational();
  const digits = phone.nationalNumber;
  const variants = [e164, phone.formatInternational(), national];
  // В России национальная запись уже начинается с восьмёрки; слитно
  // номер пишут в объявлениях: «89123456789».
  if (phone.country === "RU") {
    variants.push(`8${digits}`);
    // «8-912-485-88-18» и «912 485-88-18» — так номер пишут в
    // объявлениях и на страницах контактов.
    const groups = /^(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(digits);
    if (groups) variants.push(`8-${groups.slice(1).join("-")}`, `${groups[1]} ${groups[2]}-${groups[3]}-${groups[4]}`);
  }
  return [...new Set(variants)];
}

/**
 * Поисковые запросы по идентификатору.
 *
 * `context` — город и организация из запроса человека: они сужают
 * поиск по распространённому имени, но не добавляются к каждому
 * варианту, иначе потолок уходит на комбинации.
 */
export function searchQueries(
  identifier: NormalizedIdentifier,
  context: { city?: string; organization?: string } = {},
): string[] {
  let queries: string[];
  switch (identifier.type) {
    case "name": {
      const variants = personNameVariants(identifier.normalized);
      const full = variants[0];
      // «Имя Фамилия» — форма, в которой человек подписан в соцсетях.
      // Первый двухсловный вариант: у полного ФИО это «Иван Петров», у
      // имени без отчества — сам ввод в том порядке, в каком его дали.
      const short = variants.find((variant) => variant.split(" ").length === 2) ?? full;
      queries = [];
      // Уточнение из просьбы человека идёт первым: у распространённого
      // имени без города выдача — чужие люди.
      if (full && context.organization) queries.push(`${quote(full)} ${quote(context.organization)}`);
      if (short && context.city) queries.push(`${quote(short)} ${context.city}`);
      if (full && context.city && full !== short) queries.push(`${quote(full)} ${context.city}`);
      // Открытые страницы соцсетей — сразу после основной формы: редкие
      // формы (инициалы, латиница) при нехватке бюджета отрезаются первыми.
      const [first, ...rest] = variants.map(quote);
      if (first) queries.push(first);
      if (short) {
        const where = context.city ? ` ${context.city}` : "";
        for (const site of SOCIAL_SITES) queries.push(`${quote(short)}${where} site:${site}`);
      }
      queries.push(...rest);
      break;
    }
    case "username":
      queries = [quote(identifier.normalized), `${quote(identifier.normalized)} profile`];
      break;
    case "email": {
      const local = identifier.normalized.split("@")[0] ?? "";
      queries = [quote(identifier.normalized), `${quote(identifier.normalized)} filetype:pdf`];
      // Имя ящика часто совпадает с ником в соцсетях.
      if (local.length >= 4) queries.push(...SOCIAL_SITES.map((site) => `${quote(local)} site:${site}`));
      break;
    }
    case "phone": {
      const variants = phoneVariants(identifier.normalized);
      queries = variants.map(quote);
      // Слитная запись — та, что стоит в объявлениях и на страницах
      // организаций; с ней же ищутся упоминания в соцсетях.
      const compact = variants.find((variant) => /^8\d{10}$/.test(variant)) ?? variants[0];
      if (compact) for (const site of SOCIAL_SITES) queries.push(`${quote(compact)} site:${site}`);
      break;
    }
    case "domain":
      queries = [`site:${identifier.normalized}`, quote(identifier.normalized)];
      break;
    default:
      queries = [quote(identifier.normalized)];
  }
  return [...new Set(queries)].slice(0, MAX_QUERIES_PER_IDENTIFIER);
}
