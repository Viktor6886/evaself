/**
 * Внутренние маршруты базы знаний (`/v1`, закрыты ключом агента).
 *
 * Панель ходит к роутеру через агента, как и проверка провайдера: у
 * admin-api нет ключа роутера, и заводить ему второй путь к моделям
 * незачем (инвариант 16).
 */

import type { FastifyInstance } from "fastify";

import { EvaError } from "../errors.js";
import { LlmRouterError, type EmbeddingProbeRequest, type LlmRouterClient } from "../router/client.js";

export interface KnowledgeRoutesContext {
  router: Pick<LlmRouterClient, "probeEmbeddings">;
}

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: KnowledgeRoutesContext): void {
  /**
   * «Проверить модель»: роутер считает вектор фиксированной строки у
   * выбранного провайдера и сообщает размерность и задержку. Текст
   * человека сюда не попадает — тело запроса только про модель.
   */
  app.post("/v1/knowledge/embeddings/probe", async (request) => {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const compare = body.compare && typeof body.compare === "object" && !Array.isArray(body.compare)
      ? body.compare as Record<string, unknown>
      : null;
    const probe: EmbeddingProbeRequest = {
      provider_id: String(body.provider_id ?? ""),
      model: String(body.model ?? ""),
      dimension: body.dimension === undefined || body.dimension === null ? null : Number(body.dimension),
      request_dimensions: body.request_dimensions === true,
      compare: compare ? { provider_id: String(compare.provider_id ?? ""), model: String(compare.model ?? "") } : null,
    };
    try {
      return await ctx.router.probeEmbeddings(probe);
    } catch (error) {
      if (error instanceof LlmRouterError && error.status === 400) {
        throw new EvaError("Проверка модели: провайдер, модель или размерность заданы неверно", { code: "embedding_probe_invalid", statusCode: 400 });
      }
      throw new EvaError("LLM Router недоступен", { code: "router_unavailable", statusCode: 502 });
    }
  });
}
