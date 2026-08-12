/**
 * Административная поверхность Memory Doctor.
 *
 * Три маршрута и ни одного, который что-нибудь чинит. Администратор
 * может попросить диагностику, посмотреть отчёт и увидеть предложения —
 * применение остаётся отдельным явным действием и идёт тем же путём,
 * что из Mini App.
 *
 * Запуск здесь только ставит задание. Выполнять диагностику в
 * административном запросе значило бы держать HTTP-соединение на всё
 * время обхода памяти и завести второй путь запуска (требование 1
 * шага 17).
 */

import type { FastifyInstance } from "fastify";

import { badRequest } from "../errors.js";
import type { JobEnvelopeInput } from "../jobs/envelope.js";
import type { MemoryDoctorService } from "../memory/doctor/service.js";

export interface MemoryDoctorRouteContext {
  doctor: MemoryDoctorService;
  enqueue(userId: number, intent: JobEnvelopeInput): Promise<void>;
}

function userId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Некорректный идентификатор пользователя");
  return id;
}

export function registerMemoryDoctorRoutes(
  app: FastifyInstance,
  ctx: MemoryDoctorRouteContext,
): void {
  app.post("/api/admin/v1/users/:id/memory-doctor", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const id = userId((request.params as { id?: string }).id);
    const reportKey = crypto.randomUUID();
    await ctx.enqueue(id, ctx.doctor.intent({
      userId: id, trigger: "admin", reportKey, traceId: crypto.randomUUID(),
    }));
    // Возвращается ключ прогона, а не отчёт: отчёта ещё нет.
    return { report_key: reportKey };
  });

  app.get("/api/admin/v1/users/:id/memory-doctor", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const id = userId((request.params as { id?: string }).id);
    const report = await ctx.doctor.latestReport(id);
    if (!report?.reportId) return { report: null, proposals: [] };
    return { report, proposals: await ctx.doctor.proposals(id, report.reportId) };
  });

  app.post("/api/admin/v1/memory-doctor/actions/:actionId/apply", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const body = (request.body ?? {}) as { user_id?: unknown };
    const id = userId(body.user_id);
    const actionId = Number((request.params as { actionId?: string }).actionId);
    if (!Number.isInteger(actionId) || actionId <= 0) throw badRequest("Некорректное предложение");
    const actor = (request as { adminUser?: { username?: string } }).adminUser?.username ?? "admin";
    const result = await ctx.doctor.apply(id, actionId, { type: "admin", id: actor });
    if (!result.ok) throw badRequest("Предложение нельзя применить");
    return { ok: true };
  });
}
