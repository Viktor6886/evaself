/**
 * Маршруты «База знаний» в панели. Сейчас — версии эмбеддингов и проверка
 * модели (docs/knowledge-base.md, K2); документы, поиск и статистика
 * добавятся сюда же следующими batch.
 *
 * Отдельный модуль, а не строки в `admin/server.ts`: тот за тысячу строк.
 * Права и аудит — общие, из server.ts.
 */

import type { FastifyInstance } from "fastify";

import type { KnowledgeEmbeddingService } from "./knowledge-embedding-service.js";

export function registerKnowledgeRoutes(app: FastifyInstance, service: KnowledgeEmbeddingService): void {
  // Ключей и адресов провайдеров в ответе нет — только имена и id.
  app.get("/api/admin/v1/knowledge/embeddings", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async () => await service.overview());

  // Проверка тратит один короткий запрос к провайдеру и ничего не меняет,
  // но выбирать провайдера и модель — дело тех, кто может их завести.
  app.post("/api/admin/v1/knowledge/embeddings/probe", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => await service.probe(request.body));

  app.post("/api/admin/v1/knowledge/embeddings/versions", {
    config: { roles: ["owner", "admin"], sudoScope: "settings:write" },
  }, async (request, reply) => reply.code(201).send(await service.createVersion(request.body)));

  app.delete("/api/admin/v1/knowledge/embeddings/versions/:version", {
    config: { roles: ["owner", "admin"], sudoScope: "settings:write" },
  }, async (request) => await service.deleteVersion((request.params as { version?: string }).version));
}
