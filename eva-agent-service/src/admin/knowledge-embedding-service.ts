/**
 * Версии эмбеддингов базы знаний в панели («База знаний → Настройки»).
 *
 * Версия — пространство векторов: провайдер из реестра Router, модель,
 * размерность, мера близости (docs/knowledge-base.md). Здесь её заводят и
 * проверяют; строит индекс и переключает поиск индексация (K3, K7).
 *
 * Версия заводится только после удачной проверки модели: размерность
 * берётся из ответа провайдера, а не со слов администратора, а запасной
 * провайдер принимается, только если его векторы лежат в том же
 * пространстве. Иначе ошибка всплыла бы через час переиндексации.
 *
 * Модель и провайдер вызываются через агента и LLM Router: у admin-api нет
 * своего пути к моделям (инвариант 16).
 */

import type pg from "pg";

import { adminBadRequest, adminConflict, adminNotFound } from "./errors.js";
import type { InternalAgentClient } from "./provider-service.js";

const DISTANCES = new Set(["Cosine", "Dot", "Euclid"]);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;

export interface EmbeddingProviderOption {
  id: string;
  name: string;
  /** Модель диалога провайдера — подсказка, чей это аккаунт; не модель эмбеддингов. */
  chat_model: string;
}

export interface EmbeddingVersionView {
  version: number;
  provider_id: string;
  provider_name: string | null;
  model: string;
  dimension: number;
  distance: string;
  request_dimensions: boolean;
  fallback_provider_id: string | null;
  fallback_provider_name: string | null;
  fallback_model: string | null;
  hnsw_m: number;
  hnsw_ef_construct: number;
  on_disk: boolean;
  status: string;
  error_code: string | null;
  created_at: string;
  built_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
}

interface ProbeInput {
  provider_id: string;
  model: string;
  dimension: number | null;
  request_dimensions: boolean;
  compare: { provider_id: string; model: string } | null;
}

type ProbeResult = Record<string, unknown> & { ok?: unknown; dimension?: unknown; compare?: unknown };

function text(value: unknown, field: string, pattern?: RegExp): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || (pattern && !pattern.test(result))) throw adminBadRequest(`Поле ${field} задано неверно`, { field });
  return result;
}

function integer(value: unknown, field: string, min: number, max: number, fallback: number | null): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw adminBadRequest(`Поле ${field}: целое от ${min} до ${max}`, { field });
  }
  return number;
}

export class KnowledgeEmbeddingService {
  constructor(
    private readonly pool: Pick<pg.Pool, "query" | "connect">,
    private readonly agent: Pick<InternalAgentClient, "request">,
  ) {}

  /** Версии, активная версия и провайдеры, которыми можно считать векторы. */
  async overview(): Promise<{ active: number | null; versions: EmbeddingVersionView[]; providers: EmbeddingProviderOption[] }> {
    const [versions, providers] = await Promise.all([this.versions(), this.providers()]);
    return {
      active: versions.find((row) => row.status === "active")?.version ?? null,
      versions,
      providers,
    };
  }

  /** «Проверить модель»: размерность, задержка, совместимость запасного. */
  async probe(body: unknown): Promise<ProbeResult> {
    return await this.runProbe(await this.probeInput(body));
  }

  /**
   * Завести версию-черновик. Проверка модели обязательна и идёт до записи:
   * версия с неверной размерностью или чужим запасным провайдером не
   * заводится вовсе.
   */
  async createVersion(body: unknown): Promise<EmbeddingVersionView> {
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const probeInput = await this.probeInput(input);
    const distance = input.distance === undefined ? "Cosine" : String(input.distance);
    if (!DISTANCES.has(distance)) throw adminBadRequest("Мера близости: Cosine, Dot или Euclid", { field: "distance" });
    const hnswM = integer(input.hnsw_m, "hnsw_m", 4, 128, 16)!;
    const efConstruct = integer(input.hnsw_ef_construct, "hnsw_ef_construct", 16, 1024, 100)!;
    const onDisk = input.on_disk === true;

    const probe = await this.runProbe(probeInput);
    if (probe.ok !== true || typeof probe.dimension !== "number") {
      throw adminBadRequest("Модель не прошла проверку: версия не заведена", { probe });
    }
    const dimension = probe.dimension;
    if (probeInput.dimension !== null && probeInput.dimension !== dimension) {
      throw adminBadRequest(
        `Модель возвращает векторы размерности ${dimension}, а не ${probeInput.dimension}`,
        { field: "dimension", probe },
      );
    }
    if (probeInput.compare) {
      const compare = probe.compare as { ok?: unknown; same_space?: unknown } | undefined;
      if (compare?.ok !== true || compare.same_space !== true) {
        throw adminBadRequest(
          "Запасной провайдер даёт другие векторы: он годится, только если это та же модель у другого поставщика",
          { field: "fallback_model", probe },
        );
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Номер версии — следующий по порядку; два одновременных создания
      // не должны получить один номер.
      await client.query("LOCK TABLE knowledge_embedding_versions IN SHARE ROW EXCLUSIVE MODE");
      const { rows } = await client.query<{ version: number }>(
        `INSERT INTO knowledge_embedding_versions
           (version, provider_id, model, dimension, distance, request_dimensions,
            fallback_provider_id, fallback_model, hnsw_m, hnsw_ef_construct, on_disk, status)
         SELECT COALESCE(max(version), 0) + 1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft'
           FROM knowledge_embedding_versions
         RETURNING version`,
        [
          probeInput.provider_id, probeInput.model, dimension, distance, probeInput.request_dimensions,
          probeInput.compare?.provider_id ?? null, probeInput.compare?.model ?? null,
          hnswM, efConstruct, onDisk,
        ],
      );
      await client.query("COMMIT");
      const created = (await this.versions()).find((row) => row.version === rows[0]!.version);
      if (!created) throw adminNotFound("Версия эмбеддингов не найдена");
      return created;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Удалить версию, которую ещё не строили или построить не удалось.
   * Построенную, активную и выведенную удаляет смена модели (K7): у них
   * есть коллекции Qdrant, и удалять их надо вместе.
   */
  async deleteVersion(value: unknown): Promise<{ deleted: number }> {
    const version = integer(value, "version", 1, 999_999, null);
    if (version === null) throw adminBadRequest("Номер версии обязателен", { field: "version" });
    const { rows } = await this.pool.query<{ status: string }>(
      "SELECT status FROM knowledge_embedding_versions WHERE version = $1",
      [version],
    );
    if (!rows[0]) throw adminNotFound("Версия эмбеддингов не найдена");
    if (rows[0].status !== "draft" && rows[0].status !== "failed") {
      throw adminConflict("Удалить можно только версию-черновик или неудавшуюся: у остальных есть индекс", { status: rows[0].status });
    }
    await this.pool.query(
      "DELETE FROM knowledge_embedding_versions WHERE version = $1 AND status IN ('draft', 'failed')",
      [version],
    );
    return { deleted: version };
  }

  private async probeInput(body: unknown): Promise<ProbeInput> {
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const providerId = text(input.provider_id, "provider_id");
    const model = text(input.model, "model", MODEL_NAME);
    const dimension = integer(input.dimension, "dimension", 8, 8192, null);
    const requestDimensions = input.request_dimensions === true;
    if (requestDimensions && dimension === null) {
      throw adminBadRequest("Чтобы укоротить векторы, задайте размерность", { field: "dimension" });
    }
    const fallbackProvider = typeof input.fallback_provider_id === "string" && input.fallback_provider_id.trim()
      ? input.fallback_provider_id.trim()
      : null;
    const fallbackModel = typeof input.fallback_model === "string" && input.fallback_model.trim()
      ? text(input.fallback_model, "fallback_model", MODEL_NAME)
      : null;
    if ((fallbackProvider === null) !== (fallbackModel === null)) {
      throw adminBadRequest("Запасной провайдер задаётся вместе с моделью", { field: "fallback_model" });
    }
    const usable = new Set((await this.providers()).map((provider) => provider.id));
    for (const [field, id] of [["provider_id", providerId], ["fallback_provider_id", fallbackProvider]] as const) {
      if (id !== null && !usable.has(id)) {
        throw adminBadRequest("Провайдер не найден, выключен или не OpenAI-совместимый", { field });
      }
    }
    return {
      provider_id: providerId,
      model,
      dimension,
      request_dimensions: requestDimensions,
      compare: fallbackProvider && fallbackModel ? { provider_id: fallbackProvider, model: fallbackModel } : null,
    };
  }

  private async runProbe(input: ProbeInput): Promise<ProbeResult> {
    const result = await this.agent.request("/v1/knowledge/embeddings/probe", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return (result ?? { ok: false, error_code: "embedding_unavailable", message: "Проверка не вернула ответ" }) as ProbeResult;
  }

  private async providers(): Promise<EmbeddingProviderOption[]> {
    // Embeddings считаются только OpenAI-совместимым /embeddings; ключи и
    // адреса провайдеров в ответ панели не попадают.
    const { rows } = await this.pool.query<{ id: string; name: string; model: string }>(
      `SELECT id, name, model
         FROM llm_providers
        WHERE enabled AND protocol = 'openai-compatible'
        ORDER BY priority, lower(name)`,
    );
    return rows.map((row) => ({ id: String(row.id), name: row.name, chat_model: row.model }));
  }

  private async versions(): Promise<EmbeddingVersionView[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT v.version, v.provider_id, p.name AS provider_name, v.model, v.dimension, v.distance,
              v.request_dimensions, v.fallback_provider_id, f.name AS fallback_provider_name,
              v.fallback_model, v.hnsw_m, v.hnsw_ef_construct, v.on_disk, v.status, v.error_code,
              v.created_at, v.built_at, v.activated_at, v.retired_at
         FROM knowledge_embedding_versions v
         LEFT JOIN llm_providers p ON p.id = v.provider_id
         LEFT JOIN llm_providers f ON f.id = v.fallback_provider_id
        ORDER BY v.version DESC`,
    );
    const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : value ? String(value) : null;
    return rows.map((row) => ({
      version: Number(row.version),
      provider_id: String(row.provider_id),
      provider_name: row.provider_name ? String(row.provider_name) : null,
      model: String(row.model),
      dimension: Number(row.dimension),
      distance: String(row.distance),
      request_dimensions: row.request_dimensions === true,
      fallback_provider_id: row.fallback_provider_id ? String(row.fallback_provider_id) : null,
      fallback_provider_name: row.fallback_provider_name ? String(row.fallback_provider_name) : null,
      fallback_model: row.fallback_model ? String(row.fallback_model) : null,
      hnsw_m: Number(row.hnsw_m),
      hnsw_ef_construct: Number(row.hnsw_ef_construct),
      on_disk: row.on_disk === true,
      status: String(row.status),
      error_code: row.error_code ? String(row.error_code) : null,
      created_at: iso(row.created_at) ?? "",
      built_at: iso(row.built_at),
      activated_at: iso(row.activated_at),
      retired_at: iso(row.retired_at),
    }));
  }
}
