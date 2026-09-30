/**
 * Личная база знаний в Mini App: список своих документов, их состояние,
 * удаление одного документа и очистка всей базы (docs/knowledge-base.md, K5a).
 *
 * Загрузка файла — прежний маршрут `POST /knowledge/uploads` в `routes.ts`.
 * Сервиса нет — функция выключена (EVA_KNOWLEDGE_UPLOADS), и `GET /knowledge`
 * отвечает `enabled: false`: по нему Mini App прячет вкладку.
 */

import type { FastifyInstance } from "fastify";

import { badRequest, notFound } from "../errors.js";

/** Операции по telegram id; сопоставление с внутренним пользователем — у сервиса. */
export interface KnowledgeDocumentsPublic {
  overview(telegramId: number): Promise<{ documents: unknown[]; total: number; uploads: unknown[] }>;
  remove(telegramId: number, documentId: string): Promise<{ deleted: boolean }>;
  clear(telegramId: number): Promise<{ deleted: number }>;
}

/** Предел файла, который Mini App показывает до выбора: тот же, что у маршрута загрузки. */
export const KNOWLEDGE_PUBLIC_MAX_BYTES = 10 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerKnowledgePublicRoutes(
  publicApp: FastifyInstance,
  knowledge: KnowledgeDocumentsPublic | undefined,
  telegramIdOf: (request: unknown) => number,
): void {
  const service = (): KnowledgeDocumentsPublic => {
    if (!knowledge) throw badRequest("Загрузка знаний отключена");
    return knowledge;
  };
  publicApp.get("/knowledge", async (request) => {
    if (!knowledge) return { enabled: false, documents: [], total: 0, uploads: [] };
    return { enabled: true, max_bytes: KNOWLEDGE_PUBLIC_MAX_BYTES, ...(await knowledge.overview(telegramIdOf(request))) };
  });
  publicApp.delete("/knowledge/documents/:id", async (request) => {
    const knowledgeService = service();
    const id = String((request.params as { id?: unknown }).id ?? "");
    if (!UUID.test(id)) throw badRequest("Некорректный идентификатор документа");
    const result = await knowledgeService.remove(telegramIdOf(request), id);
    if (!result.deleted) throw notFound("Документ не найден");
    return result;
  });
  // Очистка необратима: тело с явным подтверждением, а не голый DELETE,
  // который мог бы отправить случайный повтор запроса.
  publicApp.delete("/knowledge/documents", async (request) => {
    const knowledgeService = service();
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    if (body.confirm !== true) throw badRequest("Подтвердите очистку базы знаний");
    return await knowledgeService.clear(telegramIdOf(request));
  });
}
