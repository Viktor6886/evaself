/**
 * OSINT в Mini App: посмотреть свои исследования, отчёт, остановить и
 * удалить.
 *
 * Начать исследование отсюда нельзя: условие исключения из инварианта 30 —
 * явная просьба человека в разговоре с заявленной целью и подтверждением
 * действия. Кнопка «найти» в интерфейсе обходила бы и разговор, и
 * подтверждение.
 */

import type { FastifyInstance } from "fastify";

import { badRequest, notFound } from "../errors.js";
import type { OsintReport } from "../osint/report.js";

/** Операции по telegram id; сопоставление с внутренним пользователем — у вызывающего. */
export interface OsintPublic {
  list(telegramId: number): Promise<unknown[]>;
  status(telegramId: number, id: string): Promise<unknown | null>;
  report(telegramId: number, id: string): Promise<OsintReport | null>;
  cancel(telegramId: number, id: string): Promise<boolean>;
  delete(telegramId: number, id: string): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function investigationId(request: { params: unknown }): string {
  const id = String((request.params as { id?: unknown }).id ?? "");
  if (!UUID.test(id)) throw badRequest("Некорректный идентификатор исследования");
  return id;
}

export function registerOsintPublicRoutes(
  publicApp: FastifyInstance,
  osint: OsintPublic | undefined,
  telegramIdOf: (request: unknown) => number,
): void {
  const service = (): OsintPublic => {
    if (!osint) throw badRequest("OSINT отключён");
    return osint;
  };
  const found = <T>(value: T | null): T => {
    if (value === null || value === undefined) throw notFound("Исследование не найдено");
    return value;
  };
  publicApp.get("/osint", async (request) => ({ investigations: await service().list(telegramIdOf(request)) }));
  publicApp.get("/osint/:id", async (request) =>
    ({ investigation: found(await service().status(telegramIdOf(request), investigationId(request))) }));
  publicApp.get("/osint/:id/report", async (request) =>
    ({ report: found(await service().report(telegramIdOf(request), investigationId(request))) }));
  publicApp.post("/osint/:id/cancel", async (request) =>
    ({ cancelled: await service().cancel(telegramIdOf(request), investigationId(request)) }));
  publicApp.delete("/osint/:id", async (request) =>
    ({ deleted: await service().delete(telegramIdOf(request), investigationId(request)) }));
}
