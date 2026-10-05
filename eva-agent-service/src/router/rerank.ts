/**
 * Reranker через LLM Router (docs/knowledge-base.md, «Поиск (K4)»).
 *
 * Поиск по базе знаний собирает кандидатов из вектора, FTS и триграмм и
 * сливает их по RRF. Reranker — необязательный последний этап: модель
 * сравнивает запрос с каждым кандидатом целиком и даёт оценку
 * релевантности. Модуль в `src/router/` по той же причине, что и
 * эмбеддинги: любой выход к модели идёт через роутер (инвариант 16).
 *
 * Протокол — общий у Jina, Cohere, Voyage, vLLM и совместимых:
 * `POST {base_url}/rerank` с `{model, query, documents}`. Ответ бывает
 * `{results: [...]}` (Jina, Cohere, vLLM) или `{data: [...]}` (Voyage);
 * массив без обёртки тоже принимается. У элемента — `index` и
 * `relevance_score` или `score`. `top_n` не передаётся: Voyage называет
 * его иначе, а оценки нужны всем кандидатам — порядок выбирает
 * вызывающий. Text Embeddings Inference ждёт `texts` вместо `documents`
 * и напрямую не подходит.
 */

import { openAiCompatHeaders, resolveOpenAiCompat } from "./provider-manifests.js";
import type { EmbeddingProviderSource } from "./embeddings.js";
import type { ProviderProfile } from "./types.js";

/** Больше кандидатов за раз не принимается: reranker — для финального отбора. */
export const RERANK_DOCUMENT_LIMIT = 64;
/** Длина одного кандидата: фрагмент базы знаний короче, длиннее — ошибка вызывающего. */
export const RERANK_DOCUMENT_CHARS = 8_000;
export const RERANK_QUERY_CHARS = 1_000;
/** Reranker стоит в интерактивном ходе: дольше ждать нельзя, поиск обойдётся без него. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RerankTarget {
  providerId: string;
  model: string;
}

export type RerankErrorCode =
  | "rerank_provider_missing"
  | "rerank_protocol_unsupported"
  | "rerank_auth"
  | "rerank_not_found"
  | "rerank_bad_request"
  | "rerank_rate_limited"
  | "rerank_unavailable"
  | "rerank_timeout"
  | "rerank_invalid";

/**
 * Почему оценки не получены. Код уходит вызывающему; текст ответа
 * провайдера — нет: в нём бывает эхо запроса и кандидатов, а это текст
 * документов человека.
 */
export class RerankError extends Error {
  constructor(readonly code: RerankErrorCode, message: string) {
    super(message);
    this.name = "RerankError";
  }
}

const MESSAGES: Record<RerankErrorCode, string> = {
  rerank_provider_missing: "Провайдер reranker не найден или выключен",
  rerank_protocol_unsupported: "Провайдер не OpenAI-совместимый: reranker вызывается через /rerank",
  rerank_auth: "Провайдер отклонил ключ",
  rerank_not_found: "Модель или адрес /rerank у провайдера не найдены",
  rerank_bad_request: "Провайдер отклонил запрос: модель не умеет rerank",
  rerank_rate_limited: "Провайдер ограничил частоту запросов",
  rerank_unavailable: "Провайдер reranker недоступен",
  rerank_timeout: "Провайдер reranker не ответил вовремя",
  rerank_invalid: "Провайдер вернул оценки не по кандидатам",
};

function fail(code: RerankErrorCode, detail?: string): RerankError {
  return new RerankError(code, detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code]);
}

function codeForStatus(status: number): RerankErrorCode {
  if (status === 401 || status === 403) return "rerank_auth";
  if (status === 404) return "rerank_not_found";
  if (status === 429) return "rerank_rate_limited";
  if (status >= 500) return "rerank_unavailable";
  return "rerank_bad_request";
}

/**
 * Оценки по индексам кандидатов из любого из трёх форматов ответа.
 * Кандидат без оценки — `null`: провайдер вправе вернуть не всех, и
 * такой кандидат встаёт после оценённых, а не пропадает.
 */
export function parseRerankScores(payload: unknown, count: number): Array<number | null> {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as { results?: unknown; data?: unknown }).results ?? (payload as { data?: unknown }).data
      : null;
  if (!Array.isArray(list)) throw fail("rerank_invalid");
  const scores = new Array<number | null>(count).fill(null);
  for (const item of list) {
    if (!item || typeof item !== "object") throw fail("rerank_invalid");
    const { index, relevance_score: relevance, score } = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
    const value = typeof relevance === "number" ? relevance : score;
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= count
      || typeof value !== "number" || !Number.isFinite(value)) {
      throw fail("rerank_invalid");
    }
    scores[index as number] = value;
  }
  return scores;
}

export class RouterReranker {
  constructor(
    private readonly source: EmbeddingProviderSource,
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  /** Оценка каждого кандидата по порядку `documents`. */
  async rerank(target: RerankTarget, query: string, documents: readonly string[], signal?: AbortSignal): Promise<Array<number | null>> {
    if (!documents.length) return [];
    const provider = await this.provider(target);
    const call = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? Math.min(provider.request_timeout_ms, DEFAULT_TIMEOUT_MS);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let payload: unknown;
      try {
        const response = await call(`${provider.base_url.replace(/\/$/u, "")}/rerank`, {
          method: "POST",
          headers: {
            ...openAiCompatHeaders(
              resolveOpenAiCompat(provider.base_url, { ...provider.generation_defaults, ...provider.additional_parameters }),
              provider.api_key,
            ),
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: target.model, query, documents }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Тело отказа не читается: в нём бывает эхо кандидатов.
          await response.body?.cancel().catch(() => undefined);
          throw fail(codeForStatus(response.status), `HTTP ${response.status}`);
        }
        const body = await response.text();
        try {
          payload = JSON.parse(body);
        } catch {
          // Ответ пришёл, но не JSON: это неверный ответ, а не недоступность.
          throw fail("rerank_invalid");
        }
      } catch (error) {
        if (error instanceof RerankError) throw error;
        if (signal?.aborted) throw error;
        throw fail(controller.signal.aborted ? "rerank_timeout" : "rerank_unavailable");
      }
      return parseRerankScores(payload, documents.length);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async provider(target: RerankTarget): Promise<ProviderProfile> {
    const chosen = (await this.source.providers()).find((item) => item.id === target.providerId);
    if (!chosen) throw fail("rerank_provider_missing");
    if (chosen.protocol !== "openai-compatible") throw fail("rerank_protocol_unsupported");
    return chosen;
  }
}
