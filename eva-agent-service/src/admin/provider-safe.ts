/**
 * Что из конфигурации провайдера разрешено показывать браузеру.
 *
 * Правило одно и то же в двух местах: `/providers` отдаёт конфигурацию
 * провайдера, `/llm/state` — её же вместе с состоянием роутера. Два
 * независимых списка «безопасных полей» на одну таблицу означали бы, что
 * секрет, забытый в одном, утечёт через второй, и заметить это будет
 * нечем. Поэтому фильтр здесь один.
 *
 * API key не проходит ни при каких условиях: он write-only и наружу
 * возвращается только фактом «настроен».
 */

/**
 * Имя параметра, который может нести секрет.
 *
 * Проверяется имя, а не значение: угадывать «похоже ли это на токен» —
 * гадание, а параметр с таким именем секретом быть обязан.
 */
export const SECRET_FIELD = /(?:api[_-]?key|token|password|secret|authorization|credential)/i;

/** Первый параметр с секретным именем, полным путём. Иначе `null`. */
export function findSecretField(
  value: Record<string, unknown>,
  prefix = "additional_parameters",
): string | null {
  for (const [key, item] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (SECRET_FIELD.test(key)) return path;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = findSecretField(item as Record<string, unknown>, path);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Дополнительные параметры без секретов, на любой глубине.
 *
 * Вложенный объект обходится рекурсивно: секрет, спрятанный в
 * `additional_parameters.headers.authorization`, — это тот же секрет.
 */
export function sanitizeParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (SECRET_FIELD.test(key)) return [];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return [[key, sanitizeParameters(item)]];
      }
      return [[key, item]];
    }),
  );
}
