import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { Logger } from "../logger.js";
import {
  expiredSessionCookies,
  type AdminRole,
  type AuthenticatedSession,
  AuthService,
  roleAllowed,
  sessionCookies,
} from "./auth-service.js";
import { AuditService, type AuditActor } from "./audit-service.js";
import { ConfigService } from "./config-service.js";
import {
  AdminApiError,
  adminBadRequest,
  adminForbidden,
  adminNotFound,
} from "./errors.js";
import { auditParams, globalSecretRedactor } from "./redactor.js";
import { SecretStore } from "./secret-store.js";

interface RouteAccess {
  public?: boolean;
  roles?: AdminRole[];
  csrfExempt?: boolean;
  sudoScope?: string;
}

interface RequestContext {
  requestId: string;
  startedAt: number;
  session?: AuthenticatedSession;
  audit?: { id: string; startedAt: number };
}

export interface AdminServerServices {
  auth: AuthService;
  audit: AuditService;
  config: ConfigService;
  secrets: SecretStore;
  logger: Logger;
  readiness: () => Promise<boolean>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw adminBadRequest("Ожидается JSON-объект");
  }
  return body as Record<string, unknown>;
}

function accessOf(request: FastifyRequest): RouteAccess {
  return (request.routeOptions.config ?? {}) as RouteAccess;
}

function actorOf(context: RequestContext): AuditActor {
  return context.session
    ? {
        id: context.session.user.id,
        username: context.session.user.username,
        role: context.session.user.role,
      }
    : { id: null, username: "anonymous", role: null };
}

function safeIp(ip: string): string | null {
  const normalized = ip.replace(/^::ffff:/, "");
  return /^[0-9a-f:.]+$/i.test(normalized) ? normalized : null;
}

function requestIdOf(request: FastifyRequest): string {
  const incoming = request.headers["x-request-id"];
  return typeof incoming === "string" && /^[A-Za-z0-9._-]{8,100}$/.test(incoming)
    ? incoming
    : randomUUID();
}

export function buildAdminServer(services: AdminServerServices): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 512 * 1024,
  });
  const contexts = new WeakMap<FastifyRequest, RequestContext>();

  app.addHook("onRequest", async (request, reply) => {
    const requestId = requestIdOf(request);
    contexts.set(request, { requestId, startedAt: Date.now() });
    reply.header("X-Request-Id", requestId);
    reply.header("Cache-Control", "no-store");
  });

  // Audit starts before authentication/authorization and therefore before
  // any administrative state change can happen.
  app.addHook("preValidation", async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const context = contexts.get(request)!;
    context.audit = await services.audit.start({
      requestId: context.requestId,
      operation: `${request.method} ${request.routeOptions.url}`,
      target: request.url.split("?")[0] ?? null,
      ip: safeIp(request.ip),
      actor: actorOf(context),
      params: auditParams(request.url, request.body, request.params),
    });
  });

  app.addHook("preHandler", async (request) => {
    const access = accessOf(request);
    if (access.public) return;
    const context = contexts.get(request)!;
    const session = await services.auth.authenticate(request.headers.cookie);
    context.session = session;
    if (access.roles && !roleAllowed(session.user.role, access.roles)) {
      throw adminForbidden();
    }
    if (!SAFE_METHODS.has(request.method) && !access.csrfExempt) {
      services.auth.requireCsrf(
        session,
        request.headers.cookie,
        request.headers["x-csrf-token"],
      );
    }
    if (access.sudoScope) {
      await services.auth.requireSudo(session.id, access.sudoScope);
    }
  });

  app.addHook("onError", async (request, _reply, error) => {
    const context = contexts.get(request);
    if (!context?.audit) return;
    const code = error instanceof AdminApiError ? error.code : "internal_error";
    await services.audit.finish(
      context.audit.id,
      context.audit.startedAt,
      "failure",
      code,
      actorOf(context),
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    const context = contexts.get(request);
    if (!context?.audit) return;
    await services.audit.finish(
      context.audit.id,
      context.audit.startedAt,
      reply.statusCode < 400 ? "success" : "failure",
      reply.statusCode < 400 ? null : `http_${reply.statusCode}`,
      actorOf(context),
    );
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const context = contexts.get(request);
    const apiError = error instanceof AdminApiError
      ? error
      : new AdminApiError(
          "internal_error",
          "Внутренняя ошибка административного API",
          (error as { statusCode?: number })?.statusCode === 400 ? 400 : 500,
        );
    services.logger.error("Ошибка admin-api", {
      request_id: context?.requestId,
      url: request.url,
      code: apiError.code,
      status: apiError.statusCode,
    });
    reply.status(apiError.statusCode).send({
      error: {
        code: apiError.code,
        message: apiError.message,
        details: globalSecretRedactor.redact(apiError.details),
        request_id: context?.requestId ?? randomUUID(),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const context = contexts.get(request);
    const error = adminNotFound("Маршрут не найден");
    reply.status(404).send({
      error: {
        code: error.code,
        message: error.message,
        details: {},
        request_id: context?.requestId ?? randomUUID(),
      },
    });
  });

  app.get("/health", { config: { public: true } }, async (_request, reply) => {
    const ready = await services.readiness();
    return reply.status(ready ? 200 : 503).send({
      service: "evaself-admin-api",
      status: ready ? "ok" : "degraded",
      phase: 1,
    });
  });

  app.post("/api/admin/v1/auth/login", {
    config: { public: true, csrfExempt: true } satisfies RouteAccess,
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const result = await services.auth.login(
      username,
      password,
      request.ip,
      String(request.headers["user-agent"] ?? ""),
    );
    const context = contexts.get(request)!;
    context.session = {
      id: "",
      user: result.user,
      csrfHash: Buffer.alloc(0),
    };
    reply.header("Set-Cookie", sessionCookies(result));
    return { user: result.user };
  });

  app.post("/api/admin/v1/auth/logout", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request, reply) => {
    await services.auth.logout(contexts.get(request)!.session!.id);
    reply.header("Set-Cookie", expiredSessionCookies());
    return reply.status(204).send();
  });

  app.post("/api/admin/v1/auth/password", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    await services.auth.changePassword(
      contexts.get(request)!.session!,
      currentPassword,
      newPassword,
    );
    return reply.status(204).send();
  });

  app.get("/api/admin/v1/me", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => ({ user: contexts.get(request)!.session!.user }));

  app.post("/api/admin/v1/sudo", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const password = typeof body.password === "string" ? body.password : "";
    const scope = typeof body.scope === "string" ? body.scope : "";
    const expiresAt = await services.auth.grantSudo(
      contexts.get(request)!.session!,
      password,
      scope,
    );
    return reply.status(201).send({ scope, expires_at: expiresAt.toISOString() });
  });

  app.get("/api/admin/v1/settings", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (_request, reply: FastifyReply) => {
    const result = await services.config.getAll();
    reply.header("ETag", result.etag);
    return result;
  });

  app.put("/api/admin/v1/settings", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const result = await services.config.update(
      body.settings,
      typeof request.headers["if-match"] === "string" ? request.headers["if-match"] : undefined,
      contexts.get(request)!.session!.user.id,
    );
    reply.header("ETag", result.etag);
    return result;
  });

  app.post("/api/admin/v1/settings/rollback/:versionId", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const raw = (request.params as { versionId?: string }).versionId ?? "";
    const result = await services.config.rollback(
      Number.parseInt(raw, 10),
      contexts.get(request)!.session!.user.id,
    );
    reply.header("ETag", result.etag);
    return result;
  });

  app.get("/api/admin/v1/secrets", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async () => ({ secrets: await services.secrets.list() }));

  app.put("/api/admin/v1/secrets/:secretRef", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "secrets:write",
    } satisfies RouteAccess,
  }, async (request) => {
    const body = objectBody(request.body);
    const secretRef = (request.params as { secretRef?: string }).secretRef ?? "";
    const value = typeof body.value === "string" ? body.value : "";
    return await services.secrets.put(
      secretRef,
      value,
      body.used_by,
      contexts.get(request)!.session!.user.id,
    );
  });

  app.get("/api/admin/v1/audit", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const raw = (request.query as { limit?: string }).limit;
    const limit = raw ? Number.parseInt(raw, 10) : 100;
    return { events: await services.audit.list(Number.isFinite(limit) ? limit : 100) };
  });

  return app;
}
