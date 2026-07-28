/**
 * HTTP surface. Only n8n calls it, always with `X-API-Key`.
 *
 * n8n never reaches the Letta App Server directly — every agent, session,
 * memory, skill and tool operation goes through these routes.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { EvaError, badRequest, notFound, unauthorized } from "./errors.js";
import type { LettaService } from "./letta.js";
import type { LlmManager, LlmProviderInput } from "./llm.js";
import type { Logger } from "./logger.js";
import type { UserQueue } from "./queue.js";

export const VERSION = "0.2.0";

export interface Services {
  config: Config;
  logger: Logger;
  db: Database;
  letta: LettaService;
  llm: LlmManager;
  queue: UserQueue;
  redisPing: () => Promise<boolean>;
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
  const { config, logger, db, letta, llm, queue } = services;

  // Fastify's own logger is off: this service logs through logger.ts so
  // every line in the stack has the same JSON shape.
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  // ---------------------------------------------------------------
  // auth: everything under /v1 needs the internal key
  // ---------------------------------------------------------------
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/")) return;
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

  // ---------------------------------------------------------------
  // health — unauthenticated, used by Docker and `make doctor`
  // ---------------------------------------------------------------
  app.get("/health", async (_request, reply: FastifyReply) => {
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
      await db.setConversation(link.agent_id, conversationId);
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
    await db.setConversation(link.agent_id, conversationId);
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
    });
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
      const result = await queue.run(telegramId, async () =>
        letta.runTurn(conversationId, body.text!.trim(), {
          onDelta: (text) => send("delta", { text }),
        }),
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
  if (Array.isArray(value)) return value.map(jsonable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonable(item);
    return out;
  }
  return value;
}
