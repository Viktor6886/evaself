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

/**
 * Возвращает минимальный остаток метрики среди всех конечных периодов.
 * null означает, что для метрики нет конечного лимита.
 */
export function quotaRemaining(
  quotas: Array<Record<string, unknown>>,
  metric: string,
): number | null {
  const finite = quotas
    .filter((quota) =>
      quota.metric === metric
      && quota.remaining !== null
      && quota.remaining !== undefined
    )
    .map((quota) => Number(quota.remaining))
    .filter((remaining) => Number.isFinite(remaining));
  if (finite.length === 0) return null;
  return Math.max(0, Math.min(...finite));
}

/**
 * Проверяет, помещается ли атомарный расход в каждое действующее окно
 * квоты. Нужен агрегированному Telegram-ходу: пакет нельзя пропускать
 * целиком, если его размер уже больше остатка хотя бы одного периода.
 */
export function quotaAllowsAmount(
  quotas: Array<Record<string, unknown>>,
  metric: string,
  amount: number,
): boolean {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("amount квоты должен быть положительным целым");
  }
  const remaining = quotaRemaining(quotas, metric);
  return remaining === null || remaining >= amount;
}
