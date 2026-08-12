/**
 * HTTP surface. Administrative routes use `X-API-Key`; Telegram and Lava
 * have their own webhook authentication.
 *
 * No public client reaches the Letta App Server directly — every agent, session,
 * memory, skill and tool operation goes through these routes.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";
import type { AdminAuditInput, Database } from "./db.js";
import type { TelegramInbox } from "./delivery/inbox.js";
import { EvaError, appServerUnavailable, badRequest, notFound, unauthorized } from "./errors.js";
import type { GoalService } from "./goals/goal-service.js";
import type { LettaService } from "./letta.js";
import type { ManagedAgentInput } from "./letta.js";
import { DeleteGuard } from "./letta/delete-guard.js";
import type { LlmManager, LlmProviderInput } from "./llm.js";
import type { Logger } from "./logger.js";
import { MetricsCollector } from "./metrics.js";
import { newCorrelationId, parseTraceparent } from "./observability/tracing.js";
import type { LavaPayments } from "./payments.js";
import type { UserProfileService } from "./profile/profile-service.js";
import {
  PublicRepository,
  registerPublicRoutes,
  type MiniAppMemoryControl,
  type MiniAppMemoryDoctor,
} from "./public/routes.js";
import {
  clientAddress,
  enforceRateLimit,
  NoopRateLimiter,
  type RateLimiter,
} from "./public/rate-limit.js";
import type { MiniAppSessionStore } from "./public/webapp-session.js";
import { registerWebappCoreRoutes } from "./public/webapp-core.js";
import type { UserTurnLock } from "./turns/user-turn-lock.js";
import type { SdkSettingsInput, SdkSettingsManager } from "./sdk-settings.js";
import type { TelegramClient, TelegramUpdate } from "./telegram.js";
import type { TurnSemaphores } from "./turns/semaphores.js";
import { webhookSecretMatches } from "./telegram.js";

export const VERSION = "0.3.0";

export interface Services {
  config: Config;
  logger: Logger;
  db: Database;
  letta: LettaService;
  sdk: SdkSettingsManager;
  llm: LlmManager;
  inbox: TelegramInbox;
  profile: UserProfileService;
  goals: GoalService;
  payments: LavaPayments;
  queue: UserTurnLock;
  telegram: TelegramClient;
  redisPing: () => Promise<boolean>;
  /** Глобальные слоты хода. Нужны только выдаче метрик. */
  slots?: TurnSemaphores;
  /** Параллельный диспетчер. Нужен только выдаче метрик. */
  dispatcher?: { foreignLockCount: number };
  miniAppSessions?: MiniAppSessionStore;
  rateLimiter?: RateLimiter;
  approvals?: { decideByTelegram(input: { telegramId: number; sdkRequestId: string; decision: "allow" | "deny" }): Promise<unknown> };
  /** Просмотр, подтверждение, исправление и удаление памяти из Mini App. */
  memory?: MiniAppMemoryControl;
  memoryDoctor?: MiniAppMemoryDoctor;
  /**
   * Контур наблюдаемости. Нужен выдаче метрик (состояние буфера
   * телеметрии) и ingress — там начинается трасса хода.
   */
  observability?: {
    bufferStats(): { buffered: number; dropped: number };
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function telegramIdOf(request: FastifyRequest): number {
  const raw = (request.params as { telegramId?: string }).telegramId;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) throw badRequest(`Некорректный Telegram ID: ${raw}`);
  return parsed;
}

export function buildServer(services: Services): FastifyInstance {
  const {
    config,
    logger,
    db,
    letta,
    sdk,
    llm,
    inbox,
    profile,
    goals,
    payments,
    queue,
    telegram,
  } = services;

  // Без Valkey лимитер пропускал бы всё: подставляется явный no-op, а не
  // «случайно отключилось». Рантайм всегда передаёт настоящий.
  const rateLimiter = services.rateLimiter ?? new NoopRateLimiter();

  // Страж удаления спрашивает канонический факт «ход идёт» у `turn_runs`,
  // а не у пула сессий этого процесса: пул не знает о ходах соседа и о
  // ходах, переживших перезапуск.
  const deleteGuard = new DeleteGuard(db);

  // Fastify's own logger is off: this service logs through logger.ts so
  // every line in the stack has the same JSON shape.
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  // ---------------------------------------------------------------
  // трасса хода: начинается здесь и живёт до доставки
  // ---------------------------------------------------------------
  // Correlation id либо приходит от вызывающего, либо рождается тут.
  // Он не то же самое, что trace id: трасса живёт внутри процесса и
  // рвётся на каждой границе, а correlation id едет в конверте задания,
  // в строке outbox и в ответе — и связывает их между собой.
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    const correlationId = typeof incoming === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(incoming)
      ? incoming
      : newCorrelationId();
    // Заголовок ответа возвращается всегда: по нему человек, читающий
    // журнал, находит ход, не спрашивая идентификатор пользователя.
    reply.header("x-correlation-id", correlationId);
    // Дальше по коду этот идентификатор не передаётся, и это не
    // недосмотр: ход Telegram не создаётся внутри HTTP-обработчика —
    // между ними durable inbox, а ход может выполниться в другом
    // процессе и позже. Идентификатор хода выводится из идентификатора
    // апдейта (`turn.telegram` в `eva-workflow.ts`), а этот заголовок
    // отвечает на другой вопрос: по нему вызывающий находит СВОЙ запрос
    // в журнале.
    if (typeof request.headers.traceparent === "string") {
      // Некорректный `traceparent` не повод отказать в обслуживании:
      // он просто не принимается, и запрос обрабатывается как обычно.
      parseTraceparent(request.headers.traceparent);
    }
  });

  // ---------------------------------------------------------------
  // auth: everything under /v1 needs the internal key
  // ---------------------------------------------------------------
  app.addHook("onRequest", async (request) => {
    // /metrics живёт вне /v1, но закрывается тем же ключом: иначе
    // операционная картина сервиса была бы открыта всякому, кто дотянулся
    // до порта.
    if (!request.url.startsWith("/v1/") && request.url !== "/metrics") return;
    if (!config.apiKey) throw unauthorized("EVA_AGENT_API_KEY не настроен на сервере");
    const presented = request.headers["x-api-key"];
    if (typeof presented !== "string" || !constantTimeEquals(presented, config.apiKey)) {
      throw unauthorized("X-API-Key отсутствует или неверен");
    }
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const evaError = error instanceof EvaError
      ? error
      : new EvaError(
          error instanceof Error ? error.message : "unexpected error",
          { statusCode: (error as { statusCode?: number })?.statusCode ?? 500 },
        );
    if (evaError.statusCode >= 500) {
      logger.error("Ошибка запроса", {
        url: request.url,
        code: evaError.code,
        message: evaError.message,
      });
    }
    reply.status(evaError.statusCode).send(evaError.toPayload());
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(notFound("Маршрут не найден").toPayload());
  });

  registerPublicRoutes(app, {
    config,
    repository: new PublicRepository(db, profile, goals),
    telegram,
    ...(services.miniAppSessions ? { sessions: services.miniAppSessions } : {}),
    rateLimiter,
    ...(services.approvals ? { approvals: { decide: async (input) => await services.approvals!.decideByTelegram(input) } } : {}),
    ...(services.memory ? { memory: services.memory } : {}),
    ...(services.memoryDoctor ? { memoryDoctor: services.memoryDoctor } : {}),
  });

  // Новые разделы Mini App (задачи, заметки, бюджет, решения, check-in,
  // фокус-сессии) под собственным префиксом /public/v2. Существующие
  // /public/* не трогаются: их продолжает обслуживать registerPublicRoutes.
  registerWebappCoreRoutes(app, {
    config,
    db,
    ...(services.miniAppSessions ? { sessions: services.miniAppSessions } : {}),
    rateLimiter,
  });

  // ---------------------------------------------------------------
  // metrics — Prometheus, за тем же внутренним ключом, что и /v1
  // ---------------------------------------------------------------
  // Выдача операционная: очереди, ходы, пул, лаг event loop. Ключ нужен
  // не потому, что там есть личные данные (их там нет), а потому что
  // глубина очередей и состояние пула — подсказка тому, кто ищет, когда
  // сервису тяжелее всего.
  const metrics = new MetricsCollector({
    db,
    sessions: () => letta.sessionStats(),
    locks: () => ({ held: queue.activeUsers, queued: queue.queuedUsers }),
    poolStats: () => db.poolStats(),
    // Замер задержки есть у настоящей базы; поддельная в тестах и
    // внешние вызовы `buildServer` его не обязаны предоставлять, и
    // отсутствие метода не должно ронять всю выдачу.
    ...(typeof db.queryLatency === "function"
      ? { queryLatency: () => db.queryLatency() }
      : {}),
    ...(services.slots ? { slots: () => services.slots!.usage() } : {}),
    ...(services.dispatcher
      ? { foreignLockReleases: () => services.dispatcher!.foreignLockCount }
      : {}),
    version: VERSION,
    turnLifecycleEnabled: config.turnLifecycleEnabled,
    ...(services.observability
      ? { telemetryBuffer: () => services.observability!.bufferStats() }
      : {}),
  });
  app.addHook("onClose", async () => metrics.stop());
  app.get("/metrics", async (_request, reply: FastifyReply) => {
    // Выключенный флаг отдаёт 404, а не пустую страницу: пустая выдача
    // читается сборщиком как «сервис жив, метрик нет», и тревога о
    // пропавших метриках не срабатывает.
    // Сравнение именно с `false`: конфигурация, собранная без этого поля
    // (а так делают тесты и внешние вызовы `buildServer`), означает
    // «как раньше», а не «метрики выключены».
    if (config.prometheusEnabled === false) {
      return reply.code(404).send({ error: "metrics_disabled" });
    }
    const body = await metrics.render();
    return reply
      .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(body);
  });

  // ---------------------------------------------------------------
  // health — unauthenticated, used by Docker and `make doctor`
  // ---------------------------------------------------------------
  app.get("/health", async (request, reply: FastifyReply) => {
    // Каждый вызов стучится в Letta, PostgreSQL и Valkey. Без лимита это
    // бесплатный усилитель на три бэкенда: один запрос снаружи — три
    // внутри. Лимит щедрый, потому что сюда же ходят docker healthcheck
    // и `make doctor`, и он по адресу, а не общий.
    await enforceRateLimit(
      rateLimiter,
      `health:ip:${clientAddress(request.headers as Record<string, unknown>, request.ip)}`,
      {
        limit: config.healthRateLimitPerIp,
        windowSeconds: config.rateLimitWindowSeconds,
      },
    );
    const checks: Record<string, unknown> = {};
    let status = "ok";

    const appServer = await letta.ping();
    checks.app_server = appServer.ok
      ? { ok: true, models: appServer.models, url: config.appServerUrl }
      : { ok: false, error: appServer.error, url: config.appServerUrl };
    if (!appServer.ok) status = "degraded";

    try {
      await db.ping();
      checks.postgres = { ok: true };
    } catch (error) {
      checks.postgres = { ok: false, error: error instanceof EvaError ? error.code : String(error) };
      status = "degraded";
    }

    try {
      checks.valkey = { ok: await services.redisPing() };
      if (!(checks.valkey as { ok: boolean }).ok) status = "degraded";
    } catch (error) {
      checks.valkey = { ok: false, error: String(error).slice(0, 200) };
      status = "degraded";
    }

    return reply.status(status === "ok" ? 200 : 503).send({
      service: "eva-agent-service",
      version: VERSION,
      status,
      runtime: "letta-agent-sdk",
      sessions_open: letta.openSessions,
      users_queued: queue.queuedUsers,
      checks,
    });
  });

  // ---------------------------------------------------------------
  // users, agents and conversations
  // ---------------------------------------------------------------

  // Настройки и управление официальным Letta Agent SDK. Эти маршруты
  // использует только защищённая административная консоль.
  app.get("/v1/sdk/settings", async () => ({ settings: await sdk.get() }));

  app.patch("/v1/sdk/settings", async (request) => ({
    settings: await sdk.update(requireObject(request.body, "Настройки SDK") as SdkSettingsInput),
  }));

  app.post("/v1/sdk/test", async () => {
    const result = await letta.ping();
    if (!result.ok) throw appServerUnavailable(result.error);
    return { result };
  });

  app.get("/v1/system", async () => {
    const providers = await llm.list();
    const active = providers.find((provider) => provider.is_active) ?? null;
    const url = (domain: string) => domain ? `https://${domain}` : null;
    return {
      version: VERSION,
      runtime: "letta-agent-sdk",
      timezone: config.defaultTimezone,
      setup_complete: config.incompleteSettings.length === 0,
      incomplete_settings: config.incompleteSettings,
      integrations: {
        telegram: Boolean(config.telegramBotToken),
        telegram_owner: config.ownerTelegramId !== null,
        todoist: Boolean(config.todoistApiToken),
        lava: Boolean(config.lavaWebhookUser && config.lavaWebhookPassword),
        llm: active !== null,
      },
      active_llm: active,
      links: {
        site: url(config.domains.root),
        webapp: url(config.domains.app),
        api: config.domains.api ? `${url(config.domains.api)}/health` : null,
        nocodb: url(config.domains.nocodb),
        letta: url(config.domains.letta),
        status: url(config.domains.status),
      },
      sdk_capabilities: {
        agents: { list: true, create: true, update: true, delete: true, export_json: true },
        conversations: { list: true, create: true, update: true, chat: true, abort: true },
        trace: true,
        memory: {
          create_with_agent: true,
          read_existing: true,
          update_existing: false,
          reason: "Letta Agent SDK App Server management 0.5.x не предоставляет CRUD blocks",
        },
        tools: {
          configure_sdk_tools: true,
          inspect_attached: true,
          mutate_attached: false,
          reason: "App Server management SDK не предоставляет CRUD server-side tools",
        },
      },
    };
  });

  const audit = async (input: AdminAuditInput): Promise<void> => {
    try {
      await db.recordAdminAudit(input);
    } catch (error) {
      // A successful Letta mutation must not be reported as failed only because
      // an old installation has not applied the audit migration yet.
      logger.warn("Не удалось записать административный аудит", {
        action: input.action,
        targetId: input.targetId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // ---------------------------------------------------------------
  // Public webhooks with provider-specific authentication
  // ---------------------------------------------------------------
  app.post("/telegram/webhook", async (request, reply) => {
    // Лимит до сверки секрета: перебор секрета тоже стоит времени, и
    // поток чужих запросов не должен занимать обработчик.
    await enforceRateLimit(
      rateLimiter,
      `webhook:ip:${clientAddress(request.headers as Record<string, unknown>, request.ip)}`,
      {
        limit: config.webhookRateLimitPerIp,
        windowSeconds: config.rateLimitWindowSeconds,
      },
    );
    if (
      !webhookSecretMatches(
        request.headers["x-telegram-bot-api-secret-token"],
        config.telegramWebhookSecret,
      )
    ) {
      throw unauthorized("Неверный секрет Telegram webhook");
    }
    const result = await inbox.enqueue(request.body as TelegramUpdate);
    return reply.status(200).send({ ok: true, ...result });
  });

  app.post("/payments/lava", async (request, reply) => {
    // Лимит до проверки Basic-авторизации: перебор пароля webhook тоже
    // стоит времени.
    await enforceRateLimit(
      rateLimiter,
      `payments:ip:${clientAddress(request.headers as Record<string, unknown>, request.ip)}`,
      {
        limit: config.webhookRateLimitPerIp,
        windowSeconds: config.rateLimitWindowSeconds,
      },
    );
    if (!payments.authorized(request.headers.authorization)) {
      reply.header("WWW-Authenticate", 'Basic realm="Evaself Lava webhook"');
      throw unauthorized("Неверная авторизация Lava webhook");
    }
    return reply.status(200).send(await payments.handle(request.body));
  });

  app.get("/v1/sdk/agents", async () => ({
    agents: (await letta.listAgents()).map((agent) => safeAdminValue(agent)),
  }));

  app.post("/v1/sdk/agents", async (request, reply) => {
    const input = managedAgentInput(request.body, true);
    const result = await letta.createManagedAgent(input);
    const agentId = (result.agent as { id?: string }).id ?? null;
    const safeAgent = safeAdminValue(result.agent);
    await audit({
      action: "agent.create",
      targetType: "agent",
      targetId: agentId,
      after: jsonable(auditAgentProjection(safeAgent)),
    });
    return reply.status(201).send({ ...result, agent: safeAgent });
  });

  app.post("/v1/sdk/agents/bulk", async (request) => {
    const body = requireObject(request.body, "Пакетное изменение");
    const agentIds = optionalStringArray(body.agent_ids, "agent_ids", 100) ?? [];
    if (agentIds.length === 0) throw badRequest("agent_ids должен содержать хотя бы один ID");
    const patch = managedAgentPatch(body.patch);
    if (Object.keys(patch).length === 0) throw badRequest("patch не содержит изменений");

    const snapshots = new Map<string, unknown>();
    const changed: string[] = [];
    try {
      for (const agentId of agentIds) {
        const id = requireId(agentId, "agent_id");
        const before = await letta.getAgent(id);
        snapshots.set(id, before);
        const after = await letta.updateAgent(id, patch);
        changed.push(id);
        await audit({
          action: "agent.bulk-update",
          targetType: "agent",
          targetId: id,
          before: jsonable(auditAgentProjection(before)),
          after: jsonable(auditAgentProjection(after)),
        });
      }
      return { updated: changed, rolled_back: [], count: changed.length };
    } catch (error) {
      const rolledBack: string[] = [];
      const rollbackErrors: Array<{ agent_id: string; error: string }> = [];
      for (const id of [...changed].reverse()) {
        try {
          await letta.updateAgent(id, rollbackPatch(snapshots.get(id)));
          rolledBack.push(id);
          await audit({
            action: "agent.bulk-rollback",
            targetType: "agent",
            targetId: id,
            status: "rolled_back",
            after: jsonable(auditAgentProjection(snapshots.get(id))),
          });
        } catch (rollbackError) {
          rollbackErrors.push({
            agent_id: id,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
      }
      await audit({
        action: "agent.bulk-update",
        targetType: "agent-set",
        status: "failed",
        details: {
          requested: agentIds,
          changed,
          rolled_back: rolledBack,
          rollback_errors: rollbackErrors,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new EvaError("Пакетное изменение отменено из-за ошибки", {
        code: "bulk_update_failed",
        statusCode: 409,
        details: {
          changed,
          rolled_back: rolledBack,
          rollback_errors: rollbackErrors,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post("/v1/sdk/agents/import", async (request, reply) => {
    const body = requireObject(request.body, "Импорт");
    const items = Array.isArray(body.agents) ? body.agents : [];
    if (items.length === 0 || items.length > 50) {
      throw badRequest("agents должен быть массивом из 1–50 экспортированных агентов");
    }
    const imported: Array<{ source_id: string | null; agent: unknown; conversation: unknown }> = [];
    for (const item of items) {
      const wrapper = requireObject(item, "Экспортированный агент");
      const input = managedAgentInput(wrapper.input ?? wrapper, true);
      const result = await letta.createManagedAgent({
        ...input,
        name: `${input.name} (импорт)`.slice(0, 100),
      });
      const id = (result.agent as { id?: string }).id ?? null;
      const safeAgent = safeAdminValue(result.agent);
      imported.push({
        source_id: typeof wrapper.source_id === "string" ? wrapper.source_id : null,
        agent: safeAgent,
        conversation: result.conversation,
      });
      await audit({
        action: "agent.import",
        targetType: "agent",
        targetId: id,
        after: jsonable(auditAgentProjection(safeAgent)),
      });
    }
    return reply.status(201).send({ imported, count: imported.length });
  });

  app.get("/v1/sdk/agents/export", async (request) => {
    const rawIds = String((request.query as { ids?: string }).ids ?? "");
    const requested = rawIds.split(",").map((item) => item.trim()).filter(Boolean);
    const available = await letta.listAgents() as Array<{ id?: string }>;
    const ids = requested.length > 0
      ? [...new Set(requested)]
      : available.map((agent) => agent.id).filter((id): id is string => Boolean(id));
    if (ids.length > 100) throw badRequest("За один раз можно экспортировать не более 100 агентов");

    const agents = [];
    for (const id of ids) {
      const agent = await letta.getAgent(requireId(id, "agent_id"));
      agents.push({
        source_id: id,
        input: exportInput(agent),
        state: jsonable(safeAdminValue(agent)),
      });
    }
    await audit({
      action: "agent.export",
      targetType: ids.length === 1 ? "agent" : "agent-set",
      targetId: ids.length === 1 ? ids[0] : null,
      details: { ids, count: agents.length, format: "json" },
    });
    return {
      format: "evaself-agent-export",
      version: 1,
      exported_at: new Date().toISOString(),
      agents,
    };
  });

  app.get("/v1/sdk/agents/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { agent: safeAdminValue(await letta.getAgent(requireId(agentId, "agent_id"))) };
  });

  app.patch("/v1/sdk/agents/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const id = requireId(agentId, "agent_id");
    const input = managedAgentPatch(request.body);
    const before = await letta.getAgent(id);
    const agent = await letta.updateAgent(id, input);
    await audit({
      action: "agent.update",
      targetType: "agent",
      targetId: id,
      before: jsonable(auditAgentProjection(before)),
      after: jsonable(auditAgentProjection(agent)),
    });
    return { agent: safeAdminValue(agent) };
  });

  app.delete("/v1/sdk/agents/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const id = requireId(agentId, "agent_id");
    const confirmation = (request.query as { confirm?: string }).confirm;
    if (confirmation !== id) {
      throw badRequest("Удаление требует query-параметр confirm, равный agent_id");
    }
    // Удаление агента необратимо: вместе с ним уходят conversation, их
    // история и блоки. Незакончившийся ход или ожидающее подтверждение
    // означают, что человек прямо сейчас ждёт ответа, — такое удаление
    // отклоняется, а не выполняется «на всякий случай».
    await deleteGuard.assertAgentDeletable(id);
    const before = await letta.getAgent(id);
    await letta.deleteAgent(id);
    await db.archiveAgentLink(id);
    await audit({
      action: "agent.delete",
      targetType: "agent",
      targetId: id,
      before: jsonable(auditAgentProjection(before)),
    });
    return reply.status(204).send();
  });

  app.get("/v1/sdk/agents/:agentId/conversations", async (request) => {
    const { agentId } = request.params as { agentId: string };
    return {
      conversations: await letta.listConversations(requireId(agentId, "agent_id")),
    };
  });

  app.post("/v1/sdk/agents/:agentId/conversations", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const input = conversationInput(request.body);
    const conversation = await letta.createConversationRecord(
      requireId(agentId, "agent_id"),
      input,
    );
    const conversationId = (conversation as { id?: string }).id ?? null;
    await audit({
      action: "conversation.create",
      targetType: "conversation",
      targetId: conversationId,
      after: jsonable(conversation),
      details: { agent_id: agentId },
    });
    return reply.status(201).send({ conversation });
  });

  app.get("/v1/sdk/conversations/:conversationId", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    return {
      conversation: await letta.getConversation(requireId(conversationId, "conversation_id")),
    };
  });

  app.patch("/v1/sdk/conversations/:conversationId", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const input = conversationPatch(request.body);
    const id = requireId(conversationId, "conversation_id");
    // Архивирование — то же удаление с точки зрения идущего хода:
    // продолжить архивированный диалог нельзя, и ответ, который вот-вот
    // придёт, деться будет некуда.
    if (input.archived === true) await deleteGuard.assertConversationDeletable(id);
    const before = await letta.getConversation(id);
    const conversation = await letta.updateConversation(id, input);
    await audit({
      action: input.archived ? "conversation.archive" : "conversation.update",
      targetType: "conversation",
      targetId: id,
      before: jsonable(before),
      after: jsonable(conversation),
    });
    return {
      conversation,
    };
  });

  app.get("/v1/sdk/conversations/:conversationId/messages", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const id = requireId(conversationId, "conversation_id");
    const limit = Number.parseInt(String((request.query as { limit?: string }).limit ?? "60"), 10);
    return await letta.listMessages(id, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 60);
  });

  app.post("/v1/sdk/conversations/:conversationId/messages", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const id = requireId(conversationId, "conversation_id");
    const body = requireObject(request.body, "Сообщение");
    const text = requiredText(body.text, "text", 1, 100000);
    const conversation = await letta.getConversation(id) as {
      agent_id?: string;
      archived?: boolean;
    };
    if (conversation.archived) throw badRequest("Архивированный диалог нельзя продолжить");
    return await queue.run(adminQueueId(id), async () => {
      const result = await letta.runTurn(id, text);
      if (conversation.agent_id) await db.markAgentUsed(conversation.agent_id);
      await audit({
        action: "conversation.turn",
        targetType: "conversation",
        targetId: id,
        details: {
          agent_id: result.agentId,
          duration_ms: result.durationMs,
          stop_reason: result.stopReason,
          message_count: result.messageCount,
          tools: result.toolCalls,
        },
      });
      return result;
    }, { conversationId: id });
  });

  app.post("/v1/sdk/conversations/:conversationId/messages/stream", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const id = requireId(conversationId, "conversation_id");
    const body = requireObject(request.body, "Сообщение");
    const text = requiredText(body.text, "text", 1, 100000);
    const conversation = await letta.getConversation(id) as {
      agent_id?: string;
      archived?: boolean;
    };
    if (conversation.archived) throw badRequest("Архивированный диалог нельзя продолжить");

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let finished = false;
    const event = (name: string, value: unknown) => {
      if (finished || reply.raw.destroyed) return;
      reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    reply.raw.on("close", () => {
      if (!finished) void letta.abortTurn(id);
    });

    try {
      const result = await queue.run(
        adminQueueId(id),
        async () =>
          await letta.runTurn(id, text, {
            onDelta: (delta) => event("delta", { text: delta }),
          }),
        { conversationId: id },
      );
      if (conversation.agent_id) await db.markAgentUsed(conversation.agent_id);
      await audit({
        action: "conversation.turn-stream",
        targetType: "conversation",
        targetId: id,
        details: {
          agent_id: result.agentId,
          duration_ms: result.durationMs,
          stop_reason: result.stopReason,
          message_count: result.messageCount,
          tools: result.toolCalls,
        },
      });
      event("result", result);
    } catch (error) {
      event("error", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      finished = true;
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.get("/v1/sdk/conversations/:conversationId/session", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    return {
      session: await letta.sessionStatus(requireId(conversationId, "conversation_id")),
    };
  });

  app.post("/v1/sdk/conversations/:conversationId/abort", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const id = requireId(conversationId, "conversation_id");
    const result = await letta.abortTurn(id);
    await audit({
      action: "conversation.abort",
      targetType: "conversation",
      targetId: id,
      details: result,
    });
    return result;
  });

  app.get("/v1/audit", async (request) => {
    const query = request.query as {
      limit?: string;
      target_type?: string;
      target_id?: string;
    };
    const parsed = Number.parseInt(query.limit ?? "100", 10);
    return {
      events: await db.listAdminAudit({
        limit: Number.isFinite(parsed) ? parsed : 100,
        targetType: query.target_type,
        targetId: query.target_id,
      }),
    };
  });

  app.post("/v1/users/ensure", async (request) => {
    const body = request.body as {
      telegram_id?: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
      create_agent?: boolean;
    };
    if (typeof body?.telegram_id !== "number") throw badRequest("telegram_id обязателен");

    const user = await db.upsertUser({
      telegramId: body.telegram_id,
      username: body.username ?? null,
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      languageCode: body.language_code ?? null,
    });

    let link = await db.getAgentLink(body.telegram_id);
    let agentCreated = false;
    let conversationCreated = false;

    if (!link && body.create_agent !== false) {
      // The database may have been restored without the App Server state, or
      // the other way round: ask Letta before creating a duplicate agent.
      let agentId = await letta.findAgentByTelegramId(body.telegram_id);
      if (!agentId) {
        const displayName =
          [body.first_name, body.last_name].filter(Boolean).join(" ") ||
          body.username ||
          String(body.telegram_id);
        agentId = await letta.createAgent({ telegramId: body.telegram_id, displayName });
        agentCreated = true;
      }
      const conversationId = await letta.createConversation(agentId);
      conversationCreated = true;
      link = await db.saveAgentLink({
        userId: user.id,
        agentId,
        conversationId,
        agentName: `eva-${body.telegram_id}`,
        model: config.model || null,
      });
    }

    // An agent restored without its conversation gets a fresh one.
    if (link && !link.conversation_id) {
      const conversationId = await letta.createConversation(link.agent_id);
      await db.setConversation(link.agent_id, conversationId, user.id);
      link = { ...link, conversation_id: conversationId };
      conversationCreated = true;
    }

    return {
      user: publicUser(user),
      agent: publicAgent(link),
      agent_created: agentCreated,
      conversation_created: conversationCreated,
    };
  });

  app.get("/v1/users/:telegramId", async (request) => {
    const telegramId = telegramIdOf(request);
    const overview = await db.getUserOverview(telegramId);
    if (!overview) throw notFound(`Пользователь с telegram_id=${telegramId} не найден`);
    return {
      ...(jsonable(overview) as Record<string, unknown>),
      quotas: await db.getQuotaStatus(telegramId),
    };
  });

  app.get("/v1/agents", async () => ({ agents: await db.listAgentLinks() }));

  app.get("/v1/agents/live", async () => ({ agents: await letta.listAgents() }));

  app.get("/v1/agents/:telegramId", async (request) => {
    const link = await requireLink(db, telegramIdOf(request));
    return { agent: publicAgent(link) };
  });

  app.get("/v1/conversations/:telegramId", async (request) => {
    const link = await requireLink(db, telegramIdOf(request));
    return {
      agent_id: link.agent_id,
      active_conversation_id: link.conversation_id,
      conversations: await letta.listConversations(link.agent_id),
    };
  });

  /** Start a fresh conversation and make it the active one. */
  app.post("/v1/conversations/:telegramId", async (request) => {
    const telegramId = telegramIdOf(request);
    const link = await requireLink(db, telegramId);
    const conversationId = await letta.createConversation(link.agent_id);
    await db.setConversation(link.agent_id, conversationId, link.user_id);
    logger.info("Активный conversation переключён", { telegramId, conversationId });
    return { agent_id: link.agent_id, conversation_id: conversationId };
  });

  app.get("/v1/conversations/:telegramId/messages", async (request) => {
    const link = await requireLink(db, telegramIdOf(request));
    const conversationId = requireConversation(link);
    const limit = Number.parseInt(String((request.query as { limit?: string }).limit ?? "50"), 10);
    return await letta.listMessages(conversationId, Number.isFinite(limit) ? limit : 50);
  });

  // ---------------------------------------------------------------
  // turns
  // ---------------------------------------------------------------
  app.post("/v1/messages", async (request) => {
    const body = request.body as {
      telegram_id?: number;
      text?: string;
      metric?: string;
      count_usage?: boolean;
    };
    if (typeof body?.telegram_id !== "number") throw badRequest("telegram_id обязателен");
    if (!body.text || !body.text.trim()) throw badRequest("text обязателен");

    const telegramId = body.telegram_id;
    const link = await requireLink(db, telegramId);
    const conversationId = requireConversation(link);

    return await queue.run(telegramId, async () => {
      const result = await letta.runTurn(conversationId, body.text!.trim());
      await db.markAgentUsed(link.agent_id);
      const usageAfter =
        body.count_usage === false
          ? null
          : await db.incrementUsage(telegramId, body.metric ?? "messages");
      return { ...result, usage_after: usageAfter };
    }, { userId: Number(link.user_id), conversationId });
  });

  /**
   * Server-sent events. The SDK streams natively; this forwards the deltas so
   * a workflow (or the WebApp) can show text as it arrives instead of waiting
   * for the whole turn.
   */
  app.post("/v1/messages/stream", async (request, reply) => {
    const body = request.body as { telegram_id?: number; text?: string };
    if (typeof body?.telegram_id !== "number") throw badRequest("telegram_id обязателен");
    if (!body.text?.trim()) throw badRequest("text обязателен");

    const telegramId = body.telegram_id;
    const link = await requireLink(db, telegramId);
    const conversationId = requireConversation(link);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await queue.run(
        telegramId,
        async () =>
          letta.runTurn(conversationId, body.text!.trim(), {
            onDelta: (text) => send("delta", { text }),
          }),
        { userId: Number(link.user_id), conversationId },
      );
      await db.markAgentUsed(link.agent_id);
      send("done", result);
    } catch (error) {
      const evaError = error instanceof EvaError ? error : new EvaError(String(error));
      send("error", evaError.toPayload());
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  // ---------------------------------------------------------------
  // operations
  // ---------------------------------------------------------------
  app.post("/v1/locks/:telegramId/release", async (request) => {
    const telegramId = telegramIdOf(request);
    return { telegram_id: telegramId, released: await queue.forceRelease(telegramId) };
  });

  app.get("/v1/models", async () => ({ models: await letta.listModels() }));

  // ---------------------------------------------------------------
  // Централизованные настройки OpenAI-compatible LLM
  // ---------------------------------------------------------------
  app.get("/v1/llm/providers", async () => ({
    providers: await llm.list(),
  }));

  app.post("/v1/llm/providers", async (request, reply) => {
    const provider = await llm.create(request.body as LlmProviderInput);
    return reply.status(201).send({ provider });
  });

  app.patch("/v1/llm/providers/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { provider: await llm.update(id, request.body as Partial<LlmProviderInput>) };
  });

  app.delete("/v1/llm/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await llm.remove(id);
    return reply.status(204).send();
  });

  app.post("/v1/llm/providers/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    return { result: await llm.test(id) };
  });

  app.get("/v1/llm/providers/:id/models", async (request) => {
    const { id } = request.params as { id: string };
    return { result: await llm.models(id) };
  });

  app.post("/v1/llm/providers/:id/activate", async (request) => {
    const { id } = request.params as { id: string };
    return { provider: await llm.activate(id) };
  });

  // Установщик вызывает этот endpoint без передачи API key по argv.
  // Повторный импорт запрещён менеджером, если в реестре уже есть записи.
  app.post("/v1/llm/import-env", async () => ({
    provider: await llm.importEnvironment(),
  }));

  app.get("/v1/stats", async () => ({
    ...(jsonable(await db.stats()) as Record<string, unknown>),
    sessions_open: letta.openSessions,
    users_queued: queue.queuedUsers,
  }));

  app.get("/v1/quota/:telegramId", async (request) => ({
    quotas: await db.getQuotaStatus(telegramIdOf(request)),
  }));

  return app;
}

// -------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------
async function requireLink(db: Database, telegramId: number) {
  const link = await db.getAgentLink(telegramId);
  if (!link) {
    throw notFound(`Нет agent для telegram_id=${telegramId}; сначала вызовите /v1/users/ensure`);
  }
  return link;
}

function requireConversation(link: { conversation_id: string | null }): string {
  if (!link.conversation_id) {
    throw notFound("У agent нет активного conversation; вызовите POST /v1/conversations/{id}");
  }
  return link.conversation_id;
}

function publicUser(user: Record<string, unknown> | object | null): unknown {
  if (!user) return null;
  const row = user as Record<string, unknown>;
  return jsonable({
    id: row.id,
    telegram_id: row.telegram_id,
    username: row.username,
    first_name: row.first_name,
    language_code: row.language_code,
    state: row.state,
    is_blocked: row.is_blocked,
    created_at: row.created_at,
  });
}

function publicAgent(link: Record<string, unknown> | object | null): unknown {
  if (!link) return null;
  const row = link as Record<string, unknown>;
  return jsonable({
    agent_id: row.agent_id,
    conversation_id: row.conversation_id,
    agent_name: row.agent_name,
    kind: row.kind,
    model: row.model,
    runtime: row.runtime,
    message_count: row.message_count,
    last_message_at: row.last_message_at,
  });
}

/** Dates and BigInt-ish values become JSON-friendly primitives. */
export function jsonable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonable(item);
    return out;
  }
  return value;
}

const ADMIN_SECRET_KEY =
  /(^|[_-])(api[_-]?key|authorization|password|secret|credential|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie)$/i;
const ADMIN_SECRET_CONTAINERS = new Set([
  "environment",
  "environment_variables",
  "env",
  "secrets",
  "tool_exec_environment_variables",
]);

/** Never expose per-agent environment values through the browser or exports. */
export function safeAdminValue(value: unknown, depth = 0, parentKey = ""): unknown {
  if (depth > 12) return "[глубина ограничена]";
  if (Array.isArray(value)) {
    if (ADMIN_SECRET_CONTAINERS.has(parentKey)) {
      return value.map((item) => {
        if (!item || typeof item !== "object") return { configured: true };
        const source = item as Record<string, unknown>;
        return {
          ...Object.fromEntries(
            Object.entries(source)
              .filter(([key]) => !["value", "secret", "encrypted_value"].includes(key))
              .map(([key, nested]) => [key, safeAdminValue(nested, depth + 1, key)]),
          ),
          configured: true,
          value: "[скрыто]",
        };
      });
    }
    return value.map((item) => safeAdminValue(item, depth + 1, parentKey));
  }
  if (value && typeof value === "object") {
    if (ADMIN_SECRET_CONTAINERS.has(parentKey)) {
      return Object.fromEntries(
        Object.keys(value).map((key) => [key, "[скрыто]"]),
      );
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = ADMIN_SECRET_KEY.test(key)
        ? "[скрыто]"
        : safeAdminValue(item, depth + 1, key);
    }
    return result;
  }
  return value;
}

function auditAgentProjection(value: unknown): Record<string, unknown> {
  const safe = safeAdminValue(value) as Record<string, unknown>;
  return Object.fromEntries(
    [
      "id",
      "name",
      "description",
      "agent_type",
      "model",
      "model_settings",
      "embedding",
      "context_window_limit",
      "system",
      "tags",
      "hidden",
      "updated_at",
      "last_run_completion",
      "last_stop_reason",
    ]
      .filter((key) => safe[key] !== undefined)
      .map((key) => [key, safe[key]]),
  );
}

function managedAgentInput(value: unknown, requireName: boolean): ManagedAgentInput {
  const body = requireObject(value, "Агент");
  const name = requireName
    ? requiredText(body.name, "name", 1, 100)
    : optionalText(body.name, "name", 1, 100);
  const permission = optionalEnum(
    body.permission_mode,
    "permission_mode",
    ["standard", "acceptEdits", "unrestricted", "strict"],
  ) as ManagedAgentInput["permission_mode"];
  const skillSources = optionalStringArray(body.skill_sources, "skill_sources", 4);
  if (
    skillSources?.some(
      (source) => !["bundled", "global", "agent", "project"].includes(source),
    )
  ) {
    throw badRequest("skill_sources содержит неизвестный источник");
  }
  return compact({
    name,
    description: optionalText(body.description, "description", 0, 1000),
    hidden: optionalBoolean(body.hidden, "hidden"),
    personality: optionalText(body.personality, "personality", 1, 100),
    embedding: optionalText(body.embedding, "embedding", 1, 300),
    persona: optionalText(body.persona, "persona", 0, 100000),
    human: optionalText(body.human, "human", 0, 10000),
    memory: optionalMemoryBlocks(body.memory),
    tags: optionalStringArray(body.tags, "tags", 64),
    model: optionalText(body.model, "model", 1, 300),
    model_settings: optionalObject(body.model_settings, "model_settings"),
    context_window: optionalInteger(body.context_window, "context_window", 1024, 10_000_000),
    permission_mode: permission,
    memfs_enabled: optionalBoolean(body.memfs_enabled, "memfs_enabled"),
    system_prompt: optionalNullableText(body.system_prompt, "system_prompt", 100000),
    system_prompt_preset: optionalEnum(
      body.system_prompt_preset,
      "system_prompt_preset",
      ["default", "letta-claude", "letta-codex", "letta-gemini", "claude", "codex", "gemini"],
    ) as ManagedAgentInput["system_prompt_preset"],
    system_prompt_append: optionalText(
      body.system_prompt_append,
      "system_prompt_append",
      0,
      100000,
    ),
    base_tools: optionalNullableStringArray(body.base_tools, "base_tools", 128),
    allowed_tools: optionalNullableStringArray(body.allowed_tools, "allowed_tools", 128),
    disallowed_tools: optionalStringArray(body.disallowed_tools, "disallowed_tools", 128),
    skill_sources: skillSources as ManagedAgentInput["skill_sources"],
    system_info_reminder: optionalBoolean(
      body.system_info_reminder,
      "system_info_reminder",
    ),
    dreaming: optionalObject(body.dreaming, "dreaming"),
    create_conversation: optionalBoolean(body.create_conversation, "create_conversation"),
  }) as ManagedAgentInput;
}

function managedAgentPatch(value: unknown): Parameters<LettaService["updateAgent"]>[1] {
  const body = requireObject(value, "Изменения агента");
  return compact({
    name: optionalText(body.name, "name", 1, 100),
    description: optionalText(body.description, "description", 0, 1000),
    model: optionalText(body.model, "model", 1, 300),
    model_settings: optionalObject(body.model_settings, "model_settings"),
    system: optionalText(body.system, "system", 0, 100000),
    tags: optionalStringArray(body.tags, "tags", 64),
    hidden: optionalBoolean(body.hidden, "hidden"),
    context_window: optionalInteger(body.context_window, "context_window", 1024, 10_000_000),
  });
}

function conversationInput(value: unknown): Parameters<LettaService["createConversationRecord"]>[1] {
  const body = value == null ? {} : requireObject(value, "Диалог");
  return compact({
    summary: optionalText(body.summary, "summary", 0, 1000),
    description: optionalText(body.description, "description", 0, 5000),
    model: optionalText(body.model, "model", 1, 300),
    model_settings: optionalObject(body.model_settings, "model_settings"),
    context_window: optionalInteger(body.context_window, "context_window", 1024, 10_000_000),
    hidden: optionalBoolean(body.hidden, "hidden"),
  });
}

function conversationPatch(value: unknown): Parameters<LettaService["updateConversation"]>[1] {
  const body = requireObject(value, "Изменения диалога");
  return compact({
    summary: optionalText(body.summary, "summary", 0, 1000),
    description: optionalText(body.description, "description", 0, 5000),
    model: optionalText(body.model, "model", 1, 300),
    model_settings: optionalObject(body.model_settings, "model_settings"),
    context_window: optionalInteger(body.context_window, "context_window", 1024, 10_000_000),
    archived: optionalBoolean(body.archived, "archived"),
  });
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${label}: ожидается JSON-объект`);
  }
  return value as Record<string, unknown>;
}

function requireId(value: unknown, field: string): string {
  return requiredText(value, field, 1, 300);
}

function requiredText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") throw badRequest(`${field} должен быть строкой`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw badRequest(`${field}: допустимая длина ${min}–${max}`);
  }
  return result;
}

function optionalText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, min, max);
}

function optionalNullableText(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return requiredText(value, field, 0, max);
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw badRequest(`${field} должен быть массивом не более ${maxItems} строк`);
  }
  return [...new Set(value.map((item) => requiredText(item, field, 1, 200)))];
}

function optionalNullableStringArray(
  value: unknown,
  field: string,
  maxItems: number,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalStringArray(value, field, maxItems);
}

function optionalObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${field} должен быть JSON-объектом`);
  }
  return value as Record<string, unknown>;
}

function optionalMemoryBlocks(
  value: unknown,
): ManagedAgentInput["memory"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw badRequest("memory должен быть массивом не более 32 блоков");
  }
  const labels = new Set<string>();
  return value.map((item, index) => {
    const block = requireObject(item, `memory[${index}]`);
    const label = requiredText(block.label, `memory[${index}].label`, 1, 100);
    if (labels.has(label)) throw badRequest(`memory: повторяющийся label ${label}`);
    labels.add(label);
    return {
      label,
      value: requiredText(block.value, `memory[${index}].value`, 0, 100_000),
      description: optionalNullableText(
        block.description,
        `memory[${index}].description`,
        2_000,
      ),
      read_only: optionalBoolean(block.read_only, `memory[${index}].read_only`),
      hidden: optionalBoolean(block.hidden, `memory[${index}].hidden`),
      limit: optionalInteger(block.limit, `memory[${index}].limit`, 1, 1_000_000) ?? undefined,
    };
  });
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} должен быть целым числом от ${min} до ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} должен быть boolean`);
  return value;
}

function optionalEnum(
  value: unknown,
  field: string,
  allowed: string[],
): string | undefined {
  if (value === undefined) return undefined;
  const result = requiredText(value, field, 1, 100);
  if (!allowed.includes(result)) throw badRequest(`${field}: недопустимое значение`);
  return result;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function rollbackPatch(value: unknown): Parameters<LettaService["updateAgent"]>[1] {
  const agent = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return compact({
    name: typeof agent.name === "string" ? agent.name : undefined,
    description: typeof agent.description === "string" ? agent.description : "",
    model: typeof agent.model === "string" ? agent.model : undefined,
    model_settings:
      agent.model_settings && typeof agent.model_settings === "object"
        ? agent.model_settings as Record<string, unknown>
        : undefined,
    system: typeof agent.system === "string" ? agent.system : undefined,
    tags: Array.isArray(agent.tags)
      ? agent.tags.filter((item): item is string => typeof item === "string")
      : undefined,
    hidden: typeof agent.hidden === "boolean" ? agent.hidden : false,
    context_window:
      typeof agent.context_window_limit === "number"
        ? agent.context_window_limit
        : null,
  });
}

function exportInput(value: unknown): Record<string, unknown> {
  const agent = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const rawBlocks = Array.isArray(agent.blocks)
    ? agent.blocks
    : agent.memory && typeof agent.memory === "object"
      && Array.isArray((agent.memory as { blocks?: unknown[] }).blocks)
      ? (agent.memory as { blocks: unknown[] }).blocks
      : [];
  const memory = rawBlocks.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const block = raw as Record<string, unknown>;
    if (typeof block.label !== "string" || typeof block.value !== "string") return [];
    return [{
      label: block.label,
      value: block.value,
      ...(typeof block.description === "string" ? { description: block.description } : {}),
      ...(typeof block.read_only === "boolean" ? { read_only: block.read_only } : {}),
      ...(typeof block.hidden === "boolean" ? { hidden: block.hidden } : {}),
      ...(typeof block.limit === "number" ? { limit: block.limit } : {}),
    }];
  });
  return compact({
    name: typeof agent.name === "string" ? agent.name : "Импортированный агент",
    description: typeof agent.description === "string" ? agent.description : "",
    hidden: typeof agent.hidden === "boolean" ? agent.hidden : false,
    embedding: typeof agent.embedding === "string" ? agent.embedding : undefined,
    memory: memory.length > 0 ? memory : undefined,
    tags: Array.isArray(agent.tags)
      ? agent.tags.filter((item): item is string => typeof item === "string")
      : [],
    model: typeof agent.model === "string" ? agent.model : undefined,
    model_settings:
      agent.model_settings && typeof agent.model_settings === "object"
        ? agent.model_settings as Record<string, unknown>
        : undefined,
    context_window:
      typeof agent.context_window_limit === "number"
        ? agent.context_window_limit
        : undefined,
    system_prompt: typeof agent.system === "string" ? agent.system : undefined,
    create_conversation: true,
  });
}

/** Stable negative queue namespace for direct WebUI conversations. */
function adminQueueId(conversationId: string): number {
  let hash = 2166136261;
  for (const character of conversationId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return -Math.max(hash >>> 0, 1);
}
