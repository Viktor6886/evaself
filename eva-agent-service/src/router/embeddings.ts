/**
 * Векторизация через LLM Router.
 *
 * Модуль лежит внутри `src/router/` не для порядка в каталогах: любой
 * выход к модели идёт через роутер (инвариант 16), и отдельный клиент
 * рядом с ним был бы вторым путём наружу — с собственными таймаутами,
 * собственным ключом и собственной, никем не учтённой стоимостью.
 *
 * Провайдер берётся из того же реестра, что и провайдеры диалога.
 * Отдельного набора настроек для embeddings не заводится: у роутера уже
 * есть и адрес, и ключ, и таймаут.
 */

import type { ProviderProfile } from "./types.js";

export interface EmbeddingProviderSource {
  providers(): Promise<ProviderProfile[]>;
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

  /**
   * Посчитать векторы.
   *
   * Возвращается ровно столько векторов, сколько пришло текстов, и в том
   * же порядке. Частичный ответ — отказ: молча выровнять его значило бы
   * записать вектор одного факта в другой.
   */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const provider = await this.provider();
    if (!provider) throw new Error("Провайдер embeddings не настроен");
    const call = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("embeddings timeout")),
      this.options.timeoutMs ?? provider.request_timeout_ms,
    );
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    try {
      const response = await call(`${provider.base_url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.api_key}`,
        },
        body: JSON.stringify({ model: this.options.model, input: texts }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
      const data = payload.data ?? [];
      if (data.length !== texts.length) throw new Error("embeddings вернул неполный ответ");
      const vectors = new Array<number[]>(texts.length);
      data.forEach((item, position) => {
        const index = typeof item.index === "number" ? item.index : position;
        const vector = item.embedding ?? [];
        if (vector.length !== this.options.dimension) {
          throw new Error("embeddings вернул чужую размерность");
        }
        vectors[index] = vector;
      });
      if (vectors.some((vector) => !vector)) throw new Error("embeddings пропустил текст");
      return vectors;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async provider(): Promise<ProviderProfile | null> {
    const providers = await this.source.providers();
    const named = this.options.providerName
      ? providers.find((item) => item.name === this.options.providerName)
      : undefined;
    return named
      ?? providers.find((item) => item.protocol === "openai-compatible")
      ?? null;
  }
}
