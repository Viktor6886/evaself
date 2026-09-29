/**
 * Векторизация через LLM Router.
 *
 * Модуль лежит внутри `src/router/` не для порядка в каталогах: любой
 * выход к модели идёт через роутер (инвариант 16), и отдельный клиент
 * рядом с ним был бы вторым путём наружу — с собственными таймаутами,
 * собственным ключом и собственной, никем не учтённой стоимостью.
 *
 * Провайдер берётся из того же реестра, что и провайдеры диалога: адрес,
 * ключ и таймаут у роутера уже есть. Что считать — модель и размерность —
 * задаёт цель: прежняя из окружения (`EVA_EMBEDDING_MODEL`, 1536, вектор
 * pgvector) или версия эмбеддингов базы знаний (docs/knowledge-base.md).
 */

import { openAiCompatHeaders, resolveOpenAiCompat } from "./provider-manifests.js";
import type { ProviderProfile } from "./types.js";

export interface EmbeddingProviderSource {
  providers(): Promise<ProviderProfile[]>;
}

/** Чем и в каком пространстве считать векторы. */
export interface EmbeddingTarget {
  /** Провайдер реестра по id; без него — по имени или первый совместимый. */
  providerId?: string;
  providerName?: string;
  model: string;
  /** Ожидаемая размерность; null — узнать из ответа (проверка модели). */
  dimension: number | null;
  /** Передать `dimensions` в запрос: модель укоротит вектор до `dimension`. */
  requestDimensions?: boolean;
}

/**
 * Почему векторы не посчитаны. Код уходит вызывающему и в панель; текст
 * ответа провайдера — нет: в нём бывает эхо запроса и служебные детали.
 */
export type EmbeddingErrorCode =
  | "embedding_provider_missing"
  | "embedding_protocol_unsupported"
  | "embedding_auth"
  | "embedding_not_found"
  | "embedding_bad_request"
  | "embedding_rate_limited"
  | "embedding_unavailable"
  | "embedding_timeout"
  | "embedding_incomplete"
  | "embedding_dimension_mismatch";

export class EmbeddingError extends Error {
  constructor(readonly code: EmbeddingErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

const MESSAGES: Record<EmbeddingErrorCode, string> = {
  embedding_provider_missing: "Провайдер embeddings не найден или выключен",
  embedding_protocol_unsupported: "Провайдер не OpenAI-совместимый: embeddings считаются только через /embeddings",
  embedding_auth: "Провайдер отклонил ключ",
  embedding_not_found: "Модель или адрес embeddings у провайдера не найдены",
  embedding_bad_request: "Провайдер отклонил запрос: модель не считает embeddings или не принимает параметр dimensions",
  embedding_rate_limited: "Провайдер ограничил частоту запросов",
  embedding_unavailable: "Провайдер embeddings недоступен",
  embedding_timeout: "Провайдер embeddings не ответил вовремя",
  embedding_incomplete: "Провайдер вернул не все векторы",
  embedding_dimension_mismatch: "Размерность векторов не совпала с ожидаемой",
};

function fail(code: EmbeddingErrorCode, detail?: string): EmbeddingError {
  return new EmbeddingError(code, detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code]);
}

function codeForStatus(status: number): EmbeddingErrorCode {
  if (status === 401 || status === 403) return "embedding_auth";
  if (status === 404) return "embedding_not_found";
  if (status === 429) return "embedding_rate_limited";
  if (status >= 500) return "embedding_unavailable";
  return "embedding_bad_request";
}

export class RouterEmbeddings {
  constructor(
    private readonly source: EmbeddingProviderSource,
    private readonly options: {
      model: string;
      dimension: number;
      /** Имя провайдера, если embeddings обслуживает не первый в списке. */
      providerName?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  get model(): string {
    return this.options.model;
  }

  get dimension(): number {
    return this.options.dimension;
  }

  /** Прежняя цель: модель из окружения, вектор для pgvector. */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return await this.embedWith({
      ...(this.options.providerName ? { providerName: this.options.providerName } : {}),
      model: this.options.model,
      dimension: this.options.dimension,
    }, texts, signal);
  }

  /**
   * Посчитать векторы для заданной цели.
   *
   * Возвращается ровно столько векторов, сколько пришло текстов, и в том
   * же порядке. Частичный ответ — отказ: молча выровнять его значило бы
   * записать вектор одного фрагмента другому.
   */
  async embedWith(target: EmbeddingTarget, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const provider = await this.provider(target);
    const call = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? provider.request_timeout_ms;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      let payload: { data?: Array<{ embedding?: unknown; index?: number }> };
      try {
        response = await call(`${provider.base_url.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: {
            ...openAiCompatHeaders(
              resolveOpenAiCompat(provider.base_url, { ...provider.generation_defaults, ...provider.additional_parameters }),
              provider.api_key,
            ),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: target.model,
            input: texts,
            ...(target.requestDimensions && target.dimension ? { dimensions: target.dimension } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Тело отказа не читается в сообщение: провайдеры возвращают в нём
          // эхо запроса, а это текст документов человека.
          await response.body?.cancel().catch(() => undefined);
          throw fail(codeForStatus(response.status), `HTTP ${response.status}`);
        }
        payload = await response.json() as typeof payload;
      } catch (error) {
        if (error instanceof EmbeddingError) throw error;
        if (signal?.aborted) throw error;
        throw fail(controller.signal.aborted ? "embedding_timeout" : "embedding_unavailable");
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
      if (data.length !== texts.length) throw fail("embedding_incomplete");
      const vectors = new Array<number[]>(texts.length);
      let dimension = target.dimension;
      data.forEach((item, position) => {
        const index = typeof item.index === "number" ? item.index : position;
        const vector = item.embedding;
        if (!Array.isArray(vector) || !vector.length || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
          throw fail("embedding_incomplete");
        }
        dimension ??= vector.length;
        if (vector.length !== dimension) {
          throw fail("embedding_dimension_mismatch", `ожидалось ${dimension}, пришло ${vector.length}`);
        }
        if (index < 0 || index >= texts.length) throw fail("embedding_incomplete");
        vectors[index] = vector as number[];
      });
      if (vectors.some((vector) => !vector)) throw fail("embedding_incomplete");
      return vectors;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async provider(target: EmbeddingTarget): Promise<ProviderProfile> {
    const providers = await this.source.providers();
    const chosen = target.providerId
      ? providers.find((item) => item.id === target.providerId)
      : (target.providerName ? providers.find((item) => item.name === target.providerName) : undefined)
        ?? providers.find((item) => item.protocol === "openai-compatible");
    if (!chosen) throw fail("embedding_provider_missing");
    if (chosen.protocol !== "openai-compatible") throw fail("embedding_protocol_unsupported");
    return chosen;
  }
}
