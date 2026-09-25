/**
 * Противоречия между источниками.
 *
 * Противоречие не разрешается выбором «самого надёжного» значения: оно
 * сохраняется и показывается. Один источник пишет «Пермь», другой
 * «Москва» — отчёт обязан сказать именно это, а не молча выбрать город.
 *
 * Противоречием считается только разногласие в свойстве, у которого
 * значение одно: дата рождения, пол, ИНН. У человека может быть много
 * адресов, почт и работодателей, и второе значение там — дополнение, а
 * не спор. Даты разной точности согласуются: «1990» не спорит с
 * «1990-05-01».
 */

import type { Claim } from "./types.js";

/** Свойства FollowTheMoney с единственным значением у сущности. */
export const EXCLUSIVE_PROPERTIES = new Set([
  "birthDate",
  "birthPlace",
  "deathDate",
  "gender",
  "incorporationDate",
  "dissolutionDate",
  "innCode",
  "ogrnCode",
  "kppCode",
  "jurisdiction",
]);

const DATE_PROPERTIES = new Set(["birthDate", "deathDate", "incorporationDate", "dissolutionDate"]);

export interface Contradiction {
  entityId: string;
  property: string;
  /** Несовместимые значения и источники, которые за каждым стоят. */
  values: Array<{ value: string; sourceIds: string[] }>;
}

function comparable(property: string, value: string): string {
  const normalized = value.trim().toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ");
  return DATE_PROPERTIES.has(property) ? normalized.replace(/[^\d-]/g, "") : normalized;
}

/** Совместимы ли два значения: даты — если одна уточняет другую. */
function compatible(property: string, left: string, right: string): boolean {
  if (left === right) return true;
  if (!DATE_PROPERTIES.has(property)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function findContradictions(
  claims: readonly Pick<Claim, "entityId" | "property" | "value" | "sourceId">[],
): Contradiction[] {
  const groups = new Map<string, Map<string, Set<string>>>();
  for (const claim of claims) {
    if (!EXCLUSIVE_PROPERTIES.has(claim.property)) continue;
    const key = `${claim.entityId}\u0000${claim.property}`;
    const values = groups.get(key) ?? new Map<string, Set<string>>();
    const value = comparable(claim.property, claim.value);
    if (!value) continue;
    const sources = values.get(value) ?? new Set<string>();
    sources.add(claim.sourceId);
    values.set(value, sources);
    groups.set(key, values);
  }

  const result: Contradiction[] = [];
  for (const [key, values] of groups) {
    const [entityId = "", property = ""] = key.split("\u0000");
    const distinct = [...values.keys()];
    const conflicting = distinct.some((left, index) =>
      distinct.slice(index + 1).some((right) => !compatible(property, left, right)));
    if (!conflicting) continue;
    result.push({
      entityId,
      property,
      values: distinct.map((value) => ({ value, sourceIds: [...values.get(value)!] })),
    });
  }
  return result;
}
