/**
 * Нормализация идентификаторов.
 *
 * Нормализованная форма — единственное, по чему идентификаторы
 * сравниваются и дедуплицируются. Поэтому правило здесь одно:
 * нормализация сводит только разные записи одного и того же значения
 * (`8 (912) 345-67-89` и `+7 912 3456789`), но никогда не склеивает
 * разные значения. Точки и `+метки` в почте Gmail не выбрасываются, и
 * регистр локальной части не меняется: у других провайдеров это разные
 * ящики, и склеить их значит приписать одному человеку чужой адрес.
 *
 * Значение, которое не удалось нормализовать, отвергается (`null`), а не
 * пропускается «как есть»: сырой мусор во frontier превращается в
 * запросы, на которые уходит бюджет исследования.
 */

import net from "node:net";
import { domainToASCII } from "node:url";

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

import { canonicalizeUrl } from "../research/orchestrator.js";
import type { IdentifierType } from "./types.js";

export interface NormalizedIdentifier {
  type: IdentifierType;
  raw: string;
  normalized: string;
}

const MAX_RAW_LENGTH = 2_000;

/** Имя и название: регистр, ё/е, кавычки и пробелы не делают значения разными. */
export function normalizeName(raw: string): string | null {
  const value = raw
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[«»"“”„'`’]/g, "")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length >= 2 && value.length <= 200 ? value : null;
}

/** Username: без `@`, в нижнем регистре, только символы, допустимые у сервисов. */
export function normalizeUsername(raw: string): string | null {
  const value = raw.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_])?$/.test(value) ? value : null;
}

/** Домен: нижний регистр, IDN в punycode, без `www.` и хвостовой точки. */
export function normalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase().replace(/\.$/, "");
  // Вставленный адрес страницы — тоже указание на домен.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = domainToASCII(value.replace(/^www\./, ""));
  if (!value || value.length > 253 || !value.includes(".")) return null;
  const labels = value.split(".");
  const valid = labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const tld = labels.at(-1) ?? "";
  return valid && (/^[a-z]{2,63}$/.test(tld) || tld.startsWith("xn--")) ? value : null;
}

/**
 * Почта: регистр и IDN домена приводятся, локальная часть не трогается.
 *
 * RFC 5321 разрешает провайдеру различать `User@` и `user@`. Без знания
 * провайдера безопасно приводить только домен: склеить два ящика хуже,
 * чем не заметить, что это один.
 */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().replace(/^mailto:/i, "");
  const at = value.lastIndexOf("@");
  if (at <= 0 || at > 64) return null;
  const local = value.slice(0, at);
  const domain = normalizeDomain(value.slice(at + 1));
  if (!domain || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return `${local}@${domain}`;
}

/**
 * Телефон в E.164.
 *
 * Номер без кода страны читается в стране по умолчанию. Номер, который
 * libphonenumber не считает возможным, отвергается: `123` — это не
 * телефон, и искать его по открытым источникам бессмысленно.
 */
export function normalizePhone(raw: string, defaultCountry: CountryCode = "RU"): string | null {
  const phone = parsePhoneNumberFromString(raw.trim(), defaultCountry);
  return phone?.isValid() ? phone.number : null;
}

/** IP-адрес в канонической записи: IPv6 сжатый и в нижнем регистре. */
export function normalizeIp(raw: string): string | null {
  const value = raw.trim().replace(/^\[|\]$/g, "");
  const version = net.isIP(value);
  if (version === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (version === 6) return new URL(`http://[${value}]`).hostname.slice(1, -1);
  return null;
}

/**
 * Сеть: адрес сети с обнулёнными битами хоста.
 *
 * `10.0.0.5/8` и `10.1.2.3/8` — одна сеть, и нормализованная запись у
 * них одна: `10.0.0.0/8`.
 */
export function normalizeCidr(raw: string): string | null {
  const match = /^(.+)\/(\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const address = normalizeIp(match[1]!);
  const prefix = Number(match[2]);
  if (!address) return null;
  const bits = net.isIPv4(address) ? 32 : 128;
  if (prefix < 0 || prefix > bits) return null;
  const value = toBigInt(address);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return `${fromBigInt(value & mask, bits)}/${prefix}`;
}

function toBigInt(address: string): bigint {
  if (net.isIPv4(address)) {
    return address.split(".").reduce((sum, part) => (sum << 8n) + BigInt(Number(part)), 0n);
  }
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return groups.reduce((sum, group) => (sum << 16n) + BigInt(parseInt(group, 16)), 0n);
}

function fromBigInt(value: bigint, bits: number): string {
  if (bits === 32) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
  }
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((value >> shift) & 0xffffn).toString(16));
  return normalizeIp(groups.join(":")) ?? groups.join(":");
}

/** ASN: `AS12345`, `as 12345` и `12345` — один номер. */
export function normalizeAsn(raw: string): string | null {
  const match = /^(?:as\s*)?(\d{1,10})$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 1 && value <= 4_294_967_294 ? `AS${value}` : null;
}

/** Контрольная сумма ИНН: 10 знаков у организации, 12 — у человека. */
export function isValidInn(digits: string): boolean {
  const checksum = (weights: number[]): number =>
    weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11 % 10;
  if (/^\d{10}$/.test(digits)) {
    return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(digits[9]);
  }
  if (/^\d{12}$/.test(digits)) {
    return checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(digits[10])
      && checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(digits[11]);
  }
  return false;
}

/** Контрольная сумма ОГРН (13 знаков) и ОГРНИП (15 знаков). */
export function isValidOgrn(digits: string): boolean {
  if (/^\d{13}$/.test(digits)) {
    return Number(BigInt(digits.slice(0, 12)) % 11n % 10n) === Number(digits[12]);
  }
  if (/^\d{15}$/.test(digits)) {
    return Number(BigInt(digits.slice(0, 14)) % 13n % 10n) === Number(digits[14]);
  }
  return false;
}

/**
 * Налоговый номер.
 *
 * Российский ИНН проверяется контрольной суммой: опечатка в одной цифре —
 * это другой человек или другая компания. Но правило применяется только в
 * российском контексте — при пометке «ИНН» или стране RU: десять цифр
 * бывают и иностранным номером, и отвергать его по чужой контрольной
 * сумме нельзя. Без контекста номер принимается без проверки, как любой
 * иностранный (4–20 знаков).
 */
export function normalizeTaxId(raw: string, country?: CountryCode): string | null {
  const upper = raw.trim().toUpperCase().replace(/[\s.-]/g, "");
  const marked = /^(?:ИНН|INN):?/.test(upper);
  const value = upper.replace(/^(?:ИНН|INN):?/, "");
  if ((marked || country === "RU") && /^\d{10}$|^\d{12}$/.test(value)) {
    return isValidInn(value) ? value : null;
  }
  if (marked) return null;
  return /^[A-Z0-9]{4,20}$/.test(value) ? value : null;
}

/** Регистрационный номер: ОГРН/ОГРНИП с контрольной суммой — в российском контексте. */
export function normalizeRegistrationNumber(raw: string, country?: CountryCode): string | null {
  const upper = raw.trim().toUpperCase().replace(/[\s.-]/g, "");
  const marked = /^(?:ОГРНИП|ОГРН|OGRN):?/.test(upper);
  const value = upper.replace(/^(?:ОГРНИП|ОГРН|OGRN):?/, "");
  if ((marked || country === "RU") && /^\d{13}$|^\d{15}$/.test(value)) {
    return isValidOgrn(value) ? value : null;
  }
  if (marked) return null;
  return /^[A-Z0-9]{4,30}$/.test(value) ? value : null;
}

/**
 * Адреса профилей известных сервисов: хост и форма пути.
 *
 * Профилем считается только ссылка, похожая на профиль: статья на
 * произвольном сайте — это адрес страницы, и обрабатываться она должна
 * как страница. Полный список сайтов придёт с Maigret и WhatsMyName
 * (batch OSINT-2); здесь — сервисы, на которые чаще всего ссылаются.
 */
const PROFILE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["github.com", /^\/[A-Za-z0-9-]+$/],
  ["gitlab.com", /^\/[A-Za-z0-9._-]+$/],
  ["vk.com", /^\/[A-Za-z0-9._]+$/],
  ["t.me", /^\/[A-Za-z0-9_]{4,}$/],
  ["twitter.com", /^\/[A-Za-z0-9_]{1,15}$/],
  ["x.com", /^\/[A-Za-z0-9_]{1,15}$/],
  ["instagram.com", /^\/[A-Za-z0-9._]+$/],
  ["facebook.com", /^\/[A-Za-z0-9.]+$/],
  ["linkedin.com", /^\/in\/[A-Za-z0-9-]+$/],
  ["ok.ru", /^\/profile\/\d+$/],
  ["youtube.com", /^\/@[A-Za-z0-9._-]+$/],
  ["tiktok.com", /^\/@[A-Za-z0-9._]+$/],
  ["medium.com", /^\/@[A-Za-z0-9._-]+$/],
  ["reddit.com", /^\/(?:user|u)\/[A-Za-z0-9_-]+$/],
  ["habr.com", /^\/(?:ru\/)?users\/[A-Za-z0-9_-]+$/],
];

/**
 * Аккаунт в сервисе: канонический адрес профиля или `сервис:имя`.
 *
 * Два способа записи одного профиля — ссылка и пара «сервис + имя» —
 * сводятся к ссылке на уровне сборщика, который знает шаблон адреса
 * сервиса. Здесь пара только приводится к одному виду.
 */
export function normalizeSocialAccount(raw: string): string | null {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    const canonical = canonicalizeUrl(value);
    if (!canonical) return null;
    const url = new URL(canonical);
    const profile = PROFILE_PATTERNS.some(([host, path]) =>
      (url.hostname === host || url.hostname === `m.${host}`) && path.test(url.pathname));
    return profile ? canonical : null;
  }
  const match = /^([a-z0-9.-]{2,40}):@?(.+)$/i.exec(value);
  if (!match) return null;
  const username = normalizeUsername(match[2]!);
  return username ? `${match[1]!.toLowerCase()}:${username}` : null;
}

export function normalizeIdentifier(
  type: IdentifierType,
  raw: string,
  options: {
    /** Страна для номера телефона без кода страны. */
    defaultCountry?: CountryCode;
    /** Страна запроса: включает её правила налоговых и регистрационных номеров. */
    country?: CountryCode;
  } = {},
): NormalizedIdentifier | null {
  if (!raw || raw.length > MAX_RAW_LENGTH) return null;
  let normalized: string | null;
  switch (type) {
    case "name":
    case "organization":
      normalized = normalizeName(raw);
      break;
    case "username":
      normalized = normalizeUsername(raw);
      break;
    case "email":
      normalized = normalizeEmail(raw);
      break;
    case "phone":
      normalized = normalizePhone(raw, options.defaultCountry);
      break;
    case "url":
      normalized = canonicalizeUrl(raw.trim());
      break;
    case "domain":
      normalized = normalizeDomain(raw);
      break;
    case "ip":
      normalized = normalizeIp(raw);
      break;
    case "cidr":
      normalized = normalizeCidr(raw);
      break;
    case "asn":
      normalized = normalizeAsn(raw);
      break;
    case "tax_id":
      normalized = normalizeTaxId(raw, options.country);
      break;
    case "registration_number":
      normalized = normalizeRegistrationNumber(raw, options.country);
      break;
    case "social_account":
      normalized = normalizeSocialAccount(raw);
      break;
    case "document": {
      const value = raw.trim().replace(/\s+/g, " ");
      normalized = /^https?:\/\//i.test(value) ? canonicalizeUrl(value) : value || null;
      break;
    }
  }
  return normalized ? { type, raw, normalized } : null;
}

/**
 * Каким типом может быть запрос человека.
 *
 * Возвращается список, а не один тип: десять цифр бывают и ИНН, и
 * телефоном, и угадывать за человека нельзя. Порядок — от более
 * специфичного к общему; имя — последний вариант, когда ничто другое не
 * подошло.
 */
export function classifyIdentifier(
  raw: string,
  options: { defaultCountry?: CountryCode; country?: CountryCode } = {},
): NormalizedIdentifier[] {
  const value = raw.trim();
  const candidates: IdentifierType[] = [];
  if (/@/.test(value) && !value.startsWith("@")) candidates.push("email");
  if (/^https?:\/\//i.test(value)) candidates.push("social_account", "url");
  if (/\/\d{1,3}$/.test(value)) candidates.push("cidr");
  if (net.isIP(value.replace(/^\[|\]$/g, ""))) candidates.push("ip");
  if (/^as\s*\d+$/i.test(value)) candidates.push("asn");
  const digits = value.replace(/[\s().+-]/g, "");
  if (/^\d{10}$|^\d{12}$/.test(digits)) candidates.push("tax_id");
  if (/^\d{13}$|^\d{15}$/.test(digits)) candidates.push("registration_number");
  if (/^\+?[\d\s().-]{7,20}$/.test(value)) candidates.push("phone");
  // Адрес страницы — это профиль или ссылка, а не домен: домен из него
  // сборщик выделит сам, если понадобится.
  if (!/\s/.test(value) && value.includes(".") && !value.includes("@") && !/^https?:\/\//i.test(value)) {
    candidates.push("domain");
  }
  if (value.startsWith("@") || /^[a-z0-9._-]{3,64}$/i.test(value)) candidates.push("username");
  candidates.push("name");

  const seen = new Set<string>();
  const result: NormalizedIdentifier[] = [];
  for (const type of candidates) {
    const identifier = normalizeIdentifier(type, value, options);
    // URL, который оказался профилем, не дублируется простым адресом.
    const key = identifier ? `${identifier.normalized}` : "";
    if (!identifier || (type === "url" && seen.has(key))) continue;
    // Имя — только когда больше ничего не подошло: «ivan.petrov» — это
    // username, а не человек с именем из одного слова.
    if (type === "name" && result.length > 0) continue;
    seen.add(key);
    result.push(identifier);
  }
  return result;
}
