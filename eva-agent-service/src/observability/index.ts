/**
 * Сборка контура наблюдаемости.
 *
 * Одна точка входа и один порядок: сначала трассировка (её нужно завести
 * раньше инструментируемых модулей), потом процессор приватности, потом
 * шлюз. Промежуточных состояний нет — либо контур собран целиком, либо
 * его нет и работает Noop.
 *
 * Ни один флаг здесь не включает «побольше данных». Langfuse получает
 * метаданные генерации и только их; полного текста в этом контуре не
 * существует ни при каких настройках.
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import {
  LangfuseObservability,
  NoopObservability,
  type ObservabilityGateway,
} from "./gateway.js";
import { PrivacyProcessor } from "./privacy.js";
import { initTracing, shutdownTracing } from "./tracing.js";

export interface ObservabilityLayer {
  gateway: ObservabilityGateway;
  privacy: PrivacyProcessor;
  /** Состояние буфера экспортёра для /metrics. */
  bufferStats(): { buffered: number; dropped: number };
  shutdown(): Promise<void>;
}

export interface ObservabilitySettings {
  otelEnabled: boolean;
  langfuseMetadataOnly: boolean;
  langfuseBaseUrl: string;
  langfusePublicKey: string;
  langfuseSecretKey: string;
  telemetryPseudonymSecret: string;
  serviceName?: string;
}

export function buildObservability(
  config: Config,
  version: string,
  logger: Logger,
): ObservabilityLayer {
  return buildObservabilityFrom(config, version, logger);
}

/**
 * Сборка из голых настроек.
 *
 * Нужна процессам, которые не читают `Config`: llm-router и admin-api
 * поднимаются отдельными командами того же образа и знают только
 * окружение. Контур у них тот же — второй границы приватности не
 * появляется.
 */
export function buildObservabilityFrom(
  settings: ObservabilitySettings,
  version: string,
  logger: Logger,
): ObservabilityLayer {
  // Трассировка заводится первой: пакеты инструментации подменяют методы
  // при загрузке, и провайдер, зарегистрированный после них, собрал бы
  // пустые трассы.
  initTracing({ enabled: settings.otelEnabled, version, serviceName: settings.serviceName });

  const privacy = new PrivacyProcessor({
    pseudonymSecret: settings.telemetryPseudonymSecret,
  });

  const langfuseReady = settings.langfuseMetadataOnly
    && Boolean(settings.langfuseBaseUrl && settings.langfusePublicKey && settings.langfuseSecretKey);

  const gateway: ObservabilityGateway = langfuseReady
    ? new LangfuseObservability(
      {
        baseUrl: settings.langfuseBaseUrl,
        publicKey: settings.langfusePublicKey,
        secretKey: settings.langfuseSecretKey,
      },
      privacy,
      logger,
    )
    : new NoopObservability();

  if (settings.langfuseMetadataOnly && !langfuseReady) {
    // Включённый флаг без доступа — не молчаливое «работает»: человек
    // должен узнать, что телеметрия никуда не идёт, из журнала запуска.
    logger.warn("Langfuse включён, но не настроен: телеметрия не отправляется");
  }

  return {
    gateway,
    privacy,
    bufferStats: () =>
      gateway instanceof LangfuseObservability
        ? { buffered: gateway.bufferedEvents, dropped: gateway.droppedEvents }
        : { buffered: 0, dropped: 0 },
    async shutdown(): Promise<void> {
      await gateway.shutdown();
      await shutdownTracing();
    },
  };
}

export { PrivacyProcessor } from "./privacy.js";
export {
  LangfuseObservability,
  NoopObservability,
  RecordingObservability,
  type Observation,
  type ObservabilityGateway,
} from "./gateway.js";
export {
  currentTraceContext,
  newCorrelationId,
  parseTraceparent,
  traceHeaders,
  withSpan,
  type TraceContext,
} from "./tracing.js";
