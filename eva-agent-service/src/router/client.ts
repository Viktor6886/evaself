import { recordKnowledgeStage } from "../knowledge/metrics.js";

/** Больше роутер за один запрос не принимает (`/embeddings`). */
export const ROUTER_EMBEDDING_BATCH_LIMIT = 64;

/** Отказ роутера с кодом из ответа: панели нужен код, а не только статус. */
export class LlmRouterError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "LlmRouterError";
  }
}

export interface EmbedManyOptions {
  /** Версия эмбеддингов базы знаний (docs/knowledge-base.md). */
  version: number;
  /** Сколько векторов ждать: вектор другой длины — отказ, а не запись. */
  dimension: number;
  /** Текстов на запрос; не больше 64. */
  batchSize?: number;
  signal?: AbortSignal;
}

export interface EmbeddingProbeRequest {
  provider_id: string;
  model: string;
  dimension?: number | null;
  request_dimensions?: boolean;
  compare?: { provider_id: string; model: string } | null;
}

/** Canonical HTTP client for callers that live in the agent-service process. */
export class LlmRouterClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly call: typeof fetch = fetch) {}

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    const response = await this.call(`${this.baseUrl.replace(/\/+$/u, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // Код отказа — короткое имя из словаря роутера. Текст ответа не
      // пересказывается: у маршрутов диалога в нём бывает ответ
      // провайдера, а с ним и эхо текста человека.
      let type: unknown;
      try {
        type = (JSON.parse(text) as { error?: { type?: unknown } }).error?.type;
      } catch {
        type = undefined;
      }
      const code = typeof type === "string" && /^[a-z_]{1,64}$/u.test(type) ? type : "router_error";
      throw new LlmRouterError(response.status, code, `LLM Router HTTP ${response.status} (${code})`);
    }
    return JSON.parse(text) as Record<string, any>;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const body = await this.request("/embeddings", { model: "eva/embeddings", input: [text] }, signal);
    const vector: unknown = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 1536 || vector.some((x) => typeof x !== "number")) throw new Error("LLM Router embeddings invalid");
    return vector as number[];
  }

  /**
   * Прежние векторы pgvector (1536) пачкой одним запросом — вместо запроса
   * на каждый фрагмент. Не больше 64 текстов: столько принимает роутер.
   */
  async embedLegacyMany(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    if (texts.length > ROUTER_EMBEDDING_BATCH_LIMIT) throw new Error("embedding_batch_too_large");
    const body = await this.request("/embeddings", { model: "eva/embeddings", input: texts }, signal);
    const data: unknown = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new Error("embedding_incomplete");
    return data.map((item, index) => {
      const vector: unknown = (item as { embedding?: unknown; index?: unknown }).embedding;
      if ((item as { index?: unknown }).index !== index || !Array.isArray(vector) || vector.length !== 1536
        || vector.some((value) => typeof value !== "number")) {
        throw new Error("LLM Router embeddings invalid");
      }
      return vector as number[];
    });
  }

  /**
   * Векторы многих текстов версии эмбеддингов, пачками.
   *
   * Порядок ответа — порядок текстов; неполный ответ или вектор чужой
   * длины — отказ всей операции: записать вектор не того фрагмента хуже,
   * чем не записать ничего.
   */
  async embedMany(texts: readonly string[], options: EmbedManyOptions): Promise<number[][]> {
    if (!Number.isSafeInteger(options.version) || options.version < 1) throw new Error("embedding_version_invalid");
    const requested = options.batchSize !== undefined && Number.isFinite(options.batchSize) ? Math.floor(options.batchSize) : 32;
    const size = Math.min(Math.max(requested, 1), ROUTER_EMBEDDING_BATCH_LIMIT);
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += size) {
      const batch = texts.slice(start, start + size);
      const started = Date.now();
      let failed = true;
      try {
        const body = await this.request("/embeddings", { model: `eva/embeddings@v${options.version}`, input: batch }, options.signal);
        const data: unknown = body.data;
        if (!Array.isArray(data) || data.length !== batch.length) throw new Error("embedding_incomplete");
        for (const [index, item] of data.entries()) {
          const vector: unknown = (item as { embedding?: unknown; index?: unknown }).embedding;
          if ((item as { index?: unknown }).index !== index || !Array.isArray(vector) || vector.length !== options.dimension
            || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
            throw new Error("embedding_dimension_mismatch");
          }
          vectors.push(vector as number[]);
        }
        failed = false;
      } finally {
        recordKnowledgeStage("embedding", Date.now() - started, failed);
      }
    }
    // Последняя граница: вектор на каждый текст, иначе порядок уже не
    // сопоставить с фрагментами.
    if (vectors.length !== texts.length) throw new Error("embedding_incomplete");
    return vectors;
  }

  /**
   * Оценки reranker по кандидатам — в порядке `documents`; `null` —
   * кандидата провайдер не оценил. Задержка и отказы — метрика этапа
   * `rerank`.
   */
  async rerank(
    request: { providerId: string; model: string; query: string; documents: readonly string[] },
    signal?: AbortSignal,
  ): Promise<Array<number | null>> {
    if (!request.documents.length) return [];
    const started = Date.now();
    let failed = true;
    try {
      const body = await this.request("/rerank", {
        provider_id: request.providerId,
        model: request.model,
        query: request.query,
        documents: request.documents,
      }, signal);
      const results: unknown = body.results;
      if (!Array.isArray(results)) throw new Error("rerank_invalid");
      const scores = new Array<number | null>(request.documents.length).fill(null);
      for (const item of results) {
        const { index, relevance_score: score } = (item ?? {}) as { index?: unknown; relevance_score?: unknown };
        if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= scores.length) throw new Error("rerank_invalid");
        if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) throw new Error("rerank_invalid");
        scores[index as number] = score as number | null;
      }
      failed = false;
      return scores;
    } finally {
      recordKnowledgeStage("rerank", Date.now() - started, failed);
    }
  }

  /** «Проверить модель»: размерность, задержка и совместимость запасного провайдера. */
  async probeEmbeddings(request: EmbeddingProbeRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.request("/embeddings/probe", request, signal);
  }

  async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const response = await this.request("/chat/completions", body, signal);
    return String(response.choices?.[0]?.message?.content ?? "");
  }
}
