/**
 * Конверт фонового задания.
 *
 * Задание проходит через Valkey, а Valkey — восстановимое операционное
 * состояние (инвариант 2) и не место для пользовательских данных
 * (раздел «Безопасность»). Отсюда главное свойство конверта: в нём есть
 * всё, чтобы найти работу, и нет ничего, чтобы её пересказать. Тексты
 * сообщений, дневник, память, транскрипции, ключи и платёжные данные
 * заменяются идентификаторами и ссылкой на payload в PostgreSQL.
 *
 * Проверка не рекомендательная: `assertSafePayload` отказывает, а не
 * предупреждает. Предупреждение здесь означало бы, что первый же
 * невнимательный вызов кладёт цитату разговора в общий брокер, и узнать
 * об этом можно будет только из журнала.
 *
 * Версия схемы — обязательное поле, а не удобство. Задание живёт в
 * очереди дольше, чем деплой: при выкатке новой версии в очереди лежат
 * конверты старой. Неизвестная версия — безопасный неповторяемый отказ:
 * повторять её бессмысленно, а угадывать содержание опасно.
 */

import { createHash } from "node:crypto";

import type { JobQueueName } from "./queue-registry.js";

/** Версия конверта, которую пишет текущий код. */
export const JOB_SCHEMA_VERSION = 1;

/** Версии, которые текущий код умеет читать. */
export const SUPPORTED_JOB_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Откуда пришло намерение. Влияет на разбор, а не на выполнение. */
export type JobSource = "system" | "schedule" | "user" | "admin" | "recovery";

/**
 * Режим приватности задания. `restricted` — работа, при которой
 * исполнителю нельзя расширять контекст и логировать даже безопасные
 * поля payload.
 */
export type JobPrivacyMode = "standard" | "restricted";

/** Что разрешено класть в payload: идентификаторы, флаги и счётчики. */
export type JobScalar = string | number | boolean | null;

export interface JobEnvelope {
  schemaVersion: number;
  type: string;
  queue: JobQueueName;
  userId: number | null;
  conversationId: string | null;
  agentId: string | null;
  traceId: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  /** Ссылка на полный payload в PostgreSQL, если он есть. */
  payloadRef: string | null;
  /** Минимальный безопасный payload: только идентификаторы и флаги. */
  payload: Record<string, JobScalar>;
  createdAt: string;
  /** Жёсткий дедлайн: после него задание выполнять нельзя. */
  deadlineAt: string;
  timezone: string;
  source: JobSource;
  privacy: JobPrivacyMode;
}

/**
 * Отказ конверта. Всегда неповторяемый: испорченный или незнакомый
 * конверт от повтора не исправится, а повтор превратится в бесконечный
 * цикл — задание вернётся, снова не разберётся и снова вернётся.
 */
export class JobEnvelopeError extends Error {
  readonly retryable = false;

  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "JobEnvelopeError";
  }
}

/**
 * Имена полей, запрещённые в payload независимо от содержимого.
 *
 * Ключ проверяется по вхождению подстроки: `message_text`, `raw_message`
 * и `messageText` одинаково запрещены. Список закрывает то, что чаще
 * всего пытаются «на минутку» протащить через очередь.
 */
const FORBIDDEN_PAYLOAD_KEYS = [
  "text",
  "message",
  "content",
  "body",
  "prompt",
  "answer",
  "reply",
  "transcript",
  "transcription",
  "diary",
  "journal",
  "note",
  "memory",
  "summary",
  "reasoning",
  "secret",
  "token",
  "password",
  "apikey",
  "api_key",
  "credential",
  "card",
  "pan",
  "cvv",
  "iban",
  "phone",
  "email",
  "address",
  "media",
  "file",
  "photo",
  "voice",
  "audio",
  "video",
  "attachment",
  "url",
  "link",
];

/** Идентификатор: uuid, число, короткий slug. Всё остальное — не идентификатор. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

const KEY_SHAPE = /^[a-z][a-z0-9_]*$/;

/** Сколько полей помещается в «минимальный безопасный payload». */
const MAX_PAYLOAD_KEYS = 16;

function forbiddenKey(key: string): string | null {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  for (const forbidden of FORBIDDEN_PAYLOAD_KEYS) {
    if (normalized.includes(forbidden.replace(/[^a-z]/g, ""))) return forbidden;
  }
  return null;
}

/**
 * Проверить payload на пригодность к отправке в Valkey.
 *
 * Строка допускается только в форме идентификатора: без пробелов, без
 * переводов строк и не длиннее 64 знаков. Это грубее любой семантической
 * проверки и именно поэтому надёжнее — фраза человека не проходит по
 * форме, а не по догадке о смысле.
 */
export function assertSafePayload(payload: Record<string, unknown>): void {
  const entries = Object.entries(payload);
  if (entries.length > MAX_PAYLOAD_KEYS) {
    throw new JobEnvelopeError(
      "job_payload_too_large",
      `полей ${entries.length}, допустимо ${MAX_PAYLOAD_KEYS}`,
    );
  }
  for (const [key, value] of entries) {
    if (!KEY_SHAPE.test(key)) {
      throw new JobEnvelopeError("job_payload_key_invalid", key);
    }
    const forbidden = forbiddenKey(key);
    if (forbidden) {
      throw new JobEnvelopeError("job_payload_forbidden_field", key);
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new JobEnvelopeError("job_payload_value_invalid", key);
      }
      continue;
    }
    if (typeof value === "string") {
      if (!IDENTIFIER.test(value)) {
        throw new JobEnvelopeError("job_payload_value_not_identifier", key);
      }
      continue;
    }
    // Объект или массив — это уже структура, а структура рано или поздно
    // окажется куском переписки. Ссылка на строку PostgreSQL решает ту
    // же задачу и не выносит содержимое наружу.
    throw new JobEnvelopeError("job_payload_value_not_scalar", key);
  }
}

export interface JobEnvelopeInput {
  type: string;
  queue: JobQueueName;
  idempotencyKey: string;
  traceId: string;
  correlationId?: string;
  causationId?: string | null;
  userId?: number | null;
  conversationId?: string | null;
  agentId?: string | null;
  payloadRef?: string | null;
  payload?: Record<string, JobScalar>;
  /** Сколько задание имеет право прожить от постановки до конца. */
  deadlineMs: number;
  timezone?: string;
  source?: JobSource;
  privacy?: JobPrivacyMode;
  now?: Date;
}

export function buildJobEnvelope(input: JobEnvelopeInput): JobEnvelope {
  const payload = input.payload ?? {};
  assertSafePayload(payload);
  if (!input.type || !IDENTIFIER.test(input.type)) {
    throw new JobEnvelopeError("job_type_invalid", input.type);
  }
  if (!input.idempotencyKey) {
    throw new JobEnvelopeError("job_idempotency_key_missing");
  }
  if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
    throw new JobEnvelopeError("job_deadline_invalid");
  }
  const now = input.now ?? new Date();
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    type: input.type,
    queue: input.queue,
    userId: input.userId ?? null,
    conversationId: input.conversationId ?? null,
    agentId: input.agentId ?? null,
    traceId: input.traceId,
    correlationId: input.correlationId ?? input.traceId,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey,
    payloadRef: input.payloadRef ?? null,
    payload,
    createdAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + input.deadlineMs).toISOString(),
    timezone: input.timezone ?? "Europe/Moscow",
    source: input.source ?? "system",
    privacy: input.privacy ?? "standard",
  };
}

export type JobEnvelopeParse =
  | { ok: true; envelope: JobEnvelope }
  | { ok: false; code: string; retryable: false };

/**
 * Разобрать конверт из очереди или из строки outbox.
 *
 * Возвращает результат, а не бросает: вызывающий обязан отличить
 * «задание испорчено» от «работа не удалась», и разница здесь важнее
 * удобства — испорченное задание уходит в DLQ сразу, без повторов.
 */
export function parseJobEnvelope(raw: unknown): JobEnvelopeParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "job_envelope_invalid", retryable: false };
  }
  const candidate = raw as Partial<JobEnvelope>;
  const version = candidate.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, code: "job_schema_version_missing", retryable: false };
  }
  if (!SUPPORTED_JOB_SCHEMA_VERSIONS.has(version)) {
    // Незнакомая версия — не повод угадывать. Задание останется в DLQ и
    // дождётся версии кода, которая его понимает.
    return { ok: false, code: "job_schema_unsupported", retryable: false };
  }
  const required: (keyof JobEnvelope)[] = [
    "type",
    "queue",
    "traceId",
    "correlationId",
    "idempotencyKey",
    "createdAt",
    "deadlineAt",
    "timezone",
    "source",
    "privacy",
  ];
  for (const field of required) {
    if (typeof candidate[field] !== "string" || !candidate[field]) {
      return { ok: false, code: "job_envelope_incomplete", retryable: false };
    }
  }
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "job_envelope_incomplete", retryable: false };
  }
  try {
    assertSafePayload(payload as Record<string, unknown>);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof JobEnvelopeError ? error.code : "job_payload_invalid",
      retryable: false,
    };
  }
  return { ok: true, envelope: candidate as JobEnvelope };
}

/**
 * Контрольная сумма payload для журнала запусков.
 *
 * Считается по каноническому порядку ключей: два конверта с одинаковым
 * содержанием и разным порядком полей обязаны дать одну сумму, иначе
 * повтор выглядел бы другим заданием.
 */
export function payloadChecksum(envelope: JobEnvelope): string {
  const canonical = Object.keys(envelope.payload)
    .sort()
    .map((key) => `${key}=${String(envelope.payload[key])}`)
    .join("&");
  return createHash("sha256")
    .update(`${envelope.type}|${envelope.payloadRef ?? ""}|${canonical}`)
    .digest("hex");
}
