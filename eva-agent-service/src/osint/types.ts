/**
 * Канонические типы OSINT-контура.
 *
 * Граница, ради которой файл существует: OSINT — это данные о внешнем
 * мире, добытые детерминированными сборщиками, а не память Евы. Ни один
 * тип отсюда не попадает в memory blocks Letta, и ни одно значение не
 * становится фактом без источника и доказательства.
 *
 * Идентификатор и сущность — разные вещи. `ivan@example.com` — это
 * идентификатор: строка, которую можно нормализовать и искать. Человек,
 * которому он принадлежит, — сущность, и связь между ними сама требует
 * доказательства. Смешать их значит объявить владельцем адреса любого,
 * у кого он встретился.
 */

/** Виды идентификаторов, с которыми работает контур. */
export const IDENTIFIER_TYPES = [
  "name",
  "username",
  "email",
  "phone",
  "url",
  "domain",
  "ip",
  "cidr",
  "asn",
  "organization",
  "tax_id",
  "registration_number",
  "social_account",
  "document",
] as const;

export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

export function isIdentifierType(value: unknown): value is IdentifierType {
  return typeof value === "string" && (IDENTIFIER_TYPES as readonly string[]).includes(value);
}

/**
 * Идентификатор, увиденный в конкретном источнике.
 *
 * `normalized` — форма для сравнения и дедупликации: `+79123456789`,
 * а не `8 (912) 345-67-89`. `raw` сохраняется как увиденный: по нему
 * человек узнаёт, что именно было найдено.
 */
export interface Identifier {
  type: IdentifierType;
  raw: string;
  normalized: string;
  /** Идентификатор источника (`osint_sources.id`) или `seed` для запроса человека. */
  source: string;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Схемы сущностей.
 *
 * Людские и организационные схемы — это схемы FollowTheMoney под своими
 * именами: семантика та же, что у OpenSanctions и Aleph, и граф можно
 * выгрузить в их инструменты без перевода.
 *
 * Инфраструктуры в FollowTheMoney нет: домен, IP-адрес и сеть там —
 * значения свойств, а не сущности. Для них заведены расширения с
 * префиксом `eva:`, чтобы их нельзя было принять за схему FtM. Адрес
 * почты и номер телефона остаются идентификаторами, как и в FtM: схема
 * `Email` у FtM — это письмо, а не адрес.
 */
export const FTM_SCHEMATA = [
  "Person",
  "Organization",
  "Company",
  "LegalEntity",
  "PublicBody",
  "UserAccount",
  "Address",
  "Document",
] as const;

export const EVA_SCHEMATA = ["eva:Website", "eva:Domain", "eva:IPAddress", "eva:Network"] as const;

export type EntitySchema = (typeof FTM_SCHEMATA)[number] | (typeof EVA_SCHEMATA)[number];

/** Связи между сущностями — интервальные схемы FollowTheMoney. */
export const RELATIONSHIP_SCHEMATA = [
  "Ownership",
  "Directorship",
  "Membership",
  "Employment",
  "Family",
  "Associate",
  "Representation",
  "UnknownLink",
] as const;

export type RelationshipSchema = (typeof RELATIONSHIP_SCHEMATA)[number];

export function isEntitySchema(value: unknown): value is EntitySchema {
  return typeof value === "string"
    && ([...FTM_SCHEMATA, ...EVA_SCHEMATA] as readonly string[]).includes(value);
}

/**
 * Состояние решения «это одна и та же сущность».
 *
 * `conflicting` — не «не знаем», а «есть признаки за и прямо против»:
 * такой случай показывается человеку, а не сглаживается.
 */
export type ResolutionStatus = "confirmed" | "probable" | "possible" | "conflicting" | "rejected";

/** Состояние утверждения в отчёте. */
export type ClaimStatus = "confirmed" | "probable" | "unverified" | "contradicted" | "rejected";

/**
 * Уровень источника: от первичного официального до неизвестного.
 *
 * Уровень задаётся видом источника, а не тем, что источник о себе
 * говорит: страница, назвавшая себя «официальной», остаётся тем сайтом,
 * которым её определил сборщик.
 */
export type SourceTier =
  | "official_registry"
  | "official_government"
  | "official_organization"
  | "official_profile"
  | "primary_document"
  | "authoritative_media"
  | "public_repository"
  | "professional_directory"
  | "archive"
  | "forum"
  | "aggregator"
  | "unknown";

/** Чем закончился прогон сборщика. `degraded` — источник частично недоступен. */
export type CollectorStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "degraded"
  | "failed"
  | "skipped"
  | "cancelled";

/** Почему сборщик деградировал: исследование продолжается через другие источники. */
export type DegradedReason = "rate_limited" | "captcha" | "timeout" | "unavailable" | "disabled";

/**
 * Доказательство: цитата со страницы или фрагмент структурированного
 * ответа API. Без него утверждение не сохраняется.
 */
export type Evidence =
  | { kind: "quote"; quote: string; hash: string }
  | { kind: "structured"; data: unknown; hash: string };

/**
 * Утверждение о свойстве сущности.
 *
 * `property` — имя свойства FollowTheMoney (`birthDate`, `innCode`,
 * `email`), чтобы утверждение читалось одинаково в Еве и в Aleph.
 */
export interface Claim {
  entityId: string;
  property: string;
  value: string;
  sourceId: string;
  sourceTier: SourceTier;
  /** Домен источника: независимость подтверждений считается по нему. */
  sourceDomain: string;
  collector: string;
  retrievedAt: string;
  evidence: Evidence;
}

/** Предел одного исследования. Бесконечного расширения графа не бывает. */
export interface InvestigationBudget {
  maxDepth: number;
  maxEntities: number;
  maxIdentifiers: number;
  maxExternalRequests: number;
  maxRuntimeMs: number;
  /** Верхняя граница платных вызовов в центах; базовый режим работает при нуле. */
  maxCostCents: number;
}

export const DEFAULT_BUDGET: InvestigationBudget = {
  maxDepth: 2,
  maxEntities: 50,
  maxIdentifiers: 100,
  maxExternalRequests: 200,
  maxRuntimeMs: 15 * 60_000,
  maxCostCents: 0,
};

/**
 * Уточнение из просьбы человека: город и место работы. Сужает поиск по
 * распространённому имени; сам по себе идентификатором не является и в
 * граф не попадает.
 */
export interface SearchContext {
  city?: string;
  organization?: string;
}
