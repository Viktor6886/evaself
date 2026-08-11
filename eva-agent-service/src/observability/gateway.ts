/**
 * Единственный выход телеметрии наружу.
 *
 * Бизнес-код не знает ни про Langfuse, ни про OpenTelemetry: он вызывает
 * шлюз. Причина та же, что у LLM Router (инвариант 16): как только SDK
 * внешнего сервиса появляется в бизнес-модуле, вокруг него вырастает
 * второй контур — со своими настройками, своим буфером и своим
 * представлением о том, что можно отправлять. Здесь контур один, и
 * граница приватности у него тоже одна.
 *
 * Три реализации:
 *   Noop      — телеметрии нет; путь пользователя от этого не меняется;
 *   Recording — накапливает в памяти, для тестов и локального разбора;
 *   Langfuse  — отправляет ТОЛЬКО метаданные генерации.
 *
 * Langfuse не источник истины (требование 9 шага 9): критическая логика
 * безопасности, приватности, платежей и удаления в него не уходит и из
 * него не читается. Его недоступность — не инцидент пользовательского
 * пути, а потерянная телеметрия.
 */

import type { Logger } from "../logger.js";
import { PrivacyProcessor, type SafeValue } from "./privacy.js";

/** Что наблюдаем. Список закрытый: новый вид события — осознанное решение. */
export type ObservationKind =
  /** Ход пользователя целиком. */
  | "turn"
  /** Обращение к модели через Router. */
  | "generation"
  /** Фоновое задание. */
  | "job"
  /** Доставка сообщения. */
  | "delivery"
  /** Оценка качества (шаг 22). */
  | "score";

export interface Observation {
  kind: ObservationKind;
  name: string;
  /** Идентификаторы трассы: заполняет `tracing.ts`, а не вызывающий. */
  traceId?: string | null;
  correlationId?: string | null;
  /** Владелец. Наружу уходит псевдонимом, а не значением. */
  userId?: number | null;
  startedAt?: number;
  durationMs?: number;
  /** Прочие признаки. Проходят процессор приватности целиком. */
  attributes?: Record<string, unknown>;
}

export interface ObservabilityGateway {
  /** Записать наблюдение. Никогда не бросает и никогда не ждёт сети. */
  observe(observation: Observation): void;
  /** Отправить накопленное. Отказ доставки не пробрасывается наружу. */
  flush(): Promise<void>;
  /** Остановка: последний сброс и освобождение таймеров. */
  shutdown(): Promise<void>;
}

/** Телеметрии нет. Умолчание production, пока человек не включил флаг. */
export class NoopObservability implements ObservabilityGateway {
  observe(): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** Накопитель в памяти: тесты и локальный разбор. */
export class RecordingObservability implements ObservabilityGateway {
  readonly records: Array<{
    kind: ObservationKind;
    name: string;
    attributes: Record<string, SafeValue>;
  }> = [];

  constructor(private readonly privacy: PrivacyProcessor) {}

  observe(observation: Observation): void {
    this.records.push({
      kind: observation.kind,
      name: observation.name,
      attributes: exportAttributes(observation, this.privacy),
    });
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/**
 * Собрать безопасный набор атрибутов наблюдения.
 *
 * Единственное место, где идентификатор пользователя превращается в
 * псевдоним, а произвольные признаки проходят через границу. Реализации
 * шлюза обязаны звать именно её, а не собирать payload сами.
 */
export function exportAttributes(
  observation: Observation,
  privacy: PrivacyProcessor,
): Record<string, SafeValue> {
  const { attributes } = privacy.sanitize({
    ...(observation.attributes ?? {}),
    trace_id: observation.traceId ?? null,
    correlation_id: observation.correlationId ?? null,
    user_pseudonym: privacy.pseudonym(observation.userId),
    duration_ms: observation.durationMs ?? null,
    kind: observation.kind,
  });
  return attributes;
}

export interface LangfuseOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  /** Сколько наблюдений держим до отправки. Переполнение отбрасывает старые. */
  bufferLimit?: number;
  /** Период фоновой отправки. */
  flushIntervalMs?: number;
  /** Таймаут запроса: телеметрия не имеет права ждать долго. */
  requestTimeoutMs?: number;
}

interface BufferedEvent {
  kind: ObservationKind;
  name: string;
  timestamp: string;
  attributes: Record<string, SafeValue>;
}

/**
 * Отправка метаданных в Langfuse.
 *
 * SDK не используется намеренно: нам нужен один POST с массивом событий,
 * а вместе с SDK пришли бы его собственный буфер, его собственные
 * повторы и его собственное представление о том, что такое «трасса».
 * Второй буфер поверх нашего означал бы, что ограничение памяти,
 * записанное здесь, ничего не ограничивает.
 *
 * Буфер ограничен и отбрасывает САМЫЕ СТАРЫЕ события: при недоступном
 * Langfuse свежая телеметрия полезнее вчерашней, а расти бесконечно
 * буфер не имеет права — это память процесса, обслуживающего людей.
 */
export class LangfuseObservability implements ObservabilityGateway {
  private readonly buffer: BufferedEvent[] = [];
  private readonly limit: number;
  private readonly requestTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  /** Сколько событий потеряно из-за переполнения. Видно в метриках. */
  private dropped = 0;

  constructor(
    private readonly options: LangfuseOptions,
    private readonly privacy: PrivacyProcessor,
    private readonly logger: Logger,
  ) {
    this.limit = options.bufferLimit ?? 500;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    const interval = Math.max(1_000, options.flushIntervalMs ?? 5_000);
    this.timer = setInterval(() => void this.flush(), interval);
    this.timer.unref();
  }

  get droppedEvents(): number {
    return this.dropped;
  }

  get bufferedEvents(): number {
    return this.buffer.length;
  }

  observe(observation: Observation): void {
    if (this.buffer.length >= this.limit) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push({
      kind: observation.kind,
      name: observation.name,
      timestamp: new Date(observation.startedAt ?? Date.now()).toISOString(),
      attributes: exportAttributes(observation, this.privacy),
    });
  }

  /**
   * Отправить накопленное.
   *
   * Отказ не пробрасывается: вызывающий — это ход пользователя или
   * фоновое задание, и телеметрия не имеет права стать причиной их
   * отказа. Отправленные события из буфера уходят, неотправленные
   * остаются до следующего захода — но не дольше, чем позволит предел.
   */
  async flush(): Promise<void> {
    if (this.sending || this.buffer.length === 0) return;
    this.sending = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/api/public/ingestion`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${Buffer.from(
              `${this.options.publicKey}:${this.options.secretKey}`,
            ).toString("base64")}`,
          },
          body: JSON.stringify({ batch }),
        });
        if (!response.ok) {
          this.requeue(batch);
          this.logger.warn("Langfuse отклонил телеметрию", { status: response.status });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      this.requeue(batch);
      this.logger.warn("Langfuse недоступен, телеметрия отложена", {
        code: error instanceof Error ? error.name : "unknown_error",
        buffered: this.buffer.length,
        dropped: this.dropped,
      });
    } finally {
      this.sending = false;
    }
  }

  /**
   * Вернуть неотправленное в буфер, соблюдая предел.
   *
   * Возврат идёт в начало (это более старые события), и при нехватке
   * места лишнее отбрасывается здесь же: иначе неудачная отправка
   * увеличивала бы буфер сверх предела ровно в тот момент, когда сеть
   * лежит и событий копится больше обычного.
   */
  private requeue(batch: BufferedEvent[]): void {
    const room = this.limit - this.buffer.length;
    if (room <= 0) {
      this.dropped += batch.length;
      return;
    }
    const kept = batch.slice(Math.max(0, batch.length - room));
    this.dropped += batch.length - kept.length;
    this.buffer.unshift(...kept);
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
