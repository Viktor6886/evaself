/**
 * Общие правила фоновых заданий: классификация отказов, сроки и
 * дедупликация.
 *
 * Три класса отказа, а не два. «Временный» и «постоянный» покрывают
 * почти всё, но не самый опасный случай: внешняя запись, ответ на
 * которую не получен. Провайдер мог принять платёж и не ответить, мог не
 * принять вовсе — с точки зрения кода это одно и то же событие. Повторять
 * такую запись нельзя (получится второе списание), считать её отказом
 * тоже нельзя (деньги ушли). Поэтому у неё отдельный класс:
 * `indeterminate` не повторяется автоматически и требует сверки.
 *
 * Сроки заданы четырьмя числами, а не одним таймаутом. Мягкий срок —
 * когда пора сворачиваться самому; жёсткий дедлайн — после него работа
 * запрещена; таймаут внешнего запроса — сколько ждём чужой сервис;
 * аренда и интервал её продления — как долго задание считается живым
 * без признаков жизни.
 */

import type { JobQueueName } from "./queue-registry.js";

export type JobFailureClass = "transient" | "permanent" | "indeterminate";

/**
 * Внешняя запись с неизвестным исходом. Бросается явно тем кодом,
 * который знает, что запрос уже ушёл: угадать это по типу ошибки
 * невозможно, а разница между «не отправили» и «не узнали ответ»
 * решающая.
 */
export class IndeterminateExternalWrite extends Error {
  readonly failureClass: JobFailureClass = "indeterminate";

  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "IndeterminateExternalWrite";
  }
}

/** Отказ, который повторять бессмысленно: данные не изменятся сами. */
export class PermanentJobFailure extends Error {
  readonly failureClass: JobFailureClass = "permanent";

  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PermanentJobFailure";
  }
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export interface JobFailure {
  failureClass: JobFailureClass;
  /** Безопасный код: имя ошибки или её `code`, но не текст сообщения. */
  code: string;
}

/**
 * Классифицировать отказ.
 *
 * Текст ошибки в код не попадает: сообщение внешнего сервиса может
 * содержать переданные ему данные, а код отказа хранится в PostgreSQL
 * открытым и уходит в метрики.
 */
export function classifyJobError(error: unknown): JobFailure {
  if (error instanceof IndeterminateExternalWrite) {
    return { failureClass: "indeterminate", code: error.code };
  }
  if (error instanceof PermanentJobFailure) {
    return { failureClass: "permanent", code: error.code };
  }
  // Отказ конверта и любой другой объект, объявивший себя неповторяемым.
  const retryable = (error as { retryable?: unknown } | null)?.retryable;
  const declared = (error as { code?: unknown } | null)?.code;
  const code = typeof declared === "string" && declared
    ? declared
    : error instanceof Error
      ? error.name
      : "unknown_error";
  if (retryable === false) return { failureClass: "permanent", code };
  if (error instanceof Error && error.name === "AbortError") {
    // Прерывание — наше собственное решение (истёк срок, потеряна
    // аренда, пришла отмена). Работа не выполнена и может быть
    // выполнена позже.
    return { failureClass: "transient", code: "aborted" };
  }
  if (TRANSIENT_CODES.has(code)) return { failureClass: "transient", code };
  // Неизвестный отказ считается временным: не повторить выполнимое хуже,
  // чем повторить невыполнимое, — второе ограничено числом попыток.
  return { failureClass: "transient", code };
}

export interface JobTimingPolicy {
  /** Пора сворачиваться самому и вернуть частичный результат. */
  softTimeoutMs: number;
  /** После этого срока работа запрещена, даже начатая. */
  hardDeadlineMs: number;
  /** Сколько ждём ответа внешнего сервиса. */
  externalRequestTimeoutMs: number;
  /** Сколько задание считается живым без продления. */
  leaseDurationMs: number;
  /** Как часто продлевается аренда. */
  leaseRenewIntervalMs: number;
  /** Сколько раз повторяется временный отказ. */
  maxAttempts: number;
  /** Базовая задержка экспоненциального повтора. */
  backoffMs: number;
}

/**
 * Сроки по классам очередей. Числа отличаются по природе работы:
 * research ходит наружу и живёт минутами, maintenance молотит базу,
 * proactive обязан либо сработать вовремя, либо не сработать вовсе.
 */
export const QUEUE_TIMING: Readonly<Record<JobQueueName, JobTimingPolicy>> = {
  memory: {
    softTimeoutMs: 20_000,
    hardDeadlineMs: 120_000,
    externalRequestTimeoutMs: 15_000,
    leaseDurationMs: 60_000,
    leaseRenewIntervalMs: 15_000,
    maxAttempts: 5,
    backoffMs: 2_000,
  },
  research: {
    softTimeoutMs: 120_000,
    hardDeadlineMs: 600_000,
    externalRequestTimeoutMs: 45_000,
    leaseDurationMs: 120_000,
    leaseRenewIntervalMs: 30_000,
    maxAttempts: 3,
    backoffMs: 10_000,
  },
  proactive: {
    softTimeoutMs: 15_000,
    hardDeadlineMs: 60_000,
    externalRequestTimeoutMs: 10_000,
    leaseDurationMs: 45_000,
    leaseRenewIntervalMs: 10_000,
    maxAttempts: 3,
    backoffMs: 5_000,
  },
  recovery: {
    softTimeoutMs: 30_000,
    hardDeadlineMs: 180_000,
    externalRequestTimeoutMs: 15_000,
    leaseDurationMs: 60_000,
    leaseRenewIntervalMs: 15_000,
    maxAttempts: 5,
    backoffMs: 3_000,
  },
  evaluation: {
    softTimeoutMs: 60_000,
    hardDeadlineMs: 300_000,
    externalRequestTimeoutMs: 30_000,
    leaseDurationMs: 90_000,
    leaseRenewIntervalMs: 20_000,
    maxAttempts: 2,
    backoffMs: 15_000,
  },
  maintenance: {
    softTimeoutMs: 120_000,
    hardDeadlineMs: 900_000,
    externalRequestTimeoutMs: 30_000,
    leaseDurationMs: 180_000,
    leaseRenewIntervalMs: 45_000,
    maxAttempts: 3,
    backoffMs: 30_000,
  },
};

export class JobPolicyError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "JobPolicyError";
  }
}

/**
 * Сроки для типа задания: умолчание класса плюс поправки типа.
 *
 * Соотношения проверяются, а не подразумеваются: продление реже
 * половины аренды означает, что аренда истечёт между двумя продлениями,
 * и задание будет считаться потерянным, продолжая выполняться.
 */
export function timingFor(
  queue: JobQueueName,
  overrides: Partial<JobTimingPolicy> = {},
): JobTimingPolicy {
  const policy = { ...QUEUE_TIMING[queue], ...overrides };
  if (policy.softTimeoutMs >= policy.hardDeadlineMs) {
    throw new JobPolicyError("job_timing_invalid", "мягкий срок не раньше жёсткого дедлайна");
  }
  if (policy.externalRequestTimeoutMs > policy.softTimeoutMs) {
    throw new JobPolicyError("job_timing_invalid", "внешний запрос длиннее мягкого срока");
  }
  if (policy.leaseRenewIntervalMs * 2 > policy.leaseDurationMs) {
    throw new JobPolicyError("job_timing_invalid", "продление реже половины аренды");
  }
  return policy;
}

export type DedupMode = "simple" | "throttle" | "debounce" | "keep_last_if_active";

/** Закрытый список режимов. Один на весь слой: конверт, расписание и публикатор сверяются с ним. */
export const DEDUP_MODES: ReadonlySet<string> = new Set<DedupMode>([
  "simple",
  "throttle",
  "debounce",
  "keep_last_if_active",
]);

export interface DedupInput {
  mode: DedupMode;
  queue: JobQueueName;
  type: string;
  /** Арендатор. Ключ без него склеил бы задания разных людей. */
  userId: number | null;
  /** Что различает два задания одного типа у одного человека. */
  discriminator?: string | null;
  /** Окно throttle. Обязательно именно для него. */
  windowMs?: number;
  now?: number;
}

/**
 * Ключ дедупликации.
 *
 * Арендатор входит в ключ всегда: задание «пересчитать память» у двух
 * людей — это два разных задания, и общий ключ означал бы, что второму
 * человеку работа не досталась. Для системных заданий без владельца в
 * ключ идёт `system`.
 *
 * Режимы отличаются только тем, что попадает в ключ:
 *   simple             — тип и различитель; повтор считается тем же заданием;
 *   throttle           — плюс номер окна: одно задание на окно;
 *   debounce           — как simple, но публикатор снимает предыдущее ожидающее;
 *   keep_last_if_active — как simple; выполняющееся не трогаем, ожидающее заменяем.
 */
export function dedupKey(input: DedupInput): string {
  const tenant = input.userId === null ? "system" : `u${input.userId}`;
  const parts = [input.queue, input.type, tenant, input.discriminator ?? "-"];
  if (input.mode === "throttle") {
    const window = input.windowMs ?? 0;
    if (window <= 0) {
      throw new JobPolicyError("job_dedup_window_required", "throttle без окна");
    }
    parts.push(`w${Math.floor((input.now ?? Date.now()) / window)}`);
  }
  return parts.join(":");
}

/** Заменяет ли режим ранее поставленное ожидающее задание. */
export function replacesPending(mode: DedupMode): boolean {
  return mode === "debounce" || mode === "keep_last_if_active";
}
