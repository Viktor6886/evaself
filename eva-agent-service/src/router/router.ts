/**
 * Движок LLM Router.
 *
 * Один пользовательский запрос — один ответ (требование 1.5.7). Из этого
 * следует единственное неочевидное правило всего модуля:
 *
 *   пока наружу не ушёл ни один байт содержимого, переключаться можно
 *   свободно; как только первый фрагмент отправлен клиенту, переключение
 *   запрещено — иначе пользователь получит два ответа подряд.
 *
 * Поэтому в потоковом режиме роутер держит failover ровно до первого
 * text-дельты и после неё уже только доводит ответ или сообщает об ошибке.
 */

import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import { anthropicAdapter } from "./adapters/anthropic.js";
import { openAiAdapter } from "./adapters/openai.js";
import { buildChain } from "./chain.js";
import type { ChainEntry } from "./chain.js";
import { requestedRouteOnly, resolveRoute } from "./routes.js";
import { LocalRouterLimits, type RouterLimits } from "./limits.js";
import { estimateTokens, normalizeForProvider, relaxAfterBadRequest, withBackupDirective } from "./normalize.js";
import { costOf, RouterStore, userIdOf } from "./store.js";
import type {
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  ProviderAdapter,
  ProviderProfile,
  RoutingSettings,
  SwitchReason,
} from "./types.js";
import { breakerKey, ProviderError } from "./types.js";

export interface RouterOptions {
  /** Сколько подряд ошибок открывает breaker. */
  breakerThreshold: number;
  /** Окно, в котором ошибки считаются подряд идущими. */
  breakerWindowMs: number;
  /** Выдержка перед пробным запросом. */
  breakerCooldownMs: number;
  /** Задержки повторов одному провайдеру: сразу, 2 с, 5 с. */
  retryBackoffMs: number[];
  /** Retry-After longer than this switches to the next provider. */
  maxRetryAfterMs?: number;
  retryAfterJitterMs?: number;
  reservationTtlMs?: number;
  /** Optional distributed limiter, injected only behind the feature flag. */
  limits?: RouterLimits;
}

export const DEFAULT_OPTIONS: RouterOptions = {
  breakerThreshold: 3,
  breakerWindowMs: 5 * 60_000,
  breakerCooldownMs: 7 * 60_000,
  retryBackoffMs: [0, 2_000, 5_000],
  maxRetryAfterMs: 5_000,
  retryAfterJitterMs: 250,
  reservationTtlMs: 300_000,
};

/** Итог маршрутизации, который сервер отдаёт клиенту. */
export interface RoutedResult {
  response: LlmResponse;
  request_id: string;
  provider_id: string;
  provider_name: string;
  switches: number;
  /**
   * Техническая цепочка, которой ушёл запрос. Нужна проверке
   * распознавания медиа: без неё нельзя отличить «картинка доехала до
   * vision» от «картинка потерялась и запрос ушёл обычным чатом».
   */
  route: string;
}

export class NoProviderAvailable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "NoProviderAvailable";
  }
}

const ADAPTERS: Record<ProviderProfile["protocol"], ProviderAdapter> = {
  "openai-compatible": openAiAdapter,
  "anthropic-compatible": anthropicAdapter,
};

/**
 * Выбор адаптера вынесен в функцию, чтобы тесты могли подставить заглушку
 * вместо сетевого вызова. В продакшене это ровно таблица выше.
 */
export type AdapterResolver = (provider: ProviderProfile) => ProviderAdapter;

const defaultResolver: AdapterResolver = (provider) => ADAPTERS[provider.protocol];

export class LlmRouter {
  private readonly limits: RouterLimits;

  constructor(
    private readonly store: RouterStore,
    private readonly logger: Logger,
    private readonly options: RouterOptions = DEFAULT_OPTIONS,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly adapterFor: AdapterResolver = defaultResolver,
  ) {
    this.limits = options.limits ?? new LocalRouterLimits();
  }

  // -----------------------------------------------------------------
  // подготовка цепочки
  // -----------------------------------------------------------------
  private async prepare(request: LlmRequest, settings: RoutingSettings) {
    const [providers, routes, chains, breakers] = await Promise.all([
      this.store.providers(),
      this.store.routes(),
      this.store.chains(),
      this.store.breakers(),
    ]);

    const configuredRoute = routes.get(request.metadata.route);
    if (!configuredRoute) {
      throw new NoProviderAvailable(`маршрут «${request.metadata.route}» не настроен`);
    }
    const route = settings.mode === "single"
      ? { ...configuredRoute, rotation_enabled: settings.single_failover_enabled }
      : configuredRoute;
    const providerIds = settings.mode === "single"
      ? [
          settings.single_provider_id,
          ...(settings.single_failover_enabled ? (chains.get("chat") ?? []) : []),
        ].filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index)
      : (chains.get(route.code) ?? []);
    if (providerIds.length === 0) {
      throw new NoProviderAvailable(`для маршрута «${route.code}» не назначен ни один провайдер`);
    }

    const chain = buildChain({
      route,
      request,
      providerIds,
      providers: new Map(providers.map((provider) => [provider.id, provider])),
      breakers,
      now: new Date(),
    });

    if (settings.mode === "single") {
      const selected = settings.single_provider_id;
      if (!selected || chain.primary?.id !== selected) {
        throw new NoProviderAvailable("выбранный provider режима одной модели выключен или отсутствует");
      }
      const rejection = chain.rejected.find((item) => item.provider.id === selected);
      if (rejection && rejection.reason !== "breaker_open") {
        throw new NoProviderAvailable(`выбранная модель несовместима с запросом: ${rejection.detail}`);
      }
    }

    if (chain.usable.length === 0) {
      const detail = chain.rejected.length
        ? chain.rejected.map((item) => `${item.provider.name}: ${item.detail}`).join("; ")
        : "все провайдеры маршрута выключены";
      throw new NoProviderAvailable(detail);
    }
    return { route, chain, breakers };
  }

  /**
   * Выбрать техническую цепочку провайдеров.
   *
   * Содержание сообщения здесь не читается: чем занят ход и насколько
   * глубоко его разбирать, решает Letta. Отсюда приходит только выбор
   * транспорта — см. `./routes.ts`.
   */
  private async routeRequest(request: LlmRequest): Promise<{ request: LlmRequest; settings: RoutingSettings }> {
    // Small in-memory stores used by older callers/tests predate managed
    // routing. Treat them as the original single-chain configuration.
    const candidate = this.store as RouterStore & { routingSettings?: () => Promise<RoutingSettings> };
    const managed = typeof candidate.routingSettings === "function";
    const settings = managed ? await candidate.routingSettings() : DEFAULT_ROUTING_SETTINGS;
    const resolution = managed ? resolveRoute(request, settings) : requestedRouteOnly(request);

    return {
      settings,
      request: {
        ...request,
        metadata: {
          ...request.metadata,
          route: resolution.effectiveRoute,
          requested_route: resolution.requestedRoute,
          effective_route: resolution.effectiveRoute,
          routing_mode: settings.mode,
          classification_source: resolution.source,
          classification_reason_codes: resolution.reasons,
          single_failover_used: false,
        },
      },
    };
  }

  /**
   * Бюджеты и лимиты. Проверяются до запроса: превышение — причина
   * переключения, а не ошибка пользователю (требование 1.4).
   */
  private async gate(
    provider: ProviderProfile,
  ): Promise<{ ok: true } | { ok: false; reason: SwitchReason; detail: string }> {
    if (provider.daily_budget_micro !== null || provider.monthly_budget_micro !== null) {
      const spent = await this.store.spend(provider.id);
      if (provider.daily_budget_micro !== null && spent.day >= provider.daily_budget_micro) {
        return { ok: false, reason: "budget_exceeded", detail: "исчерпан дневной бюджет" };
      }
      if (provider.monthly_budget_micro !== null && spent.month >= provider.monthly_budget_micro) {
        return { ok: false, reason: "budget_exceeded", detail: "исчерпан месячный бюджет" };
      }
    }
    return { ok: true };
  }

  // -----------------------------------------------------------------
  // непотоковый вызов
  // -----------------------------------------------------------------
  async complete(input: LlmRequest): Promise<RoutedResult> {
    const identified = this.withRequestId(input);
    const routed = await this.routeRequest(identified);
    const request = routed.request;
    const { route, chain } = await this.prepare(request, routed.settings);
    let switches = 0;
    let lastError: ProviderError | null = null;

    for (const entry of chain.usable) {
      const attemptRequest = routed.settings.mode === "single"
        && entry.provider.id !== routed.settings.single_provider_id
        ? { ...request, metadata: { ...request.metadata, single_failover_used: true } }
        : request;
      const outcome = await this.tryProvider(entry, attemptRequest, chain.primary?.id ?? null, switches);
      if (outcome.kind === "success") {
        return {
          response: outcome.response,
          request_id: request.metadata.request_id,
          provider_id: entry.provider.id,
          provider_name: entry.provider.name,
          switches,
          route: route.code,
        };
      }
      lastError = outcome.error;
      if (
        routed.settings.mode === "single" &&
        (!routed.settings.single_failover_enabled || !isTechnicalSingleFailover(outcome.error.reason))
      ) break;
      switches += 1;
      this.logger.warn("LLM Router: переключение на следующего провайдера", {
        request_id: request.metadata.request_id,
        route: route.code,
        from: entry.provider.name,
        reason: outcome.error.reason,
      });
    }

    throw new NoProviderAvailable(
      lastError
        ? `все провайдеры маршрута «${route.code}» недоступны: ${lastError.summary()}`
        : `все провайдеры маршрута «${route.code}» недоступны`,
    );
  }

  /**
   * Одна позиция цепочки: проверки, до max_retries повторов с backoff,
   * нормализация после HTTP 400, запись телеметрии.
   */
  private async tryProvider(
    entry: ChainEntry,
    original: LlmRequest,
    primaryId: string | null,
    switchesSoFar: number,
  ): Promise<{ kind: "success"; response: LlmResponse } | { kind: "failure"; error: ProviderError }> {
    const { provider } = entry;
    let request = withBackupDirective(
      normalizeForProvider(original, provider),
      entry.position > 0,
    );
    const estimated = estimateTokens(request);

    const gate = await this.gate(provider);
    if (!gate.ok) {
      const error = new ProviderError(gate.detail, gate.reason, { retryable: false });
      await this.log(provider, original, primaryId, {
        started: new Date(), attempts: 0, switches: switchesSoFar, error, streamed: false,
      });
      return { kind: "failure", error };
    }

    // Открытый breaker пропускает ровно один пробный запрос. Claim делаем
    // после лимитера: иначе отказ Valkey оставил бы breaker в half_open,
    // хотя до провайдера не ушло ни одного запроса.
    const breakers = await this.store.breakers();
    const breakerState = breakers.get(breakerKey(provider.id, provider.model))?.state;
    if (breakerState === "half_open") {
      return {
        kind: "failure",
        error: new ProviderError("circuit breaker уже выполняет пробный запрос", "breaker_open", {
          retryable: false,
        }),
      };
    }
    const needsProbe = breakerState === "open";

    const adapter = this.adapterFor(provider);
    const maxAttempts = needsProbe ? 1 : provider.max_retries + 1;
    let attempt = 0;
    let retryAfterDelay: number | null = null;
    let providerAttempted = false;
    let lastError = new ProviderError("не выполнено ни одной попытки", "model_error", {
      retryable: false,
    });

    while (attempt < maxAttempts) {
      const backoff = retryAfterDelay
        ?? this.options.retryBackoffMs[Math.min(attempt, this.options.retryBackoffMs.length - 1)]!;
      retryAfterDelay = null;
      if (backoff > 0) await this.sleep(backoff);
      attempt += 1;

      const started = new Date();
      let limited;
      try {
        limited = await this.limits.reserve({
          providerId: provider.id,
          model: provider.model,
          route: original.metadata.route,
          limits: provider,
          estimatedTokens: estimated,
          reservationTtlMs: Math.max(
            provider.request_timeout_ms,
            this.options.reservationTtlMs ?? DEFAULT_OPTIONS.reservationTtlMs!,
          ),
          reservationId: `${original.metadata.request_id}:${provider.id}:${attempt}:${randomUUID()}`,
        });
      } catch (error) {
        this.logger.warn("LLM Router: распределённый лимитер недоступен", {
          request_id: original.metadata.request_id,
          code: error instanceof Error ? error.name : "unknown_error",
        });
        lastError = new ProviderError(
          "распределённый лимитер недоступен",
          "rate_limited",
          { retryable: false },
        );
        break;
      }
      if (!limited.allowed) {
        lastError = new ProviderError(`лимит ${limited.reason}`, "rate_limited", {
          retryable: false,
        });
        break;
      }
      const reservation = limited.reservation;
      if (needsProbe && attempt === 1 && !(await this.store.claimProbe(provider.id, provider.model))) {
        await this.releaseLimit(reservation, original.metadata.request_id);
        lastError = new ProviderError("circuit breaker открыт", "breaker_open", {
          retryable: false,
        });
        break;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), provider.request_timeout_ms);
      try {
        providerAttempted = true;
        const response = await adapter.complete(provider, request, controller.signal);
        const latency = Date.now() - started.getTime();

        const contract = this.checkContract(request, response, latency, provider);
        if (contract) throw contract;

        await this.settleLimit(
          reservation,
          response.usage.tokens_in + response.usage.tokens_out,
          original.metadata.request_id,
        );
        await this.store.recordSuccess(provider.id, provider.model);
        await this.store.addSpend(provider.id, {
          tokens_in: response.usage.tokens_in,
          tokens_out: response.usage.tokens_out,
          cost_micro: costOf(provider, response),
        });
        await this.log(provider, original, primaryId, {
          started, attempts: attempt, switches: switchesSoFar, response, streamed: false,
        });
        return { kind: "success", response };
      } catch (raw) {
        const error = asProviderError(raw);
        lastError = error;

        // HTTP 400: сначала снять параметр, из-за которого запрос отвергли,
        // и повторить тому же провайдеру. Гонять некорректный запрос по всей
        // цепочке бессмысленно.
        if (error.options.badRequest) {
          const relaxed = relaxAfterBadRequest(request);
          if (relaxed) {
            request = relaxed;
            this.logger.info("LLM Router: запрос нормализован после отказа провайдера", {
              request_id: original.metadata.request_id,
              provider: provider.name,
            });
            continue;
          }
          break;
        }
        if (error.reason === "rate_limited" && error.retryAfterMs !== null) {
          if (error.retryAfterMs > (this.options.maxRetryAfterMs ?? DEFAULT_OPTIONS.maxRetryAfterMs!)) break;
          retryAfterDelay = error.retryAfterMs
            + Math.floor(Math.random() * Math.max(
              0,
              this.options.retryAfterJitterMs ?? DEFAULT_OPTIONS.retryAfterJitterMs!,
            ));
        }
        if (!error.options.retryable || attempt >= maxAttempts) break;
      } finally {
        clearTimeout(timer);
        await this.releaseLimit(reservation, original.metadata.request_id);
      }
    }

    if (providerAttempted) {
      await this.store.recordFailure(
        provider.id,
        provider.model,
        lastError.reason,
        this.options.breakerThreshold,
        this.options.breakerWindowMs,
        this.options.breakerCooldownMs,
      );
    }
    await this.log(provider, original, primaryId, {
      started: new Date(), attempts: attempt, switches: switchesSoFar, error: lastError, streamed: false,
    });
    return { kind: "failure", error: lastError };
  }

  /**
   * Проверки, которые провайдер прошёл технически, но результат всё равно
   * непригоден: сломанный JSON, вызовы инструментов без имени, слишком
   * долгий ответ.
   */
  private checkContract(
    request: LlmRequest,
    response: LlmResponse,
    latencyMs: number,
    provider: ProviderProfile,
  ): ProviderError | null {
    if (request.response_format?.type === "json_object") {
      const text = stripFence(response.content);
      try {
        JSON.parse(text);
      } catch {
        return new ProviderError("ответ не является корректным JSON", "json_contract_failed", {
          retryable: true,
        });
      }
    }
    if (response.tool_calls.some((call) => !call.name.trim())) {
      return new ProviderError("вызов инструмента без имени", "tool_calls_failed", {
        retryable: true,
      });
    }
    if (provider.max_latency_ms !== null && latencyMs > provider.max_latency_ms) {
      return new ProviderError(
        `ответ занял ${latencyMs} мс при допустимых ${provider.max_latency_ms}`,
        "latency_exceeded",
        { retryable: false },
      );
    }
    return null;
  }

  // -----------------------------------------------------------------
  // потоковый вызов
  // -----------------------------------------------------------------
  /**
   * Отдаёт фрагменты по мере поступления. Переключение возможно только до
   * первого отданного фрагмента — см. комментарий в шапке файла.
   */
  async *stream(input: LlmRequest): AsyncGenerator<LlmStreamChunk> {
    const identified = this.withRequestId({ ...input, stream: true });
    const routed = await this.routeRequest(identified);
    const request = routed.request;
    const { route, chain } = await this.prepare(request, routed.settings);
    let switches = 0;
    let lastError: ProviderError | null = null;

    const streamEntries = chain.usable.map((entry) => ({ entry, attempt: 1 }));
    providerLoop: for (let entryIndex = 0; entryIndex < streamEntries.length; entryIndex += 1) {
      const { entry, attempt } = streamEntries[entryIndex]!;
      const attemptRequest = routed.settings.mode === "single"
        && entry.provider.id !== routed.settings.single_provider_id
        ? { ...request, metadata: { ...request.metadata, single_failover_used: true } }
        : request;
      const { provider } = entry;
      const prepared = withBackupDirective(
        normalizeForProvider(attemptRequest, provider),
        entry.position > 0,
      );
      const estimated = estimateTokens(prepared);

      const gate = await this.gate(provider);
      if (!gate.ok) {
        lastError = new ProviderError(gate.detail, gate.reason, { retryable: false });
        switches += 1;
        continue;
      }
      if (!provider.supports_streaming) {
        // Провайдер без потока всё равно может ответить: собираем целиком и
        // отдаём одним фрагментом, вместо того чтобы терять резерв.
        const outcome = await this.tryProvider(entry, attemptRequest, chain.primary?.id ?? null, switches);
        if (outcome.kind === "success") {
          if (outcome.response.content) yield { type: "text", delta: outcome.response.content };
          for (const call of outcome.response.tool_calls) yield { type: "tool_call", call };
          yield { type: "done", response: outcome.response };
          return;
        }
        lastError = outcome.error;
        if (
          routed.settings.mode === "single" &&
          (!routed.settings.single_failover_enabled || !isTechnicalSingleFailover(outcome.error.reason))
        ) break;
        switches += 1;
        continue;
      }

      const adapter = this.adapterFor(provider);
      const started = new Date();
      const breakers = await this.store.breakers();
      const breakerState = breakers.get(breakerKey(provider.id, provider.model))?.state;
      if (breakerState === "half_open") {
        lastError = new ProviderError(
          "circuit breaker уже выполняет пробный запрос",
          "breaker_open",
          { retryable: false },
        );
        switches += 1;
        continue;
      }
      const needsProbe = breakerState === "open";
      let limited;
      try {
        limited = await this.limits.reserve({
          providerId: provider.id,
          model: provider.model,
          route: attemptRequest.metadata.route,
          limits: provider,
          estimatedTokens: estimated,
          reservationTtlMs: Math.max(
            provider.request_timeout_ms,
            this.options.reservationTtlMs ?? DEFAULT_OPTIONS.reservationTtlMs!,
          ),
          reservationId: `${request.metadata.request_id}:${provider.id}:stream:${randomUUID()}`,
        });
      } catch (error) {
        this.logger.warn("LLM Router: распределённый лимитер недоступен", {
          request_id: request.metadata.request_id,
          code: error instanceof Error ? error.name : "unknown_error",
        });
        lastError = new ProviderError(
          "распределённый лимитер недоступен",
          "rate_limited",
          { retryable: false },
        );
        switches += 1;
        continue;
      }
      if (!limited.allowed) {
        lastError = new ProviderError(`лимит ${limited.reason}`, "rate_limited", {
          retryable: false,
        });
        switches += 1;
        continue;
      }
      const reservation = limited.reservation;
      if (needsProbe && !(await this.store.claimProbe(provider.id, provider.model))) {
        await this.releaseLimit(reservation, request.metadata.request_id);
        lastError = new ProviderError("circuit breaker открыт", "breaker_open", {
          retryable: false,
        });
        switches += 1;
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), provider.request_timeout_ms);
      let emitted = false;

      try {
        for await (const chunk of adapter.stream(provider, prepared, controller.signal)) {
          if (chunk.type === "text" || chunk.type === "tool_call") emitted = true;
          if (chunk.type === "done") {
            await this.settleLimit(
              reservation,
              chunk.response.usage.tokens_in + chunk.response.usage.tokens_out,
              request.metadata.request_id,
            );
            await this.store.recordSuccess(provider.id, provider.model);
            await this.store.addSpend(provider.id, {
              tokens_in: chunk.response.usage.tokens_in,
              tokens_out: chunk.response.usage.tokens_out,
              cost_micro: costOf(provider, chunk.response),
            });
            await this.log(provider, attemptRequest, chain.primary?.id ?? null, {
              started, attempts: attempt, switches, response: chunk.response, streamed: true,
            });
          }
          yield chunk;
        }
        return;
      } catch (raw) {
        const error = asProviderError(raw);
        lastError = error;
        await this.log(provider, attemptRequest, chain.primary?.id ?? null, {
          started, attempts: attempt, switches, error, streamed: true,
        });

        if (emitted) {
          await this.store.recordFailure(
            provider.id,
            provider.model,
            error.reason,
            this.options.breakerThreshold,
            this.options.breakerWindowMs,
            this.options.breakerCooldownMs,
          );
          // Часть ответа уже у пользователя. Второй ответ от резерва был бы
          // именно тем «двойным ответом», который запрещён требованием
          // 1.5.7, поэтому здесь только обрыв.
          this.logger.error("LLM Router: поток оборвался после начала выдачи", {
            request_id: request.metadata.request_id,
            provider: provider.name,
            reason: error.reason,
          });
          throw error;
        }
        if (
          error.reason === "rate_limited" &&
          error.retryAfterMs !== null &&
          error.retryAfterMs <= (this.options.maxRetryAfterMs ?? DEFAULT_OPTIONS.maxRetryAfterMs!) &&
          attempt <= provider.max_retries
        ) {
          const delay = error.retryAfterMs + Math.floor(Math.random() * Math.max(
            0,
            this.options.retryAfterJitterMs ?? DEFAULT_OPTIONS.retryAfterJitterMs!,
          ));
          await this.sleep(delay);
          streamEntries.splice(entryIndex + 1, 0, { entry, attempt: attempt + 1 });
          continue providerLoop;
        }
        await this.store.recordFailure(
          provider.id,
          provider.model,
          error.reason,
          this.options.breakerThreshold,
          this.options.breakerWindowMs,
          this.options.breakerCooldownMs,
        );
        if (
          routed.settings.mode === "single" &&
          (!routed.settings.single_failover_enabled || !isTechnicalSingleFailover(error.reason))
        ) break providerLoop;
        switches += 1;
        this.logger.warn("LLM Router: переключение до начала выдачи", {
          request_id: request.metadata.request_id,
          route: route.code,
          from: provider.name,
          reason: error.reason,
        });
      } finally {
        clearTimeout(timer);
        await this.releaseLimit(reservation, request.metadata.request_id);
      }
    }

    throw new NoProviderAvailable(
      lastError
        ? `все провайдеры маршрута «${route.code}» недоступны: ${lastError.summary()}`
        : `все провайдеры маршрута «${route.code}» недоступны`,
    );
  }

  // -----------------------------------------------------------------
  // служебное
  // -----------------------------------------------------------------
  private withRequestId(request: LlmRequest): LlmRequest {
    if (request.metadata.request_id) return request;
    return {
      ...request,
      metadata: { ...request.metadata, request_id: randomUUID() },
    };
  }

  private async settleLimit(
    reservation: { settle(actualTokens: number): Promise<void> },
    actualTokens: number,
    requestId: string,
  ): Promise<void> {
    try {
      await reservation.settle(actualTokens);
    } catch (error) {
      // The provider has already completed. Losing operational accounting must
      // not discard its valid answer or cause a duplicate provider request.
      this.logger.warn("LLM Router: не удалось уточнить распределённый лимит", {
        request_id: requestId,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  private async releaseLimit(
    reservation: { release(): Promise<void> },
    requestId: string,
  ): Promise<void> {
    try {
      await reservation.release();
    } catch (error) {
      // Reservation TTL is the crash-safe fallback; never override the real
      // provider outcome with a cleanup error.
      this.logger.warn("LLM Router: не удалось освободить распределённый лимит", {
        request_id: requestId,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  /** Телеметрия без единой строки переписки — только счётчики и коды. */
  private async log(
    provider: ProviderProfile,
    request: LlmRequest,
    primaryId: string | null,
    outcome: {
      started: Date;
      attempts: number;
      switches: number;
      streamed: boolean;
      response?: LlmResponse;
      error?: ProviderError;
    },
  ): Promise<void> {
    try {
      await this.store.recordAttempt({
        request_id: request.metadata.request_id,
        route_code: request.metadata.route,
        user_id: userIdOf(request),
        agent_id: request.metadata.agent_id,
        primary_provider_id: primaryId,
        actual_provider_id: provider.id,
        model: outcome.response?.model ?? provider.model,
        started_at: outcome.started,
        latency_ms: Date.now() - outcome.started.getTime(),
        attempts: outcome.attempts,
        switches: outcome.switches,
        succeeded: Boolean(outcome.response),
        error_code: outcome.error?.reason ?? null,
        switch_reason: outcome.error?.reason ?? null,
        error_summary: outcome.error?.summary() ?? null,
        http_status: outcome.error?.httpStatus ?? null,
        tokens_in: outcome.response?.usage.tokens_in ?? 0,
        tokens_out: outcome.response?.usage.tokens_out ?? 0,
        cost_micro: outcome.response ? costOf(provider, outcome.response) : 0,
        tool_calls: outcome.response?.tool_calls.length ?? 0,
        streamed: outcome.streamed,
        routing_mode: request.metadata.routing_mode ?? "adaptive",
        requested_route: request.metadata.requested_route ?? request.metadata.route,
        effective_route: request.metadata.effective_route ?? request.metadata.route,
        classification_source: request.metadata.classification_source ?? null,
        // Уверенности и балла больше нет: маршрут выбирается
        // детерминированно, оценивать нечего.
        classification_confidence: null,
        classification_score: null,
        classification_reason_codes: request.metadata.classification_reason_codes ?? [],
        purpose: request.metadata.purpose ?? null,
        internal_operation_type: request.metadata.internal_operation_type ?? null,
        single_failover_used: request.metadata.single_failover_used === true,
      });
    } catch (error) {
      // Диалог важнее журнала: сбой записи телеметрии не должен ронять ответ.
      this.logger.warn("LLM Router: не удалось записать телеметрию", {
        request_id: request.metadata.request_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  mode: "adaptive",
  single_provider_id: null,
  single_failover_enabled: false,
};

function isTechnicalSingleFailover(reason: SwitchReason): boolean {
  return [
    "rate_limited", "server_error", "connection_failed", "timeout",
    "quota_exhausted", "breaker_open", "empty_response",
  ].includes(reason);
}

function asProviderError(raw: unknown): ProviderError {
  if (raw instanceof ProviderError) return raw;
  const message = raw instanceof Error ? raw.message : String(raw);
  if (raw instanceof Error && (raw.name === "AbortError" || raw.name === "TimeoutError")) {
    return new ProviderError("превышен таймаут ответа", "timeout", { retryable: true });
  }
  return new ProviderError(message, "model_error", { retryable: false });
}

/** Модели любят обернуть JSON в ```json … ``` даже когда просили не оборачивать. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
