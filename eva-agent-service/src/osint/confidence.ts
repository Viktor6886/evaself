/**
 * Качество источников и уверенность в утверждениях.
 *
 * Уверенность здесь считает детерминированный код, а не модель: одно и
 * то же множество доказательств даёт одно и то же число при любом
 * повторе. Правила подобраны так, чтобы ни одно утверждение не стало
 * подтверждённым только потому, что его повторили много слабых
 * источников: перепечатка одной страницы двадцатью агрегаторами —
 * это одно свидетельство, а не двадцать.
 */

import type { Claim, ClaimStatus, SourceTier } from "./types.js";

/** Базовая надёжность уровня источника. */
export const SOURCE_TIER_QUALITY: Readonly<Record<SourceTier, number>> = {
  official_registry: 0.95,
  official_government: 0.9,
  official_organization: 0.85,
  official_profile: 0.8,
  primary_document: 0.8,
  authoritative_media: 0.65,
  public_repository: 0.6,
  professional_directory: 0.55,
  archive: 0.5,
  forum: 0.3,
  aggregator: 0.25,
  unknown: 0.2,
};

/** Уровни, одного свидетельства которых достаточно для подтверждения. */
const PRIMARY_TIERS = new Set<SourceTier>([
  "official_registry",
  "official_government",
  "official_organization",
  "official_profile",
  "primary_document",
]);

/** Пороги статуса. Меняются только вместе с тестами `osint-core.test.ts`. */
export const CLAIM_THRESHOLDS = {
  confirmed: 0.85,
  probable: 0.6,
} as const;

/**
 * Уверенность в одном значении свойства.
 *
 * Свидетельства группируются по домену источника: независимым считается
 * только другой домен. Внутри домена берётся лучшее свидетельство, между
 * доменами уверенность складывается как вероятность «ошиблись все
 * сразу» (noisy-OR). Так два независимых первичных источника дают почти
 * единицу, а десять форумов не поднимаются выше того, что может дать
 * форум.
 */
export function claimConfidence(claims: readonly Pick<Claim, "sourceTier" | "sourceDomain">[]): number {
  const bestByDomain = new Map<string, number>();
  for (const claim of claims) {
    const quality = SOURCE_TIER_QUALITY[claim.sourceTier];
    const domain = claim.sourceDomain.toLowerCase();
    bestByDomain.set(domain, Math.max(bestByDomain.get(domain) ?? 0, quality));
  }
  if (bestByDomain.size === 0) return 0;
  let missed = 1;
  for (const quality of bestByDomain.values()) missed *= 1 - quality;
  const combined = 1 - missed;
  // Потолок задаёт лучший уровень: слабые источники в любом количестве
  // не выводят утверждение в «подтверждено».
  const best = Math.max(...bestByDomain.values());
  const ceiling = best >= SOURCE_TIER_QUALITY.primary_document ? 1 : Math.min(0.8, best + 0.25);
  return Math.round(Math.min(combined, ceiling) * 1000) / 1000;
}

/**
 * Статус утверждения.
 *
 * Подтверждённым утверждение становится только при первичном источнике
 * среди свидетельств: высокая сумма вторичных — это «вероятно», а не
 * «установлено». Противоречие перекрывает всё: утверждение, у которого
 * есть несовместимое значение из другого источника, показывается как
 * спорное, а не выбирается «победитель».
 */
export function claimStatus(
  claims: readonly Pick<Claim, "sourceTier" | "sourceDomain">[],
  contradicted: boolean,
): ClaimStatus {
  if (contradicted) return "contradicted";
  const confidence = claimConfidence(claims);
  const hasPrimary = claims.some((claim) => PRIMARY_TIERS.has(claim.sourceTier));
  if (hasPrimary && confidence >= CLAIM_THRESHOLDS.confirmed) return "confirmed";
  if (confidence >= CLAIM_THRESHOLDS.probable) return "probable";
  return "unverified";
}
