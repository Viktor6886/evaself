/**
 * Перевод ответов osint-worker в понятия домена OSINT.
 *
 * Здесь ничего не решается о тождестве. Признаки nomenklatura переводятся
 * в признаки `resolver.ts` по фиксированным порогам, и итог выносит
 * resolver. Находки Maigret и проверки WhatsMyName/Sherlock сводятся в
 * наблюдения профиля: кто подтвердил, кто опроверг, кто не смог
 * проверить. Уверенность потом считается по этим подтверждениям, а не
 * по одному «так сказал Maigret».
 */

import { canonicalizeUrl } from "../research/orchestrator.js";
import { normalizeIdentifier, type NormalizedIdentifier } from "./identifiers.js";
import type { MatchFeature, MatchFeatureKind } from "./resolver.js";
import type { WorkerComparison, WorkerScanResult, WorkerVerification } from "./worker-client.js";

/** Имя считается совпавшим полностью с этого балла name_match. */
export const NAME_EXACT_SCORE = 0.95;
/** Частичное совпадение имени: ниже этого балла имя не признак. */
export const NAME_PARTIAL_SCORE = 0.7;

/**
 * Признаки resolver из признаков nomenklatura.
 *
 * `evidenceIds` — доказательство самого сравнения (structured evidence с
 * ответом воркера): resolver без доказательств признак не принимает.
 * Признаки, у которых в resolver нет пары (identifier_match вообще,
 * gender_mismatch), не переводятся: общий «какой-то номер совпал» не
 * равен совпадению ИНН.
 */
export function comparisonToFeatures(
  comparison: WorkerComparison,
  evidenceIds: readonly string[],
): MatchFeature[] {
  if (evidenceIds.length === 0) return [];
  const kinds = new Set<MatchFeatureKind>();
  for (const feature of comparison.features) {
    const score = feature.score;
    switch (feature.name) {
      case "name_match":
        if (score >= NAME_EXACT_SCORE) kinds.add("name_exact");
        else if (score >= NAME_PARTIAL_SCORE) kinds.add("name_partial");
        break;
      case "inn_code_match":
        if (score >= 1) kinds.add("same_tax_id");
        break;
      case "ogrn_code_match":
        if (score >= 1) kinds.add("same_registration_number");
        break;
      case "dob_year_disjoint":
      case "dob_day_disjoint":
        if (score > 0) kinds.add("different_birth_date");
        break;
      case "country_mismatch":
        if (score > 0) kinds.add("different_country");
        break;
    }
  }
  return [...kinds].map((kind) => ({ kind, evidenceIds: [...evidenceIds] }));
}

export type ProfileCollector = "maigret" | "whatsmyname" | "sherlock";

/** Профиль, найденный по username, с независимыми подтверждениями. */
export interface ProfileObservation {
  site: string;
  /** Канонический адрес профиля. */
  url: string;
  host: string;
  confirmedBy: ProfileCollector[];
  /** Сборщик ответил «аккаунта нет» — противоречие, а не повод удалить находку. */
  contradictedBy: ProfileCollector[];
  /** Сборщик не смог проверить (капча, лимит, таймаут). */
  unverifiedBy: ProfileCollector[];
  tags: string[];
}

export interface ScanObservations {
  profiles: ProfileObservation[];
  /** Новые идентификаторы для следующей итерации: username, адреса. */
  discovered: NormalizedIdentifier[];
}

function hostOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

function add(list: ProfileCollector[], collector: ProfileCollector): void {
  if (!list.includes(collector)) list.push(collector);
}

/**
 * Свести скан Maigret и проверки WhatsMyName/Sherlock.
 *
 * Профили сопоставляются по хосту: адрес проверки у наборов правил может
 * отличаться от адреса профиля (API против страницы), а сайт один.
 * Проверка без находки Maigret профилем не становится: её дело —
 * подтверждать или опровергать.
 */
export function mergeProfileObservations(
  scan: WorkerScanResult,
  verifications: readonly WorkerVerification[] = [],
): ScanObservations {
  const profiles = new Map<string, ProfileObservation>();
  const seen = new Set<string>();
  const discovered: NormalizedIdentifier[] = [];

  const discover = (identifier: NormalizedIdentifier | null) => {
    if (!identifier) return;
    const key = `${identifier.type}\u0000${identifier.normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    discovered.push(identifier);
  };

  for (const found of scan.found) {
    const url = canonicalizeUrl(found.url);
    if (!url) continue;
    const host = hostOf(url);
    const existing = profiles.get(host);
    if (existing) {
      for (const tag of found.tags) if (!existing.tags.includes(tag)) existing.tags.push(tag);
    } else {
      profiles.set(host, {
        site: found.site,
        url,
        host,
        confirmedBy: ["maigret"],
        contradictedBy: [],
        unverifiedBy: [],
        tags: [...found.tags].sort(),
      });
    }
    for (const username of found.discoveredUsernames) {
      if (username !== scan.username) discover(normalizeIdentifier("username", username));
    }
    for (const link of found.discoveredLinks) {
      discover(normalizeIdentifier("social_account", link) ?? normalizeIdentifier("url", link));
    }
  }

  for (const verification of verifications) {
    const url = canonicalizeUrl(verification.profileUrl);
    if (!url) continue;
    const profile = profiles.get(hostOf(url));
    if (!profile) continue;
    if (verification.status === "found") add(profile.confirmedBy, verification.source);
    else if (verification.status === "not_found") add(profile.contradictedBy, verification.source);
    else if (verification.status === "degraded" || verification.status === "unknown") {
      add(profile.unverifiedBy, verification.source);
    }
  }

  // Адрес найденного профиля — тоже идентификатор, но его уже знает
  // наблюдение; в `discovered` попадает только новое.
  const known = new Set([...profiles.values()].map((profile) => profile.url));
  return {
    profiles: [...profiles.values()].sort((a, b) => a.host.localeCompare(b.host)),
    discovered: discovered.filter((identifier) => !known.has(identifier.normalized)),
  };
}
