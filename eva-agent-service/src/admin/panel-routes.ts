/**
 * Маршруты разделов единой панели: агенты, подписки, персона и промпт,
 * Letta и мониторинг.
 *
 * Отдельный модуль, а не ещё шестьсот строк в `admin/server.ts`: тот уже
 * за тысячу строк и перечитывается целиком каждой сессией, которая его
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
 *   переписка читается только под отдельным грантом `users:messages` и с
 *     собственной записью аудита — так же, как в карточке пользователя.
 */

import type { FastifyInstance } from "fastify";

import type { AdminAgentService } from "./agent-admin-service.js";
import type { HealthService } from "./health-service.js";
import type { LettaConsoleService } from "./letta-console-service.js";
import { PersonaAdminService } from "./persona-admin-service.js";
import type { SubscriptionAdminService, SubscriptionActor } from "./subscription-service.js";
import { adminBadRequest } from "./errors.js";

export interface PanelRouteContext {
  agents: AdminAgentService;
  subscriptions: SubscriptionAdminService;
  persona: PersonaAdminService;
  letta: LettaConsoleService;
  health: HealthService;
  /** Кто выполняет действие. Идентификатор администратора либо null. */
  actorId(request: unknown): string | null;
  /** Кто выполняет действие, для доменной истории подписок. */
  actor(request: unknown): SubscriptionActor;
  /** Дописать подробности в уже открытую запись аудита. */
  audit(request: unknown, details: Record<string, unknown>): Promise<void>;
  /** Отдельная запись аудита для чтения переписки: кто, чью и сколько. */
  auditMessages(request: unknown, details: Record<string, unknown>): Promise<void>;
}

function body(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function confirmed(input: Record<string, unknown>, expected: string): void {
  if (String(input.confirm ?? "") !== expected) {
    throw adminBadRequest(`Действие требует поле confirm со значением ${expected}`);
  }
}

export function registerPanelRoutes(app: FastifyInstance, ctx: PanelRouteContext): void {
  // -------------------------------------------------------------------
  // Агенты
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/panel/agents", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return await ctx.agents.list({
      query: query.query,
      status: query.status,
      limit: optionalInt(query.limit),
      offset: optionalInt(query.offset),
    });
  });

  app.get("/api/admin/v1/panel/agents/:agentId", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    return await ctx.agents.get(String(agentId ?? ""));
  });

  app.get("/api/admin/v1/panel/agents/:agentId/deletion-preview", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    return await ctx.agents.deletionPreview(String(agentId ?? ""));
  });

  /*
   * Создание идёт тем же путём, что и первое сообщение человека в
   * Telegram: `/v1/users/ensure` в eva-agent-service. Здесь только права,
   * подтверждение и аудит.
   */
  app.post("/api/admin/v1/panel/agents", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const input = body(request.body);
    const result = await ctx.agents.create(input);
    await ctx.audit(request, {
      agent_id: result.agent_id,
      telegram_id: result.telegram_id,
      created: result.created,
    });
    return result;
  });

  app.patch("/api/admin/v1/panel/agents/:agentId", {
    config: {
      roles: ["owner", "admin"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    const id = String(agentId ?? "");
    const result = await ctx.agents.update(id, body(request.body));
    await ctx.audit(request, { agent_id: id, patched: result.patched });
    return result;
  });

  /*
   * Удаление необратимо: вместе с агентом уходят его conversations,
   * история и блоки. Подтверждение — идентификатор агента, а страж
   * незакончившихся ходов проверяется до обращения к runtime.
   */
  app.delete("/api/admin/v1/panel/agents/:agentId", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    const id = String(agentId ?? "");
    const input = body(request.body);
    confirmed(input, id);
    const result = await ctx.agents.remove(id, input.confirm);
    await ctx.audit(request, { agent_id: id, action: "deleted" });
    return result;
  });

  // -------------------------------------------------------------------
  // Подписки
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/panel/subscriptions", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async () => await ctx.subscriptions.summary());

  app.get("/api/admin/v1/panel/subscriptions/:userId", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { userId } = request.params as { userId?: string };
    return await ctx.subscriptions.forUser(userId);
  });

  app.post("/api/admin/v1/panel/subscriptions/:userId/assign", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { userId } = request.params as { userId?: string };
    const input = body(request.body);
    const result = await ctx.subscriptions.assign(userId, input, ctx.actor(request));
    await ctx.audit(request, {
      user_id: userId, action: "assign", plan: input.plan ?? null,
    });
    return result;
  });

  app.post("/api/admin/v1/panel/subscriptions/:userId/plan", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { userId } = request.params as { userId?: string };
    const input = body(request.body);
    const result = await ctx.subscriptions.changePlan(userId, input, ctx.actor(request));
    await ctx.audit(request, {
      user_id: userId, action: "change_plan", plan: input.plan ?? null,
    });
    return result;
  });

  app.post("/api/admin/v1/panel/subscriptions/:userId/extend", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { userId } = request.params as { userId?: string };
    const result = await ctx.subscriptions.extend(userId, body(request.body), ctx.actor(request));
    await ctx.audit(request, { user_id: userId, action: "extend" });
    return result;
  });

  /*
   * Отмена отбирает доступ, в том числе оплаченный, — поэтому
   * подтверждение обязательно и совпадает с идентификатором человека.
   */
  app.post("/api/admin/v1/panel/subscriptions/:userId/cancel", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { userId } = request.params as { userId?: string };
    const input = body(request.body);
    confirmed(input, String(userId ?? ""));
    const result = await ctx.subscriptions.cancel(userId, input, ctx.actor(request));
    await ctx.audit(request, { user_id: userId, action: "cancel" });
    return result;
  });

  app.post("/api/admin/v1/panel/subscriptions/:userId/clear-manual", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { userId } = request.params as { userId?: string };
    const result = await ctx.subscriptions.clearManual(
      userId,
      body(request.body),
      ctx.actor(request),
    );
    await ctx.audit(request, { user_id: userId, action: "clear_manual" });
    return result;
  });

  // -------------------------------------------------------------------
  // Персона и системный промпт
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/panel/persona", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async () => await ctx.persona.state());

  app.get("/api/admin/v1/panel/persona/:source/history", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const { source } = request.params as { source?: string };
    return await ctx.persona.history(source);
  });

  /*
   * Сохранение меняет то, чем Ева говорит с людьми прямо сейчас, —
   * поэтому право `settings:write` и подтверждение именем источника.
   * В аудит идут версия, отпечаток и итог применения; текста там нет.
   */
  app.put("/api/admin/v1/panel/persona/:source", {
    config: { roles: ["owner", "admin"], sudoScope: "settings:write" },
  }, async (request) => {
    const { source } = request.params as { source?: string };
    const input = body(request.body);
    confirmed(input, String(source ?? ""));
    const result = await ctx.persona.save(source, input, ctx.actorId(request));
    await ctx.audit(
      request,
      PersonaAdminService.auditFacts(source as never, result),
    );
    return result;
  });

  app.post("/api/admin/v1/panel/persona/:source/rollback", {
    config: { roles: ["owner", "admin"], sudoScope: "settings:write" },
  }, async (request) => {
    const { source } = request.params as { source?: string };
    const result = await ctx.persona.rollback(source, body(request.body), ctx.actorId(request));
    await ctx.audit(request, {
      ...PersonaAdminService.auditFacts(source as never, result),
      action: "rollback",
    });
    return result;
  });

  app.post("/api/admin/v1/panel/persona/:source/restore-default", {
    config: { roles: ["owner", "admin"], sudoScope: "settings:write" },
  }, async (request) => {
    const { source } = request.params as { source?: string };
    const result = await ctx.persona.restoreDefault(source, ctx.actorId(request));
    await ctx.audit(request, {
      ...PersonaAdminService.auditFacts(source as never, result),
      action: "restore_default",
    });
    return result;
  });

  /*
   * Повторная синхронизация ничего не меняет в тексте: она догоняет
   * агентов, до которых прошлое применение не доехало. Поэтому доступна
   * оператору и не требует подтверждения.
   */
  app.post("/api/admin/v1/panel/persona/sync", {
    config: { roles: ["owner", "admin", "operator"], tenantAccess: "cross-user" },
  }, async (request) => {
    const result = await ctx.persona.sync();
    await ctx.audit(request, {
      action: "persona_sync",
      sync_updated: (result.sync as { updated?: unknown } | null)?.updated ?? null,
      sync_failed: (result.sync as { failed?: unknown } | null)?.failed ?? null,
    });
    return result;
  });

  // -------------------------------------------------------------------
  // Letta
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/panel/letta", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async () => await ctx.letta.overview());

  app.get("/api/admin/v1/panel/letta/context", {
    config: { roles: ["owner", "admin", "operator", "viewer"], tenantAccess: "cross-user" },
  }, async () => await ctx.letta.contextManagement());

  app.post("/api/admin/v1/panel/letta/test", {
    config: { roles: ["owner", "admin", "operator"] },
  }, async () => ({ result: await ctx.letta.test() }));

  app.patch("/api/admin/v1/panel/letta/settings", {
    config: { roles: ["owner", "admin"], sudoScope: "settings:write" },
  }, async (request) => {
    const input = body(request.body);
    const result = await ctx.letta.updateSettings(input);
    await ctx.audit(request, { action: "sdk_settings", fields: Object.keys(input) });
    return result;
  });

  app.get("/api/admin/v1/panel/letta/agents/:agentId/conversations", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId?: string };
    return await ctx.letta.conversations(String(agentId ?? ""));
  });

  app.get("/api/admin/v1/panel/letta/conversations/:conversationId/session", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    return await ctx.letta.session(String(conversationId ?? ""));
  });

  /*
   * Личная переписка. Отдельный грант и отдельная запись аудита: кто,
   * чей диалог и сколько сообщений открыл. Самих сообщений в журнале
   * нет — только счётчик.
   */
  app.get("/api/admin/v1/panel/letta/conversations/:conversationId/messages", {
    config: { roles: ["owner", "admin"], sudoScope: "users:messages" },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    const id = String(conversationId ?? "");
    const limit = (request.query as { limit?: string }).limit;
    const result = await ctx.letta.messages(id, limit) as { messages?: unknown[] };
    await ctx.auditMessages(request, {
      conversation_id: id,
      messages: Array.isArray(result.messages) ? result.messages.length : 0,
    });
    return result;
  });

  app.post("/api/admin/v1/panel/letta/conversations/:conversationId/abort", {
    config: {
      roles: ["owner", "admin", "operator"],
      tenantAccess: "cross-user",
    },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    const id = String(conversationId ?? "");
    confirmed(body(request.body), id);
    const result = await ctx.letta.abort(id);
    await ctx.audit(request, { conversation_id: id, action: "abort" });
    return { result };
  });

  app.post("/api/admin/v1/panel/letta/conversations/:conversationId/archive", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" },
  }, async (request) => {
    const { conversationId } = request.params as { conversationId?: string };
    const id = String(conversationId ?? "");
    const input = body(request.body);
    const archived = input.archived !== false;
    if (archived) confirmed(input, id);
    const result = await ctx.letta.setArchived(id, archived);
    await ctx.audit(request, { conversation_id: id, archived });
    return result;
  });

  app.get("/api/admin/v1/panel/letta/audit", {
    config: { roles: ["owner", "admin", "operator", "viewer"], tenantAccess: "cross-user" },
  }, async (request) => {
    return await ctx.letta.audit((request.query as { limit?: string }).limit);
  });

  // -------------------------------------------------------------------
  // Мониторинг
  // -------------------------------------------------------------------
  /*
   * Собственные данные Evaself: health-worker уже опрашивает каждый
   * сервис каталога, `service_statuses` держит текущее состояние, а
   * `health_checks` — историю. Внешней статусной странице в этой картине
   * нечего добавить.
   */
  app.get("/api/admin/v1/panel/monitoring", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const query = request.query as { hours?: string; limit?: string };
    return await ctx.health.monitoring(
      optionalInt(query.hours) ?? 24,
      optionalInt(query.limit) ?? 50,
    );
  });
}
