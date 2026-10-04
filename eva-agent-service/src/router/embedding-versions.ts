/**
 * Версии эмбеддингов базы знаний — то, что роутер считает по имени
 * `eva/embeddings@v<N>` (docs/knowledge-base.md).
 *
 * Версия фиксирует пространство векторов: провайдера из реестра Router,
 * модель, размерность. Запасной провайдер — та же модель у другого
 * поставщика: его векторы лежат в том же пространстве, поэтому при отказе
 * основного индексация и поиск продолжаются без смены версии.
 *
 * Отдельным модулем, а не методом `RouterStore`: тот и так за шестьсот
 * строк и перечитывается целиком каждой сессией, которая его касается.
 */

import type pg from "pg";

import type { EmbeddingTarget } from "./embeddings.js";

export interface EmbeddingVersion {
  version: number;
  primary: EmbeddingTarget & { providerId: string; dimension: number };
  fallback: (EmbeddingTarget & { providerId: string; dimension: number }) | null;
  status: string;
}

/** `eva/embeddings@v3` → 3; прежнее `eva/embeddings` и чужие имена → null. */
export function embeddingVersionOf(model: unknown): number | null {
  const match = typeof model === "string" ? /^eva\/embeddings@v([1-9][0-9]{0,5})$/u.exec(model) : null;
  return match ? Number(match[1]) : null;
}

/** Пространство версии неизменно; статус при K7 меняется сразу. */
const CACHE_TTL_MS = 30_000;

export class EmbeddingVersionStore {
  private cache = new Map<number, { at: number; row: EmbeddingVersion }>();

  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async get(version: number): Promise<EmbeddingVersion | null> {
    const cached = this.cache.get(version);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      // Кэшируется конфигурация пространства, но не разрешение считать.
      const { rows } = await this.pool.query<{ status: string }>(
        "SELECT status FROM knowledge_embedding_versions WHERE version = $1", [version],
      );
      if (!rows[0]) { this.cache.delete(version); return null; }
      return { ...cached.row, status: rows[0].status };
    }
    const { rows } = await this.pool.query<{
      version: number;
      provider_id: string;
      model: string;
      dimension: number;
      request_dimensions: boolean;
      fallback_provider_id: string | null;
      fallback_model: string | null;
      status: string;
    }>(
      `SELECT version, provider_id, model, dimension, request_dimensions,
              fallback_provider_id, fallback_model, status
         FROM knowledge_embedding_versions
        WHERE version = $1`,
      [version],
    );
    const row = rows[0];
    const parsed: EmbeddingVersion | null = row
      ? {
        version: row.version,
        status: row.status,
        primary: {
          providerId: String(row.provider_id),
          model: row.model,
          dimension: row.dimension,
          requestDimensions: row.request_dimensions,
        },
        fallback: row.fallback_provider_id && row.fallback_model
          ? {
            providerId: String(row.fallback_provider_id),
            model: row.fallback_model,
            dimension: row.dimension,
            requestDimensions: row.request_dimensions,
          }
          : null,
      }
      : null;
    // Отсутствие версии не кэшируется: её могли завести секунду назад, и
    // индексация новой версии не должна полминуты получать «версии нет».
    if (parsed) this.cache.set(version, { at: Date.now(), row: parsed });
    return parsed;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
