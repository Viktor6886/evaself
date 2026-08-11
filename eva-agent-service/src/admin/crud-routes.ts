/**
 * Административные маршруты шага 12: агенты и conversations, шаблоны memory
 * block, инструменты, approvals, восстановление и разделы подсистем,
 * которых ещё нет.
 *
 * Отдельный модуль, а не ещё пятьсот строк в `admin/server.ts`: тот уже за
 * тысячу строк и перечитывается целиком каждой сессией, которая его
 * касается. Права и аудит остаются за сервером — этот модуль их не
 * изобретает, а получает контекстом.
 *
 * Правила, общие для всех маршрутов ниже:
 *
 *   роли объявляются литералом в каждом маршруте — `scripts/ci/assert-admin-
 *     route-access.py` читает исходник и ищет именно список `roles`, поэтому
 *     общая функция доступа выключила бы проверку ровно там, где появились
 *     новые маршруты;
 *   `tenantAccess: "cross-user"` ставится всюду, где запрос трогает данные
 *     пользователей: без записи аудита граница арендатора такой запрос не
 *     пропустит вовсе;
 *   опасное действие требует подтверждения полем `confirm`, совпадающим с
 *     идентификатором цели, а не булевым флагом: «да» ставится не глядя,
 *     идентификатор — списывается;
 *   ответ не содержит ни строки переписки и ни одного значения memory
 *     block: только состояния, счётчики и отпечатки.
 */

import type { FastifyInstance } from "fastify";

import type { AgentDirectoryService } from "./agent-directory.js";
import type { MemoryTemplateService, ApplicationScope } from "./memory-template-service.js";
import { SUBSYSTEM_SECTIONS, subsystemPayload, subsystemSection } from "./subsystem-status.js";
import type { ToolApprovalService } from "./tool-approvals.js";
import type { TurnOperationsService } from "./turn-operations.js";
import { badRequest, notFound } from "../errors.js";

export interface CrudRouteContext {
  directory: AgentDirectoryService;
  templates: MemoryTemplateService;
  tools: ToolApprovalService;
  turns: TurnOperationsService;
  /** Кто выполняет действие. Идентификатор администратора либо null. */
  actorId(request: unknown): string | null;
  /** Дописать подробности в уже открытую запись аудита. */
  audit(request: unknown, details: Record<string, unknown>): Promise<void>;
}

function body(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function intParam(value: unknown, name: string): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest(`${name} — целое число`);
  return parsed;
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Подтверждение опасного действия.
 *
 * Совпадение с идентификатором цели, а не булев флаг: «да» ставится не
 * глядя, а идентификатор приходится списать с экрана — и тем самым
 * прочитать, на что именно он нажимает.
 */
function confirmed(input: Record<string, unknown>, expected: string): void {
  if (String(input.confirm ?? "") !== expected) {
    throw badRequest(`Действие требует поле confirm со значением ${expected}`);
  }
}

function reasonOf(input: Record<string, unknown>): string {
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw badRequest("Нужна причина: она теряется первой, а спрашивают о ней всегда");
  return reason.slice(0, 200);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? "")) : [];
}

export function registerCrudRoutes(app: FastifyInstance, ctx: CrudRouteContext): void {
  // -------------------------------------------------------------------
  // 1. Агенты и conversations
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/agents", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return await ctx.directory.agents({
      query: query.query,
      status: query.status,
      limit: optionalInt(query.limit),
      offset: optionalInt(query.offset),
    });
  });

  app.get("/api/admin/v1/agents/:agentId", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    return await ctx.directory.agent(String(agentId ?? ""));
  });

  // Экспорт содержит состав агента и отпечатки блоков, но ни одного
  // сообщения: переписка читается отдельным маршрутом под отдельным
  // грантом. Поэтому здесь достаточно роли admin, а не users:messages.
  app.get("/api/admin/v1/agents/:agentId/export", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    const snapshot = await ctx.directory.exportAgent(String(agentId ?? ""));
    await ctx.audit(request, { agent_id: agentId ?? null, exported: "agent-snapshot" });
    return snapshot;
  });

  // Предпросмотр импорта ничего не меняет, поэтому подтверждения не
  // требует. Применения нет намеренно: создавать агентов вправе только
  // eva-agent-service через Letta SDK.
  app.post("/api/admin/v1/agents/import-preview", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
  }, async (request) => await ctx.directory.importPreview(request.body));

  app.get("/api/admin/v1/agents/:agentId/deletion-preview", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    return await ctx.directory.deletionPreview("agent", String(agentId ?? ""));
  });

  app.get("/api/admin/v1/conversations", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return await ctx.directory.conversations({
      query: query.query,
      agentId: query.agent_id,
      status: query.status,
      purpose: query.purpose,
      limit: optionalInt(query.limit),
      offset: optionalInt(query.offset),
    });
  });

  app.get("/api/admin/v1/conversations/:conversationId/deletion-preview", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    return await ctx.directory.deletionPreview("conversation", String(conversationId ?? ""));
  });

  /*
   * Архивация обратима, но не безобидна: архивная conversation перестаёт
   * быть действующей для своего назначения. Подтверждение поэтому есть, а
   * страж незакончившихся ходов проверяется внутри сервиса.
   */
  app.post("/api/admin/v1/conversations/:conversationId/archive", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    const id = String(conversationId ?? "");
    confirmed(body(request.body), id);
    const conversation = await ctx.directory.setConversationStatus(id, "archived");
    await ctx.audit(request, { conversation_id: id, status: "archived" });
    return { conversation };
  });

  app.post("/api/admin/v1/conversations/:conversationId/restore", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    const id = String(conversationId ?? "");
    const conversation = await ctx.directory.setConversationStatus(id, "active");
    await ctx.audit(request, { conversation_id: id, status: "active" });
    return { conversation };
  });

  // -------------------------------------------------------------------
  // 2. Шаблоны memory block
  // -------------------------------------------------------------------
  // Что действует для НОВЫХ агентов. Публикация другой версии меняет
  // только это и существующих агентов не касается.
  app.get("/api/admin/v1/memory/templates", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const environment = String((request.query as { environment?: string }).environment
      ?? "production");
    return {
      environment,
      templates: await ctx.templates.newAgentTemplates(environment),
      note: "Публикация версии действует на новых агентов. Существующие меняются "
        + "только отдельной командой применения.",
    };
  });

  app.post("/api/admin/v1/memory/templates/preview", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
  }, async (request) => {
    const input = body(request.body);
    return {
      application: await ctx.templates.preview({
        versionId: intParam(input.version_id, "version_id"),
        scope: scopeOf(input.scope),
        agentIds: stringList(input.agent_ids),
        excluded: stringList(input.excluded),
        reason: String(input.reason ?? ""),
        actorId: ctx.actorId(request),
      }),
    };
  });

  /*
   * Массовое применение шаблона.
   *
   * Sudo здесь тот же, что у блокировки пользователя: `users:write`.
   * Отдельного права не заводится — это то же самое по смыслу действие
   * «изменить состояние человека в системе», только сразу для многих.
   * Подтверждение совпадает с идентификатором версии: администратор
   * обязан списать его с предпросмотра, а не нажать «да».
   */
  app.post("/api/admin/v1/memory/templates/apply", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const input = body(request.body);
    const versionId = intParam(input.version_id, "version_id");
    confirmed(input, String(versionId));
    const application = await ctx.templates.apply({
      versionId,
      scope: scopeOf(input.scope),
      agentIds: stringList(input.agent_ids),
      excluded: stringList(input.excluded),
      reason: reasonOf(input),
      actorId: ctx.actorId(request),
    });
    await ctx.audit(request, {
      application_id: application.id,
      version_id: versionId,
      scope: application.scope,
      counts: application.counts,
    });
    return { application };
  });

  app.get("/api/admin/v1/memory/templates/applications", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const limit = optionalInt((request.query as { limit?: string }).limit);
    return { applications: await ctx.templates.history(limit ?? 50) };
  });

  app.get("/api/admin/v1/memory/templates/applications/:id", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    return { application: await ctx.templates.application(id) };
  });

  /*
   * Откат одним действием: родительская версия шаблона возвращается тем же
   * агентам. Подтверждение не требуется намеренно — откат делают, когда уже
   * плохо, и лишний шаг здесь стоит дороже ошибки. Причина обязательна.
   */
  app.post("/api/admin/v1/memory/templates/applications/:id/rollback", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    const application = await ctx.templates.rollback(
      id,
      reasonOf(body(request.body)),
      ctx.actorId(request),
    );
    await ctx.audit(request, {
      application_id: application.id,
      reverts_id: id,
      counts: application.counts,
    });
    return { application };
  });

  // -------------------------------------------------------------------
  // 3–4. Инструменты и approvals — read-only до шага 14
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/tools", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const days = optionalInt((request.query as { days?: string }).days);
    return await ctx.tools.tools(days ?? 7);
  });

  app.get("/api/admin/v1/approvals", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const limit = optionalInt((request.query as { limit?: string }).limit);
    return await ctx.tools.approvals(limit ?? 50);
  });

  // -------------------------------------------------------------------
  // 8. Восстановление
  // -------------------------------------------------------------------
  // Статический маршрут объявляется до параметрического: иначе `reconcile`
  // разбирался бы как идентификатор хода.
  app.get("/api/admin/v1/turns/reconcile", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async () => await ctx.turns.reconcile());

  app.get("/api/admin/v1/turns", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return await ctx.turns.turns({
      state: query.state,
      userId: optionalInt(query.user_id),
      active: query.active === undefined ? undefined : query.active === "true",
      limit: optionalInt(query.limit),
      offset: optionalInt(query.offset),
    });
  });

  app.get("/api/admin/v1/turns/:runId", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { runId } = request.params as { runId?: string };
    return await ctx.turns.turn(String(runId ?? ""));
  });

  /*
   * Отмена хода доступна и оператору: это дежурное действие, оно
   * останавливает работу, а не меняет состояние установки. Подтверждение —
   * идентификатор хода, причина обязательна.
   */
  app.post("/api/admin/v1/turns/:runId/cancel", {
    config: {
      roles: ["owner", "admin", "operator"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { runId } = request.params as { runId?: string };
    const id = String(runId ?? "");
    const input = body(request.body);
    confirmed(input, id);
    const turn = await ctx.turns.requestCancel(id, reasonOf(input));
    await ctx.audit(request, { run_id: id, action: "cancel_requested" });
    return { turn };
  });

  /*
   * Повтор доставки. Подтверждение — идентификатор строки outbox: цена
   * ошибки здесь — второе сообщение человеку, которого он не ждал.
   */
  app.post("/api/admin/v1/deliveries/:id/redeliver", {
    config: {
      roles: ["owner", "admin", "operator"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    confirmed(body(request.body), String(id));
    const delivery = await ctx.turns.redeliver(id);
    await ctx.audit(request, { outbox_id: id, action: "redeliver" });
    return { delivery };
  });

  // -------------------------------------------------------------------
  // 5, 6, 7, 9. Навыки, исследования, evals, расширения — честный статус
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/subsystems", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async () => ({
    subsystems: SUBSYSTEM_SECTIONS.map((section) => ({
      id: section.id,
      title: section.title,
      implemented: section.implemented,
      planned_step: section.plannedStep,
    })),
  }));

  app.get("/api/admin/v1/subsystems/:id", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const id = String((request.params as { id?: string }).id ?? "");
    const section = subsystemSection(id);
    if (!section) throw notFound(`раздела ${id} нет`);
    return subsystemPayload(section);
  });
}

function scopeOf(value: unknown): ApplicationScope {
  const scope = String(value ?? "");
  if (scope !== "agent" && scope !== "group" && scope !== "all") {
    throw badRequest("Область применения — agent, group или all");
  }
  return scope;
}
