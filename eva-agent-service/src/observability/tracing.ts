/**
 * Трассировка: один контур на весь сервис.
 *
 * Здесь две задачи, и вторая важнее первой. Первая — завести
 * OpenTelemetry раньше, чем загрузятся инструментируемые модули: пакеты
 * инструментации подменяют методы при загрузке, и провайдер,
 * зарегистрированный после них, получает пустые трассы. Поэтому
 * `initTracing()` вызывается первой строкой входа сервиса.
 *
 * Вторая — донести один и тот же идентификатор хода через все границы:
 * HTTP-запрос, durable inbox, фоновое задание, ход Letta, обращение к
 * модели и доставку. Между ними процесс успевает несколько раз потерять
 * стек вызовов (запись в таблицу, очередь, таймер), поэтому контекст
 * передаётся ЯВНО — заголовками `traceparent`/`tracestate` и полем
 * correlation id в конверте, а не подразумевается из окружения.
 *
 * Содержания в спанах нет: атрибуты проходят тот же процессор
 * приватности, что и телеметрия шлюза.
 */

import { randomBytes } from "node:crypto";

import {
  SpanStatusCode,
  context as otelContext,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import type { PrivacyProcessor } from "./privacy.js";

const TRACER_NAME = "eva-agent-service";

let provider: NodeTracerProvider | null = null;

export interface TracingOptions {
  enabled: boolean;
  serviceName?: string;
  version: string;
}

/**
 * Завести провайдер трасс.
 *
 * Экспортёр не подключается: наружу телеметрия уходит через
 * `ObservabilityGateway`, и второй путь экспорта означал бы вторую
 * границу приватности. Провайдер нужен ради контекста — идентификаторов
 * трассы, которые переживают границы модулей.
 */
export function initTracing(options: TracingOptions): void {
  if (!options.enabled || provider) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? TRACER_NAME,
      [ATTR_SERVICE_VERSION]: options.version,
    }),
  });
  provider.register();
}

export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  await provider.shutdown().catch(() => undefined);
  provider = null;
}

export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Контекст хода, который переживает границы модулей и процессов. */
export interface TraceContext {
  traceId: string;
  spanId: string;
  /** Значение заголовка `traceparent` формата W3C. */
  traceparent: string;
  tracestate: string | null;
  /** Сквозной идентификатор бизнес-операции: живёт дольше одной трассы. */
  correlationId: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Текущий контекст, если ход уже начат. */
export function currentTraceContext(correlationId?: string | null): TraceContext | null {
  const span = trace.getSpan(otelContext.active());
  const spanContext = span?.spanContext();
  if (!spanContext || !spanContext.traceId || spanContext.traceId === "0".repeat(32)) {
    return null;
  }
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${
      (spanContext.traceFlags & 1) === 1 ? "01" : "00"
    }`,
    tracestate: spanContext.traceState?.serialize() ?? null,
    correlationId: correlationId ?? spanContext.traceId,
  };
}

/**
 * Разобрать входящий `traceparent`.
 *
 * Некорректный заголовок — не повод отказать в обслуживании: ход
 * начнётся с новой трассой. Молча принимать мусор тоже нельзя, поэтому
 * функция возвращает `null`, а вызывающий решает.
 */
export function parseTraceparent(value: string | undefined | null): {
  traceId: string;
  spanId: string;
  sampled: boolean;
} | null {
  if (!value) return null;
  const matched = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!matched) return null;
  const [, traceId, spanId, flags] = matched as unknown as [string, string, string, string];
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/**
 * Заголовки для исходящего запроса.
 *
 * Ими ход доносится до media-service, провайдера модели и любого
 * другого участника, умеющего W3C trace context. Correlation id идёт
 * отдельным заголовком: он переживает смену трассы, а `traceparent` —
 * нет.
 */
export function traceHeaders(context: TraceContext | null): Record<string, string> {
  if (!context) return {};
  const headers: Record<string, string> = {
    traceparent: context.traceparent,
    "x-correlation-id": context.correlationId,
  };
  if (context.tracestate) headers.tracestate = context.tracestate;
  return headers;
}

/** Новый correlation id: 16 байт, как и trace id, но живёт дольше трассы. */
export function newCorrelationId(): string {
  return randomBytes(16).toString("hex");
}

export interface SpanOptions {
  /** Признаки спана. Проходят процессор приватности. */
  attributes?: Record<string, unknown>;
  privacy?: PrivacyProcessor;
}

/**
 * Выполнить работу внутри спана.
 *
 * Отказ отмечается в спане и пробрасывается дальше: трассировка не
 * меняет поведение кода (раздел «НЕ ДЕЛАЙ» шага 9). В спан попадает код
 * ошибки, но не её сообщение — сообщение внешнего сервиса может
 * содержать переданные ему данные.
 */
export async function withSpan<T>(
  name: string,
  work: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const active = tracer().startSpan(name);
  if (options.attributes) {
    const safe = options.privacy
      ? options.privacy.sanitize(options.attributes).attributes
      : {};
    for (const [key, value] of Object.entries(safe)) {
      if (value !== null) active.setAttribute(key, value);
    }
  }
  try {
    return await otelContext.with(trace.setSpan(otelContext.active(), active), async () => await work(active));
  } catch (error) {
    active.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.name : "unknown_error",
    });
    throw error;
  } finally {
    active.end();
  }
}
