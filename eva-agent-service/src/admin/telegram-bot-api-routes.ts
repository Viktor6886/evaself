/**
 * Маршруты переключения сервера Bot API (раздел «Распознавание речи →
 * Файлы из Telegram»).
 *
 * Отдельный модуль, а не ещё десяток строк в `admin/server.ts`: тот за
 * тысячу строк и перечитывается целиком каждой сессией, которая его
 * касается. Права и аудит — общие, из server.ts: мутирующий маршрут
 * попадает в журнал ещё до аутентификации.
 *
 * Ключи API здесь не принимаются: их сохраняет форма интеграции Telegram
 * (`PUT /integrations/telegram/config`), а переключение берёт их оттуда.
 */

import type { FastifyInstance } from "fastify";

import type { TelegramBotApiModeService } from "./telegram-bot-api-mode.js";

export function registerTelegramBotApiRoutes(app: FastifyInstance, service: TelegramBotApiModeService): void {
  // В ответе нет ни ключей, ни токена — только признак «задан».
  app.get("/api/admin/v1/telegram/bot-api", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async () => await service.status());

  // Переключение пересоздаёт агент, media-service и admin-api — то же
  // право, что у перезапуска сервисов.
  app.post("/api/admin/v1/telegram/bot-api/mode", {
    config: { roles: ["owner", "admin"], sudoScope: "services:restart" },
  }, async (request) => {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    return await service.switchMode(body.mode);
  });
}
