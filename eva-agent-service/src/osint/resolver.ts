/**
 * Решение «две записи — одна сущность».
 *
 * Модель здесь не решает ничего. Она может предложить пару кандидатов и
 * назвать признаки, но итог выносит этот код по фиксированным весам и
 * порогам — одинаково при каждом повторе, и каждый итог разбирается на
 * признаки с доказательствами. Кандидатов и сравнение имён готовит
 * nomenklatura в osint-worker; сюда приходят уже названные признаки.
 *
 * Три правила, которые важнее любых весов:
 *
 *  1. Совпадение имени никогда не объединяет. Тёзок больше, чем кажется,
 *     и «Иван Петров из Москвы» — это тысячи людей. Без связующего
 *     признака (ссылки, общего адреса почты, телефона, username) пара не
 *     поднимается выше `possible`.
 *  2. Жёсткое противоречие (разный ИНН, разная дата рождения) не
 *     перевешивается суммой совпадений. Есть сильные признаки за — это
 *     `conflicting`, и человек видит обе стороны; нет — `rejected`.
 *  3. Внешность не признак. Сравнение фотографий как биометрия сюда не
 *     входит ни с каким весом.
 */

import type { ResolutionStatus } from "./types.js";

/** Признаки за то, что записи описывают одну сущность. */
export type PositiveFeature =
  | "same_tax_id"
  | "same_registration_number"
  | "profile_link_bidirectional"
  | "profile_link"
  | "shared_email"
  | "shared_phone"
  | "shared_website"
  | "exact_username"
  | "same_birth_date"
  | "name_exact"
  | "name_partial"
  | "same_city"
  | "same_employer"
  | "same_position"
  | "biography_overlap"
  | "shared_connections";

/** Признаки против. */
export type NegativeFeature =
  | "different_tax_id"
  | "different_registration_number"
  | "different_birth_date"
  | "incompatible_age"
  | "different_country"
  | "conflicting_organization"
  | "different_biography";

export type MatchFeatureKind = PositiveFeature | NegativeFeature;

export interface MatchFeature {
  kind: MatchFeatureKind;
  /** Доказательства признака: без них признак не принимается. */
  evidenceIds: readonly string[];
}

export interface MatchDecision {
  status: ResolutionStatus;
  score: number;
  /** Принятые признаки с весами — ответ на вопрос «почему». */
  features: Array<{ kind: MatchFeatureKind; weight: number; evidenceIds: readonly string[] }>;
}

/** Вес признака «за»: вероятность, что он не случаен. */
export const POSITIVE_WEIGHTS: Readonly<Record<PositiveFeature, number>> = {
  same_tax_id: 1,
  same_registration_number: 1,
  profile_link_bidirectional: 0.9,
  profile_link: 0.6,
  shared_email: 0.7,
  shared_phone: 0.7,
  shared_website: 0.5,
  same_birth_date: 0.3,
  exact_username: 0.25,
  name_exact: 0.15,
  same_employer: 0.15,
  same_city: 0.1,
  same_position: 0.1,
  biography_overlap: 0.1,
  shared_connections: 0.1,
  name_partial: 0.05,
};

/** Вес мягкого признака «против»: вычитается из суммы. */
export const SOFT_NEGATIVE_WEIGHTS: Readonly<Partial<Record<NegativeFeature, number>>> = {
  different_country: 0.3,
  conflicting_organization: 0.2,
  different_biography: 0.2,
};

/** Признаки, несовместимые с тождеством. */
const HARD_NEGATIVES = new Set<NegativeFeature>([
  "different_tax_id",
  "different_registration_number",
  "different_birth_date",
  "incompatible_age",
]);

/** Уникальные идентификаторы: совпадение само по себе — тождество. */
const IDENTITY = new Set<MatchFeatureKind>(["same_tax_id", "same_registration_number"]);

/** Сильные связующие признаки. */
const STRONG = new Set<MatchFeatureKind>([
  "profile_link_bidirectional",
  "profile_link",
  "shared_email",
  "shared_phone",
]);

/** Признаки, которые ничего не связывают: имя и окружение. */
const CONTEXT_ONLY = new Set<MatchFeatureKind>([
  "name_exact",
  "name_partial",
  "same_city",
  "same_employer",
  "same_position",
  "biography_overlap",
  "shared_connections",
]);

/** Пороги решения. Меняются только вместе с тестами `osint-core.test.ts`. */
export const MATCH_THRESHOLDS = {
  confirmed: 0.9,
  probable: 0.7,
  possible: 0.3,
} as const;

const isPositive = (kind: MatchFeatureKind): kind is PositiveFeature => kind in POSITIVE_WEIGHTS;

export function decideMatch(input: readonly MatchFeature[]): MatchDecision {
  // Признак без доказательства — это мнение, и в решение он не входит.
  // Повтор одного признака не усиливает его.
  const byKind = new Map<MatchFeatureKind, Set<string>>();
  for (const feature of input) {
    if (feature.evidenceIds.length === 0) continue;
    const ids = byKind.get(feature.kind) ?? new Set<string>();
    for (const id of feature.evidenceIds) ids.add(id);
    byKind.set(feature.kind, ids);
  }
  const features = [...byKind].map(([kind, ids]) => ({
    kind,
    weight: isPositive(kind) ? POSITIVE_WEIGHTS[kind] : -(SOFT_NEGATIVE_WEIGHTS[kind] ?? 1),
    evidenceIds: [...ids],
  }));
  const kinds = new Set(byKind.keys());

  let missed = 1;
  for (const kind of kinds) if (isPositive(kind)) missed *= 1 - POSITIVE_WEIGHTS[kind];
  const positive = 1 - missed;
  let softPenalty = 0;
  for (const kind of kinds) if (!isPositive(kind)) softPenalty += SOFT_NEGATIVE_WEIGHTS[kind] ?? 0;
  const hardNegative = [...kinds].some((kind) => HARD_NEGATIVES.has(kind as NegativeFeature));
  const strongCount = [...kinds].filter((kind) => STRONG.has(kind)).length;
  const identity = [...kinds].some((kind) => IDENTITY.has(kind));
  const linking = [...kinds].some((kind) => isPositive(kind) && !CONTEXT_ONLY.has(kind));
  const score = Math.round(Math.max(0, Math.min(1, positive - softPenalty)) * 1000) / 1000;
  const decide = (status: ResolutionStatus): MatchDecision => ({ status, score, features });

  if (hardNegative) {
    // Сильное «за» при жёстком «против» — это спор, а не отказ: человек
    // должен увидеть обе стороны, а не одну, выбранную кодом.
    return decide(identity || strongCount > 0 || positive >= MATCH_THRESHOLDS.probable
      ? "conflicting"
      : "rejected");
  }
  if (identity) return softPenalty > 0 ? decide("conflicting") : { status: "confirmed", score: 1, features };
  if (softPenalty > 0 && positive >= MATCH_THRESHOLDS.probable) return decide("conflicting");
  if (!linking) return decide(score >= MATCH_THRESHOLDS.possible ? "possible" : "rejected");
  if (
    score >= MATCH_THRESHOLDS.confirmed
    && (strongCount >= 2 || kinds.has("profile_link_bidirectional"))
  ) {
    return decide("confirmed");
  }
  if (score >= MATCH_THRESHOLDS.probable) return decide("probable");
  if (score >= MATCH_THRESHOLDS.possible) return decide("possible");
  return decide("rejected");
}
