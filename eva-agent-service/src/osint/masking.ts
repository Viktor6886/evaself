/**
 * Маскирование идентификаторов для журналов и метрик.
 *
 * OSINT почти целиком состоит из персональных данных третьих лиц, и в
 * журнал они не попадают ни целиком, ни «для отладки». Маска оставляет
 * ровно столько, чтобы оператор различил две записи в одном разборе:
 * `i***@e***.com`, `+7******89`. Для сопоставления между журналами есть
 * псевдоним — HMAC с секретом установки: одинаковый для одного значения
 * и бесполезный без секрета.
 */

import { createHmac } from "node:crypto";

import type { IdentifierType } from "./types.js";

/**
 * Звёздочек всегда три: их число по длине значения выдавало бы длину
 * имени или ящика — ещё один признак для сопоставления.
 */
const keep = (value: string, head: number, tail = 0): string => {
  if (value.length <= head + tail + 1) return "***";
  return `${value.slice(0, head)}***${tail ? value.slice(-tail) : ""}`;
};

export function maskIdentifier(type: IdentifierType, value: string): string {
  switch (type) {
    case "email": {
      const at = value.lastIndexOf("@");
      if (at < 0) return keep(value, 1);
      const domain = value.slice(at + 1);
      const dot = domain.lastIndexOf(".");
      const tld = dot >= 0 ? domain.slice(dot) : "";
      return `${keep(value.slice(0, at), 1)}@${keep(dot >= 0 ? domain.slice(0, dot) : domain, 1)}${tld}`;
    }
    case "phone":
      return keep(value, 2, 2);
    case "ip":
    case "cidr":
    case "asn":
    case "domain":
    case "url":
      // Инфраструктура не персональна сама по себе, но и она попадает
      // в журнал только под маской: адрес бывает домашним.
      return keep(value, Math.min(4, Math.floor(value.length / 3)));
    default:
      return keep(value, 1);
  }
}

/** Псевдоним значения: стабильный внутри установки, необратимый без секрета. */
export function pseudonymize(secret: string, type: IdentifierType, normalized: string): string {
  if (!secret) throw new Error("osint_pseudonym_secret_missing");
  return createHmac("sha256", secret).update(`${type}\u0000${normalized}`).digest("hex").slice(0, 16);
}
