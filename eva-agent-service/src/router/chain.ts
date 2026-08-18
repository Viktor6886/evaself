/**
 * Построение цепочки провайдеров для конкретного запроса.
 *
 * Требование 1.7: перед назначением резерва проверяется поддержка tool
 * calling, JSON, нужного размера контекста и уровня качества. Модель без
 * инструментов не должна получать запрос, которому нужен вызов
 * инструмента, — поэтому несовместимый провайдер выпадает из цепочки с
 * явной причиной, а не молча.
 */

import { estimateTokens } from "./normalize.js";
import type { BreakerRow } from "./store.js";
import { breakerKey } from "./types.js";
import type { LlmRequest, ProviderProfile, RouteDefinition, SwitchReason } from "./types.js";

export interface ChainEntry {
  provider: ProviderProfile;
  /** Позиция в цепочке маршрута: 0 — основной. */
  position: number;
}

export interface RejectedEntry {
  provider: ProviderProfile;
  reason: SwitchReason;
  detail: string;
}

export interface BuiltChain {
  usable: ChainEntry[];
  rejected: RejectedEntry[];
  /** Голова цепочки по конфигурации, даже если она сейчас недоступна. */
  primary: ProviderProfile | null;
}

export interface ChainInput {
  route: RouteDefinition;
  request: LlmRequest;
  providerIds: string[];
  providers: Map<string, ProviderProfile>;
  breakers: Map<string, BreakerRow>;
  now: Date;
}

export function buildChain(input: ChainInput): BuiltChain {
  const usable: ChainEntry[] = [];
  const rejected: RejectedEntry[] = [];
  let primary: ProviderProfile | null = null;

  const needed = estimateTokens(input.request);

  input.providerIds.forEach((id, position) => {
    const provider = input.providers.get(id);
    // Провайдер выключен или удалён — в карте включённых его нет.
    if (!provider) return;
    if (position === 0) primary = provider;

    const incompatible = incompatibility(provider, input.route, input.request, needed);
    if (incompatible) {
      rejected.push({ provider, reason: "incompatible", detail: incompatible });
      return;
    }

    const breaker = input.breakers.get(breakerKey(provider.id, provider.model));
    if (breaker?.pinned_out) {
      rejected.push({
        provider,
        reason: "breaker_open",
        detail: "администратор снял провайдера с автоматического возврата",
      });
      return;
    }
    if (breaker?.state === "open") {
      const ready = breaker.probe_after !== null && breaker.probe_after <= input.now;
      if (!ready) {
        rejected.push({ provider, reason: "breaker_open", detail: "circuit breaker открыт" });
        return;
      }
      // Время выдержки вышло: провайдер остаётся в цепочке, роутер
      // попробует занять пробный запрос через claimProbe().
    }
    if (breaker?.state === "half_open") {
      rejected.push({
        provider,
        reason: "breaker_open",
        detail: "circuit breaker уже выполняет единственный пробный запрос",
      });
      return;
    }

    usable.push({ provider, position });
  });

  // Ротация выключена — резервы отсекаются здесь, а не в роутере: так
  // причина попадает в rejected и видна в телеметрии, а не выглядит
  // как «резерв почему-то не сработал».
  if (input.route.rotation_enabled === false && usable.length > 1) {
    for (const entry of usable.slice(1)) {
      rejected.push({
        provider: entry.provider,
        reason: "rotation_disabled",
        detail: "ротация провайдеров выключена для этого маршрута",
      });
    }
    usable.length = 1;
  }

  return { usable, rejected, primary };
}

/** Возвращает описание несовместимости или null. */
function incompatibility(
  provider: ProviderProfile,
  route: RouteDefinition,
  request: LlmRequest,
  neededTokens: number,
): string | null {
  if (route.requires_tools && !provider.supports_tools) {
    return "маршрут требует tool calling";
  }
  if (route.requires_json && !provider.supports_json) {
    return "маршрут требует строгий JSON";
  }
  if (route.requires_vision && !provider.supports_vision) {
    return "маршрут требует работу с изображениями";
  }
  if (route.requires_streaming && !provider.supports_streaming) {
    return "маршрут требует потоковый ответ";
  }
  if (provider.context_window < route.min_context_window) {
    return `окно контекста ${provider.context_window} меньше требуемых ${route.min_context_window}`;
  }
  // Требование 1.7: не подставлять заметно более слабую модель только
  // потому, что она доступна.
  if (provider.quality_tier > route.max_quality_tier) {
    return `уровень качества ${provider.quality_tier} ниже допустимого для маршрута`;
  }
  if (request.metadata.sensitive && !provider.sensitive_data_allowed) {
    return "провайдеру не разрешены чувствительные данные";
  }
  // Инструменты в самом запросе важнее объявленных требований маршрута:
  // запрос мог прийти вне маршрута.
  if (request.tools.length > 0 && !provider.supports_tools) {
    return "в запросе есть инструменты, а провайдер их не поддерживает";
  }
  if (neededTokens > provider.context_window) {
    return `запрос примерно на ${neededTokens} токенов не помещается в ${provider.context_window}`;
  }
  return null;
}
