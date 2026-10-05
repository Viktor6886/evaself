/**
 * Маршруты «База знаний» в панели: версии эмбеддингов и проверка модели
 * (docs/knowledge-base.md, K2), коллекции и документы общей базы,
 * построение индекса и сверка (K3b); поиск и статистика добавятся сюда же
 * следующими batch.
 *
 * Отдельный модуль, а не строки в `admin/server.ts`: тот за тысячу строк.
 * Права и аудит — общие, из server.ts.
 */

import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";

import { adminBadRequest } from "./errors.js";
import type { KnowledgeDocumentsService } from "./knowledge-documents-service.js";
import { KNOWLEDGE_ADMIN_MAX_BYTES } from "./knowledge-documents-service.js";
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

/**
 * Документы и индекс. Все маршруты трогают таблицы с `user_id`
 * (`knowledge_documents`, `knowledge_uploads`), поэтому объявляют
 * `tenantAccess`: без записи аудита граница арендатора их не пропустит.
 * Сами запросы — только к общей базе и к счётчикам личных баз.
 */
export function registerKnowledgeDocumentRoutes(app: FastifyInstance, service: KnowledgeDocumentsService): void {
  // Структура базы и индекса (коллекции, построение, включение версии) —
  // настройка установки: как у версий эмбеддингов, под settings:write.
  const param = (request: { params: unknown }, name: string): unknown => (request.params as Record<string, unknown>)[name];

  app.get("/api/admin/v1/knowledge/collections", { config: { roles: ["owner", "admin", "operator", "viewer"], tenantAccess: "cross-user" } }, async () => ({ collections: await service.collections() }));
  app.post("/api/admin/v1/knowledge/collections", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user", sudoScope: "settings:write" } }, async (request, reply) =>
    reply.code(201).send(await service.createCollection(request.body)));
  app.patch("/api/admin/v1/knowledge/collections/:id", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user", sudoScope: "settings:write" } }, async (request) =>
    await service.updateCollection(param(request, "id"), request.body));
  app.delete("/api/admin/v1/knowledge/collections/:id", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user", sudoScope: "settings:write" } }, async (request) =>
    await service.deleteCollection(param(request, "id")));

  app.get("/api/admin/v1/knowledge/documents", { config: { roles: ["owner", "admin", "operator", "viewer"], tenantAccess: "cross-user" } }, async (request) => await service.documents(request.query));
  app.post("/api/admin/v1/knowledge/documents/delete", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user" } }, async (request) => await service.deleteDocuments(request.body));
  app.post("/api/admin/v1/knowledge/documents/reindex", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user" } }, async (request) => await service.reindex(request.body));

  app.get("/api/admin/v1/knowledge/uploads", { config: { roles: ["owner", "admin", "operator", "viewer"], tenantAccess: "cross-user" } }, async (request) => ({ uploads: await service.uploads(request.query) }));
  app.post("/api/admin/v1/knowledge/uploads/:id/retry", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user" } }, async (request) => await service.retryUpload(param(request, "id")));

  // Загрузка файла — единственный маршрут панели с multipart: разбор
  // подключён только здесь, остальные маршруты по-прежнему принимают JSON
  // до 512 КБ. Коллекция и заменяемый документ — в строке запроса: так
  // они известны до того, как начнёт читаться файл.
  void app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { files: 1, fields: 0, parts: 1, fileSize: KNOWLEDGE_ADMIN_MAX_BYTES } });
    scoped.post("/api/admin/v1/knowledge/uploads", {
      config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
      bodyLimit: KNOWLEDGE_ADMIN_MAX_BYTES + 64 * 1024,
    }, async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      let part;
      try {
        part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: KNOWLEDGE_ADMIN_MAX_BYTES } });
      } catch {
        throw adminBadRequest("Ожидается файл в поле file", { field: "file" });
      }
      if (!part || part.fieldname !== "file" || !part.filename || !part.mimetype) {
        throw adminBadRequest("Ожидается файл в поле file", { field: "file" });
      }
      const file = part;
      return reply.code(202).send(await service.upload({
        collectionId: query.collection_id,
        replaces: query.replaces_document_id,
        name: file.filename,
        mime: file.mimetype,
        stream: file.file,
        truncated: () => file.file.truncated,
      }));
    });
  });

  app.get("/api/admin/v1/knowledge/index", { config: { roles: ["owner", "admin", "operator", "viewer"], tenantAccess: "cross-user" } }, async () => await service.indexOverview());
  app.post("/api/admin/v1/knowledge/index/reconcile", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user" } }, async (request, reply) =>
    reply.code(202).send(await service.reconcile()));
  app.post("/api/admin/v1/knowledge/embeddings/versions/:version/build", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user", sudoScope: "settings:write" } }, async (request, reply) =>
    reply.code(202).send(await service.build(param(request, "version"), request.body)));
  app.post("/api/admin/v1/knowledge/embeddings/versions/:version/activate", { config: { roles: ["owner", "admin"], tenantAccess: "cross-user", sudoScope: "settings:write" } }, async (request) =>
    await service.activate(param(request, "version"), request.body));
}
