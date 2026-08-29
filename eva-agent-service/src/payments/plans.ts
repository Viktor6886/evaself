/** Порядок платных тарифов. Чем больше число, тем выше доступ. */
export const PAID_PLAN_LEVEL: Readonly<Record<string, number>> = Object.freeze({
  plus: 1,
  max: 2,
});

export function paidPlanLevel(plan: string): number | null {
  const level = PAID_PLAN_LEVEL[plan];
  return level !== undefined && Number.isSafeInteger(level) ? level : null;
}

export function isPaidPlan(plan: string): boolean {
  return paidPlanLevel(plan) !== null;
}
