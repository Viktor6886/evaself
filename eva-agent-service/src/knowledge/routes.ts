/**
 * Внутренние маршруты базы знаний (`/v1`, закрыты ключом агента).
 *
 * Панель ходит к роутеру через агента, как и проверка провайдера: у
 * admin-api нет ключа роутера, и заводить ему второй путь к моделям
 * незачем (инвариант 16).
 */

import type { FastifyInstance } from "fastify";

import type { Database } from "../db.js";
import { EvaError } from "../errors.js";
import { LlmRouterError, type EmbeddingProbeRequest, type LlmRouterClient } from "../router/client.js";
import { embeddingText } from "./chunking.js";
import { QdrantError } from "./qdrant-client.js";
import type { KnowledgeScope, KnowledgeVectorStore } from "./vector-store.js";

export interface KnowledgeRoutesContext {
  router: Pick<LlmRouterClient, "probeEmbeddings">;
  /** Для проверки пространства по построенному индексу. */
  db?: Pick<Database, "query" | "withSystemScope">;
  /** Индекс Qdrant; null — не настроен, сравнивать можно только с основным провайдером. */
  vectors?: Pick<KnowledgeVectorStore, "scrollPoints" | "vectorsOf"> | null;
}

/** Фрагментов индекса в проверке пространства: столько принимает роутер. */
const REFERENCE_SAMPLES = 3;

type Body = Record<string, unknown>;

function record(value: unknown): Body {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Body : {};
}

async function probe(ctx: KnowledgeRoutesContext, request: EmbeddingProbeRequest): Promise<Body> {
  try {
    return await ctx.router.probeEmbeddings(request);
  } catch (error) {
    if (error instanceof LlmRouterError && error.status === 400) {
      throw new EvaError("Проверка модели: провайдер, модель или размерность заданы неверно", { code: "embedding_probe_invalid", statusCode: 400 });
    }
    throw new EvaError("LLM Router недоступен", { code: "router_unavailable", statusCode: 502 });
  }
}

/**
 * Образцы построенной версии: фрагменты с векторами, которые лежат в
 * Qdrant. Сначала общая база — справочные материалы, а не документы
 * людей; личные — только если общих точек нет. Текст уходит только
 * провайдеру, которого проверяют (как при индексации), и в ответ не
 * попадает.
 */
async function indexReference(ctx: KnowledgeRoutesContext, version: number, dimension: number): Promise<Array<{ text: string; vector: number[] }>> {
  if (!ctx.vectors || !ctx.db) return [];
  const vectors = new Map<number, number[]>();
  for (const scope of ["global", "private"] as KnowledgeScope[]) {
    if (vectors.size >= REFERENCE_SAMPLES) break;
    try {
      const page = await ctx.vectors.scrollPoints(scope, version, null, REFERENCE_SAMPLES - vectors.size);
      const ids = page.points.map((point) => Number(point.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (!ids.length) continue;
      for (const [id, vector] of await ctx.vectors.vectorsOf(scope, version, ids)) {
        if (vector.length === dimension) vectors.set(id, vector);
      }
    } catch (error) {
      // Коллекции этой части базы нет — точек в ней тоже нет.
      if (error instanceof QdrantError && error.code === "qdrant_not_found") continue;
      throw new EvaError("Qdrant недоступен: сравнить модель с индексом нельзя", { code: "qdrant_unavailable", statusCode: 503 });
    }
  }
  if (!vectors.size) return [];
  const { rows } = await ctx.db.withSystemScope("knowledge.space_check", async () => await ctx.db!.query<{
    id: string; content: string; section: string | null; subsection: string | null; heading: string | null;
  }>(
    `SELECT id::text AS id, content, section, subsection, heading
       FROM knowledge_chunks
       -- tenant: system — образцы индекса для проверки модели; текст уходит только проверяемому провайдеру эмбеддингов
      WHERE id = ANY($1::bigint[])`,
    [[...vectors.keys()]],
  ), { crossUser: true });
  // Вектор посчитан по тексту с путём заголовков — так же считается и образец.
  return rows.flatMap((row) => {
    const vector = vectors.get(Number(row.id));
    return vector ? [{ text: embeddingText(row), vector }] : [];
  });
}

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: KnowledgeRoutesContext): void {
  /**
   * «Проверить модель»: роутер считает вектор фиксированной строки у
   * выбранного провайдера и сообщает размерность и задержку. Текст
   * человека сюда не попадает — тело запроса только про модель.
   */
  app.post("/v1/knowledge/embeddings/probe", async (request) => {
    const body = record(request.body);
    const compare = body.compare && typeof body.compare === "object" && !Array.isArray(body.compare)
      ? body.compare as Body
      : null;
    return await probe(ctx, {
      provider_id: String(body.provider_id ?? ""),
      model: String(body.model ?? ""),
      dimension: body.dimension === undefined || body.dimension === null ? null : Number(body.dimension),
      request_dimensions: body.request_dimensions === true,
      compare: compare ? { provider_id: String(compare.provider_id ?? ""), model: String(compare.model ?? "") } : null,
    });
  });

  /**
   * То же ли пространство у модели, что у построенной версии: можно ли
   * подключить её запасным провайдером без переиндексации. Сравнение —
   * с векторами, которые уже лежат в Qdrant: основной провайдер для этого
   * не нужен, а запасной и подключают, когда он не отвечает. Индекс пуст —
   * сравнение с основным, как при заведении версии. В ответе — только
   * сходство и код, без текста.
   */
  app.post("/v1/knowledge/embeddings/versions/:version/space-check", async (request) => {
    const version = Number((request.params as { version?: string }).version);
    const body = record(request.body);
    const providerId = typeof body.provider_id === "string" ? body.provider_id.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!Number.isSafeInteger(version) || version < 1 || !providerId || !model) {
      throw new EvaError("Проверка пространства: версия, провайдер или модель заданы неверно", { code: "embedding_probe_invalid", statusCode: 400 });
    }
    if (!ctx.db) throw new EvaError("База недоступна", { code: "database_unavailable", statusCode: 503 });
    const { rows } = await ctx.db.query<{ provider_id: string; model: string; dimension: number; request_dimensions: boolean }>(
      "SELECT provider_id, model, dimension, request_dimensions FROM knowledge_embedding_versions WHERE version = $1",
      [version],
    );
    const space = rows[0];
    if (!space) throw new EvaError("Версии эмбеддингов нет", { code: "embedding_version_unknown", statusCode: 404 });
    const dimension = Number(space.dimension);
    const reference = await indexReference(ctx, version, dimension);
    const verdict = (basis: "index" | "primary", result: Body, part: unknown) => {
      const check = record(part);
      const code = (value: unknown) => typeof value === "string" && /^[a-z_]{1,64}$/u.test(value) ? value : "embedding_unavailable";
      if (result.ok !== true) return { ok: false, basis, same_space: false, similarity: null, error_code: code(result.error_code) };
      if (check.ok !== true) return { ok: false, basis, same_space: false, similarity: null, error_code: code(check.error_code) };
      return { ok: true, basis, same_space: check.same_space === true, similarity: Number(check.similarity), error_code: null };
    };
    if (reference.length) {
      const result = await probe(ctx, { provider_id: providerId, model, dimension, request_dimensions: space.request_dimensions === true, reference });
      return { ...verdict("index", result, result.reference), samples: reference.length };
    }
    const result = await probe(ctx, {
      provider_id: String(space.provider_id), model: space.model, dimension, request_dimensions: space.request_dimensions === true,
      compare: { provider_id: providerId, model },
    });
    return { ...verdict("primary", result, result.compare), samples: 0 };
  });
}
