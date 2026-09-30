/**
 * Эмбеддинги роутера: прежняя цель, версии базы знаний и проверка модели.
 *
 *   eva/embeddings          прежняя цель из окружения, вектор pgvector (1536)
 *   eva/embeddings@v<N>     версия базы знаний: её провайдер, модель и
 *                           размерность; при отказе основного — запасной
 *
 * Проверка модели («Настройки → Проверить модель») считает вектор
 * фиксированной строки — не текста человека — и сообщает размерность,
 * задержку и, если задан второй провайдер, похожи ли их векторы: запасной
 * провайдер годится, только если он даёт то же пространство.
 */

import { EmbeddingError, type EmbeddingTarget, type RouterEmbeddings } from "./embeddings.js";
import { embeddingVersionOf, type EmbeddingVersionStore } from "./embedding-versions.js";

/** Строка проверки. Константа: в проверку не попадает ничего из данных людей. */
export const PROBE_TEXT = "Проверка модели эмбеддингов Evaself: договор аренды, Р-168-5УН, 2026.";

/** Порог сходства векторов основного и запасного провайдера: то же пространство. */
export const SAME_SPACE_SIMILARITY = 0.99;

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimension: number;
  /** Посчитал запасной провайдер: основной отказал. */
  fallback: boolean;
}

export interface ProbeRequest {
  providerId: string;
  model: string;
  dimension?: number | null;
  requestDimensions?: boolean;
  /** Второй провайдер — сравнить пространство (запасной для версии). */
  compare?: { providerId: string; model: string } | null;
}

export type ProbeResult =
  | {
    ok: true;
    dimension: number;
    latency_ms: number;
    compare?: { ok: true; dimension: number; latency_ms: number; similarity: number; same_space: boolean }
      | { ok: false; error_code: string; message: string };
  }
  | { ok: false; error_code: string; message: string };

/** Прежняя цель: только это имя или отсутствие поля `model`. */
const LEGACY_MODEL = "eva/embeddings";

export class EmbeddingRequestError extends Error {
  constructor(readonly code: "embedding_model_unknown" | "embedding_version_unknown" | "embedding_version_unusable", message: string) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    a += left[index]! ** 2;
    b += right[index]! ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

function describe(error: unknown): { error_code: string; message: string } {
  return error instanceof EmbeddingError
    ? { error_code: error.code, message: error.message }
    : { error_code: "embedding_unavailable", message: "Провайдер embeddings недоступен" };
}

export class EmbeddingService {
  constructor(
    private readonly embeddings: RouterEmbeddings,
    private readonly versions: EmbeddingVersionStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `model` из запроса: прежнее имя или версия базы знаний.
   *
   * Любое другое имя — отказ, а не прежняя цель: опечатка в номере версии
   * («@v0», «@v3;») дала бы векторы чужого пространства, и при той же
   * размерности их не отличила бы уже никакая проверка.
   */
  async embed(model: unknown, texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    const version = embeddingVersionOf(model);
    if (version === null && model !== undefined && model !== null && model !== LEGACY_MODEL) {
      throw new EmbeddingRequestError("embedding_model_unknown", "Модель embeddings: eva/embeddings или eva/embeddings@v<N>");
    }
    if (version === null) {
      return {
        vectors: await this.embeddings.embed(texts, signal),
        model: "eva/embeddings",
        dimension: this.embeddings.dimension,
        fallback: false,
      };
    }
    const row = await this.versions.get(version);
    if (!row) throw new EmbeddingRequestError("embedding_version_unknown", `Версии эмбеддингов ${version} нет`);
    // Выведенную версию больше никто не должен считать: её векторы уже
    // не ищутся, а поздний запрос стоил бы денег впустую.
    if (row.status === "retired" || row.status === "failed") {
      throw new EmbeddingRequestError("embedding_version_unusable", `Версия эмбеддингов ${version} выведена`);
    }
    const name = `eva/embeddings@v${version}`;
    try {
      return { vectors: await this.embeddings.embedWith(row.primary, texts, signal), model: name, dimension: row.primary.dimension, fallback: false };
    } catch (error) {
      if (!row.fallback || signal?.aborted) throw error;
      // Размерность у запасного та же — версия одна; несовпадение
      // размерности отвергнет его так же, как основного.
      return { vectors: await this.embeddings.embedWith(row.fallback, texts, signal), model: name, dimension: row.fallback.dimension, fallback: true };
    }
  }

  async probe(request: ProbeRequest, signal?: AbortSignal): Promise<ProbeResult> {
    const target: EmbeddingTarget = {
      providerId: request.providerId,
      model: request.model,
      dimension: request.dimension ?? null,
      requestDimensions: request.requestDimensions === true && Boolean(request.dimension),
    };
    const started = this.now();
    let primary: number[];
    try {
      [primary] = await this.embeddings.embedWith(target, [PROBE_TEXT], signal) as [number[]];
    } catch (error) {
      return { ok: false, ...describe(error) };
    }
    const result: ProbeResult = { ok: true, dimension: primary.length, latency_ms: Math.max(0, this.now() - started) };
    if (request.compare) {
      const compareStarted = this.now();
      try {
        const [other] = await this.embeddings.embedWith({
          providerId: request.compare.providerId,
          model: request.compare.model,
          dimension: primary.length,
          requestDimensions: target.requestDimensions ?? false,
        }, [PROBE_TEXT], signal) as [number[]];
        const similarity = Math.round(cosine(primary, other) * 10_000) / 10_000;
        result.compare = {
          ok: true,
          dimension: other.length,
          latency_ms: Math.max(0, this.now() - compareStarted),
          similarity,
          same_space: similarity >= SAME_SPACE_SIMILARITY,
        };
      } catch (error) {
        result.compare = { ok: false, ...describe(error) };
      }
    }
    return result;
  }
}
