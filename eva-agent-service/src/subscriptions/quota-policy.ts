/**
 * Ограничение метрики действует одновременно во всех настроенных периодах.
 * Достаточно исчерпать сутки, неделю или месяц — выбирать одну случайную
 * строку нельзя: порядок строк SQL без ORDER BY не определён.
 */
export function quotaExhausted(
  quotas: Array<Record<string, unknown>>,
  metric: string,
): boolean {
  return quotas.some((quota) =>
    quota.metric === metric
    && quota.remaining !== null
    && quota.remaining !== undefined
    && Number(quota.remaining) <= 0
  );
}
