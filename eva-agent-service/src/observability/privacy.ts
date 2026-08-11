/**
 * Процессор приватности: последнее, через что проходит телеметрия перед
 * выходом наружу.
 *
 * Наблюдаемость соблазнительна тем, что «чуть больше контекста» всегда
 * помогает разбирать инцидент. Именно поэтому граница здесь проведена не
 * по намерению, а по форме: наружу уходит то, что явно разрешено, и
 * ничего больше. Список запрещённых полей был бы гонкой с фантазией
 * разработчика — новое поле `user_note` в него просто не попало бы.
 *
 * Разрешены: идентификаторы версий и моделей, числа, флаги, коды
 * состояний и ошибок, длительности, счётчики токенов и стоимости.
 * Запрещено всё остальное, включая сырые промпты и ответы, память,
 * дневник, документы, аргументы инструментов и reasoning (инвариант 19).
 *
 * Идентификатор пользователя не исчезает, а превращается в псевдоним:
 * HMAC с серверным секретом. Разбор инцидента требует ответа на вопрос
 * «это один и тот же человек или разные», но не требует знать, кто он.
 */

import { createHmac } from "node:crypto";

/** Значение, которое разрешено вынести наружу. */
export type SafeValue = string | number | boolean | null;

export interface PrivacyOptions {
  /** Секрет для псевдонимов. Пустой — псевдонимы не выдаются вовсе. */
  pseudonymSecret: string;
  /** Разрешённые ключи сверх общего списка: например, имена метрик задания. */
  extraAllowedKeys?: readonly string[];
}

/**
 * Ключи, которые разрешены всегда.
 *
 * Список закрытый и короткий. Всё, чего в нём нет, отбрасывается —
 * добавление нового поля в телеметрию должно быть отдельным осознанным
 * решением, а не побочным эффектом рефакторинга.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "trace_id",
  "span_id",
  "correlation_id",
  "causation_id",
  "user_pseudonym",
  "conversation_ref",
  "agent_ref",
  "run_id",
  "job_id",
  "job_type",
  "queue",
  "kind",
  "stage",
  "status",
  "state",
  "from_state",
  "to_state",
  "outcome",
  "reason",
  "error_code",
  "failure_class",
  "attempt",
  "attempts",
  "retry",
  "duration_ms",
  "latency_ms",
  "queued_ms",
  "tokens_input",
  "tokens_output",
  "tokens_total",
  "cost_micros",
  "model",
  "provider",
  "provider_switched",
  "route",
  "route_version",
  "prompt_version",
  "experiment",
  "score",
  "score_name",
  "schema_version",
  "version",
  "count",
  "size",
  "depth",
  "priority",
  "timezone",
  "source",
  "privacy",
  "flag",
  "enabled",
]);

/**
 * Форма безопасного строкового значения: идентификатор, код, версия.
 * Пробелы и переводы строк означают текст, а текст — это содержание.
 */
const SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

/** Что именно отбросили. Нужно тесту приватности и разбору настройки. */
export interface PrivacyReport {
  /** Ключи, выброшенные как неразрешённые. */
  droppedKeys: string[];
  /** Ключи, значение которых не прошло по форме. */
  unsafeValues: string[];
}

export interface SanitizedPayload {
  attributes: Record<string, SafeValue>;
  report: PrivacyReport;
}

export class PrivacyProcessor {
  private readonly allowed: ReadonlySet<string>;

  constructor(private readonly options: PrivacyOptions) {
    this.allowed = options.extraAllowedKeys?.length
      ? new Set([...ALLOWED_KEYS, ...options.extraAllowedKeys])
      : ALLOWED_KEYS;
  }

  /**
   * Псевдоним пользователя.
   *
   * HMAC, а не хэш: без секрета псевдоним нельзя восстановить перебором
   * по диапазону идентификаторов, а диапазон здесь маленький и заранее
   * известный. Без секрета псевдоним не выдаётся вовсе — «стабильный
   * идентификатор без защиты» хуже отсутствия идентификатора.
   */
  pseudonym(userId: number | string | null | undefined): string | null {
    if (userId === null || userId === undefined) return null;
    if (!this.options.pseudonymSecret) return null;
    return createHmac("sha256", this.options.pseudonymSecret)
      .update(String(userId))
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Пропустить набор атрибутов через границу.
   *
   * Неразрешённый ключ и небезопасное значение выбрасываются молча для
   * вызывающего, но попадают в отчёт: тест приватности проверяет именно
   * его, а не догадывается по отсутствию поля.
   */
  sanitize(input: Record<string, unknown>): SanitizedPayload {
    const attributes: Record<string, SafeValue> = {};
    const droppedKeys: string[] = [];
    const unsafeValues: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (!this.allowed.has(key)) {
        droppedKeys.push(key);
        continue;
      }
      if (value === null || value === undefined) {
        attributes[key] = null;
        continue;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          unsafeValues.push(key);
          continue;
        }
        attributes[key] = value;
        continue;
      }
      if (typeof value === "boolean") {
        attributes[key] = value;
        continue;
      }
      if (typeof value === "string" && SAFE_STRING.test(value)) {
        attributes[key] = value;
        continue;
      }
      // Объект, массив, длинная или многословная строка — всё это
      // потенциальное содержание, а не признак.
      unsafeValues.push(key);
    }

    return { attributes, report: { droppedKeys, unsafeValues } };
  }

  /** Разрешён ли ключ. Нужно аудиту телеметрии и тестам. */
  allows(key: string): boolean {
    return this.allowed.has(key);
  }
}

/** Полный список разрешённых ключей. Для аудита и документации. */
export function allowedTelemetryKeys(): string[] {
  return [...ALLOWED_KEYS].sort();
}
