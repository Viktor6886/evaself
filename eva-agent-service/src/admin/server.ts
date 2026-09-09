import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { Logger } from "../logger.js";
import { adminScope, enterScope, type AdminScope } from "../tenancy/index.js";
import {
  expiredSessionCookies,
  type AdminRole,
  type AuthenticatedSession,
  AuthService,
  roleAllowed,
  sessionCookies,
} from "./auth-service.js";
import type { ArtifactRegistry } from "../artifacts/registry.js";
import type { AgentDirectoryService } from "./agent-directory.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerCrudRoutes } from "./crud-routes.js";
import { registerPanelRoutes } from "./panel-routes.js";
import type { AdminAgentService } from "./agent-admin-service.js";
import type { SubscriptionAdminService } from "./subscription-service.js";
import type { PersonaAdminService } from "./persona-admin-service.js";
import type { LettaConsoleService } from "./letta-console-service.js";
import type { ToolApprovalService } from "./tool-approvals.js";
import type { TurnOperationsService } from "./turn-operations.js";
import type { McpServerPolicyRepository } from "../tools/mcp.js";
import { EvaError } from "../errors.js";
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
import type { SecurityAuditService } from "./security-audit.js";
import type { TariffService } from "./tariff-service.js";
import type { TelegramTokenService } from "./telegram-token-service.js";
import { HealthService } from "./health-service.js";
import { IntegrationConfigService, MEDIA_INTEGRATIONS } from "./integration-config-service.js";
import { LlmRouterAdminService } from "./llm-router-service.js";
import { OperationService } from "./operation-service.js";
import { ProviderService } from "./provider-service.js";
import { SttAdminService } from "./stt-service.js";
import { UserService } from "./user-service.js";
import type { Redis } from "ioredis";

interface RouteAccess {
  public?: boolean;
  roles?: AdminRole[];
  csrfExempt?: boolean;
  sudoScope?: string;
  /**
   * Маршрут читает или меняет данные пользователей Евы. Такой доступ
   * всегда идёт под ролью И под записью аудита: для безопасных методов
   * запись создаётся здесь же, иначе граница арендатора не пропустит
   * запрос к пользовательским таблицам.
   */
  tenantAccess?: "cross-user";
}

interface RequestContext {
  requestId: string;
  startedAt: number;
  session?: AuthenticatedSession;
  audit?: { id: string; startedAt: number };
  /** Рамка арендатора запроса; заполняется по мере проверок. */
  scope: AdminScope;
}

export interface AdminServerServices {
  auth: AuthService;
  audit: AuditService;
  config: ConfigService;
  secrets: SecretStore;
  health: HealthService;
  operations: OperationService;
  providers: ProviderService;
  llmRouter: LlmRouterAdminService;
  stt: SttAdminService;
  integrations: IntegrationConfigService;
  users: UserService;
  contextManagement?: {
    get(): Promise<unknown>;
    update(body: Record<string, unknown>): Promise<unknown>;
    updateConversation(id: string, contextWindowLimit: number): Promise<unknown>;
  };
  securityAudit?: SecurityAuditService;
  telegramTokens?: TelegramTokenService;
  tariffs?: TariffService;
  /**
   * Возврат звёзд. Отсутствует — маршрут отвечает отказом, а не делает
   * вид, что вернул: деньги молча не возвращаются.
   */
  starsRefund?: (chargeId: string) => Promise<Record<string, unknown>>;
  /** Предпросмотр политик хранения. Удаление выполняет задание очереди. */
  retention?: { preview(settings: Record<string, unknown>): Promise<unknown> };
  /** Единый реестр артефактов. Отсутствует — раздел просто не появляется. */
  artifacts?: ArtifactRegistry;
  /**
   * Полный административный CRUD (шаг 12). Регистрируется целиком или не
   * регистрируется вовсе: половина разделов хуже, чем ни одного, — по
   * отсутствию маршрута видно, что подсистема выключена, а по половине
   * разделов не видно ничего.
   */
  crud?: {
    directory: AgentDirectoryService;
    tools: ToolApprovalService;
    mcp?: McpServerPolicyRepository;
    turns: TurnOperationsService;
  };
  /**
   * Разделы единой панели: агенты, подписки, персона и промпт, Letta и
   * мониторинг. Флага у них нет намеренно — это и есть административная
   * панель, а не эксперимент поверх неё: выключенный раздел «Агенты»
   * означал бы установку, которой нечем управлять.
   */
  panel?: {
    agents: AdminAgentService;
    subscriptions: SubscriptionAdminService;
    persona: PersonaAdminService;
    letta: LettaConsoleService;
  };
  events: Redis;
  logger: Logger;
  readiness: () => Promise<boolean>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Отчёт Security Audit за флагом.
 *
 * Читается на каждом запросе, а не один раз при старте: оператор
 * включает флаг и перезапускает admin-api, но и без перезапуска
 * поведение остаётся предсказуемым.
 */
function securityAuditEnabled(): boolean {
  return flagEnabled(process.env.EVA_SECURITY_AUDIT);
}

/**
 * Полный административный CRUD за флагом `EVA_ADMIN_CRUD`.
 *
 * Читается при сборке сервера, а не на каждом запросе: раздел либо есть
 * целиком, либо его нет, и половина маршрутов при переключении флага на
 * живом процессе была бы хуже обоих состояний.
 */
function adminCrudEnabled(): boolean {
  return flagEnabled(process.env.EVA_ADMIN_CRUD);
}

/**
 * Реестр версий артефактов за флагом `EVA_ARTIFACT_VERSIONS`.
 *
 * Флаг объявлен заданием шага 13, и без него маршруты реестра были бы
 * единственным значимым изменением batch без выключателя. Значение это
 * имеет ровно потому, что публикация версии меняет то, на чём работают
 * живые ходы: инвариант 22 требует, чтобы такое можно было выключить, не
 * откатывая схему.
 *
 * Раздел шага 12 остаётся под своим флагом: применение шаблона memory
 * block читает версии из тех же таблиц, но выключаются эти два раздела
 * независимо — у них разные последствия и разная цена ошибки.
 */
function artifactVersionsEnabled(): boolean {
  return flagEnabled(process.env.EVA_ARTIFACT_VERSIONS);
}

function flagEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Отказ доменного слоя — административным ответом.
 *
 * Раньше всё, что не `AdminApiError`, становилось `internal_error`: и
 * «версия не утверждена», и «удаление запрещено, пока идёт ход», и
 * «операции нет в установленной версии пакета». Администратор видел
 * «внутренняя ошибка» там, где на самом деле система работала правильно и
 * могла объяснить, что не так.
 *
 * Переносится только код, статус и сообщение — то, что мы сами написали.
 * Причина отказа драйвера, стек и текст провайдера остаются
 * `internal_error`: их содержимое нам неизвестно, а значит, показывать его
 * нельзя.
 */
function toAdminError(error: unknown): AdminApiError {
  if (error instanceof AdminApiError) return error;
  if (error instanceof EvaError) {
    // Отдельно названы два исхода, которые легче всего принять за поломку:
    // `unsupported_operation` — честное «этот путь никогда не выполнялся»
    // (501, повторять бессмысленно), а retryable-отказ — «сейчас нельзя,
    // позже можно» (503). Всё, что сервис объявил кодом ниже 500, уходит
    // как есть: это наши собственные сообщения, а не текст провайдера.
    if (error.code === "unsupported_operation") {
      return new AdminApiError(error.code, error.message, 501, safeDetails(error.details));
    }
    if (error.statusCode < 500) {
      return new AdminApiError(error.code, error.message, error.statusCode, safeDetails(error.details));
    }
    if (error.retryable) {
      return new AdminApiError(error.code, error.message, 503, safeDetails(error.details));
    }
  }
  return new AdminApiError(
    "internal_error",
    "Внутренняя ошибка административного API",
    (error as { statusCode?: number })?.statusCode === 400 ? 400 : 500,
  );
}

/** Подробности отказа как объект: массив и скаляр в ответе не нужны. */
function safeDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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
    // Рамка ставится первым делом и синхронно: после `await` она бы не
    // пережила переход к следующему хуку. Пока роль и запись аудита
    // неизвестны, обращение к данным пользователей закрыто.
    const scope = adminScope({
      actor: "anonymous",
      role: "none",
      auditId: null,
      route: `${request.method} ${request.url.split("?")[0] ?? request.url}`,
    });
    enterScope(scope);
    const requestId = requestIdOf(request);
    contexts.set(request, { requestId, startedAt: Date.now(), scope });
    reply.header("X-Request-Id", requestId);
    reply.header("Cache-Control", "no-store");
  });

  // Audit starts before authentication/authorization and therefore before
  // any administrative state change can happen.
  // Небезопасные методы фиксируются в аудите ДО аутентификации: попытка
  // изменения должна остаться в журнале независимо от её исхода.
  // Безопасные — уже после проверки роли (см. preHandler): иначе поток
  // неаутентифицированных GET раздувал бы журнал, ничего о нём не говоря.
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
    context.scope.auditId = context.audit.id;
  });

  app.addHook("preHandler", async (request) => {
    const access = accessOf(request);
    // Открытый маршрут остаётся с анонимной рамкой: доступа к данным
    // пользователей из неё нет.
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
    // Роль подтверждена — рамка запроса получает действующего актора.
    // Право на данные пользователей всё ещё требует записи аудита,
    // которую создаёт preValidation для маршрутов с tenantAccess.
    context.scope.actor = session.user.username;
    context.scope.role = session.user.role;
    context.scope.route = `${request.method} ${request.routeOptions.url ?? request.url}`;

    // Чтение пользовательских данных фиксируется здесь: роль уже
    // подтверждена, а без записи аудита граница арендатора до этих
    // данных не пропустит.
    if (SAFE_METHODS.has(request.method) && access.tenantAccess === "cross-user") {
      context.audit = await services.audit.start({
        requestId: context.requestId,
        operation: `${request.method} ${request.routeOptions.url}`,
        target: request.url.split("?")[0] ?? null,
        ip: safeIp(request.ip),
        actor: actorOf(context),
        params: auditParams(request.url, request.body, request.params),
      });
      context.scope.auditId = context.audit.id;
    }
  });

  app.addHook("onError", async (request, _reply, error) => {
    const context = contexts.get(request);
    if (!context?.audit) return;
    // Код в журнале — тот же, что увидел администратор: иначе разбор
    // отказа по журналу расходится с тем, что показал интерфейс.
    const code = toAdminError(error).code;
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
    const apiError = toAdminError(error);
    // У ответа наружу подробностей нет и быть не должно, но у записи в
    // журнале они обязаны быть. Прежде «internal_error» не оставлял ни
    // причины, ни места: 500 в панели нельзя было объяснить ничем, кроме
    // догадок, и разбор такой ошибки стоил нескольких заходов вместо
    // одного. Текст и стек проходят через редактор секретов — тот же,
    // которым чистится ответ.
    const cause = apiError.statusCode >= 500 && error instanceof Error
      ? {
        reason: String(globalSecretRedactor.redact(error.message)).slice(0, 300),
        reason_name: error.name,
        at: String(globalSecretRedactor.redact(error.stack ?? "")).split("\n")[1]?.trim(),
      }
      : {};
    services.logger.error("Ошибка admin-api", {
      request_id: context?.requestId,
      url: request.url,
      code: apiError.code,
      status: apiError.statusCode,
      ...cause,
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
      phase: 6,
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

  app.get("/api/admin/v1/overview", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.health.overview());

  app.get("/api/admin/v1/services", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.health.services());

  app.get("/api/admin/v1/integrations", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.health.integrations());

  // Security Audit. Читают owner и admin: список находок сам по себе —
  // карта слабых мест установки, и operator с viewer его не получают.
  // Значений секретов в ответе нет, только имена параметров.
  // Предпросмотр политик хранения. Читают owner и admin: отчёт называет
  // объёмы данных установки и сроки их жизни — это не операционная
  // сводка, а карта того, что и как долго хранится.
  //
  // Ответ не содержит ни строки пользовательских данных: только классы,
  // сроки, счётчики и срок ротации резервных копий.
  app.get("/api/admin/v1/retention/preview", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async () => {
    if (!services.retention) {
      throw adminNotFound("Предпросмотр политик хранения недоступен");
    }
    const settings = await services.config.getAll();
    const values = Object.fromEntries(
      settings.settings.map((item) => [item.key, item.value]),
    );
    return await services.retention.preview(values);
  });

  // Единый реестр артефактов за флагом `EVA_ARTIFACT_VERSIONS`.
  // Регистрируется отдельным модулем: этот файл уже за тысячу строк и
  // перечитывается целиком каждой сессией, которая его касается. Права и
  // аудит остаются здесь — модуль их не изобретает.
  if (services.artifacts && artifactVersionsEnabled()) {
    registerArtifactRoutes(app, {
      registry: services.artifacts,
      actorId: (request) => contexts.get(request as FastifyRequest)?.session?.user.id ?? null,
      audit: async (request, details) => {
        const context = contexts.get(request as FastifyRequest);
        if (!context?.audit) return;
        await services.audit.annotate(context.audit.id, details);
      },
    });
  }

  // Полный административный CRUD (шаг 12). Флаг по умолчанию выключен:
  // включает его человек, автономный агент — нет.
  if (services.crud && adminCrudEnabled()) {
    registerCrudRoutes(app, {
      ...services.crud,
      actorId: (request) => contexts.get(request as FastifyRequest)?.session?.user.id ?? null,
      audit: async (request, details) => {
        const context = contexts.get(request as FastifyRequest);
        if (!context?.audit) return;
        await services.audit.annotate(context.audit.id, details);
      },
    });
  }

  // Разделы единой панели. Регистрируются всегда: домен один, панель
  // одна, и половина её разделов хуже, чем понятный отказ сервиса.
  if (services.panel) {
    registerPanelRoutes(app, {
      ...services.panel,
      health: services.health,
      actorId: (request) => contexts.get(request as FastifyRequest)?.session?.user.id ?? null,
      actor: (request) => {
        const session = contexts.get(request as FastifyRequest)?.session;
        return {
          id: session?.user.id ?? null,
          username: session?.user.username ?? "unknown",
        };
      },
      audit: async (request, details) => {
        const context = contexts.get(request as FastifyRequest);
        if (!context?.audit) return;
        await services.audit.annotate(context.audit.id, details);
      },
      // Чтение переписки — безопасный метод, и автоматическая запись
      // аудита его не покрывает. Запись открывается здесь руками: кто,
      // чей диалог и сколько сообщений открыл. Область запроса получает
      // её идентификатор — без него граница арендатора до переписки не
      // пропустит.
      auditMessages: async (request, details) => {
        const context = contexts.get(request as FastifyRequest);
        if (!context) return;
        const entry = await services.audit.start({
          requestId: context.requestId,
          operation: "GET /api/admin/v1/panel/letta/conversations/:conversationId/messages",
          target: String(details.conversation_id ?? ""),
          ip: safeIp((request as FastifyRequest).ip),
          actor: actorOf(context),
          params: details,
        });
        context.audit = entry;
        context.scope.auditId = entry.id;
      },
    });
  }

  app.get("/api/admin/v1/security-audit", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async () => {
    // Флаг EVA_SECURITY_AUDIT объявлен в задании шага и по умолчанию
    // выключен: включает его человек, автономный агент — нет.
    if (!services.securityAudit || !securityAuditEnabled()) {
      throw adminNotFound("Security Audit выключен: EVA_SECURITY_AUDIT");
    }
    return await services.securityAudit.run();
  });

  app.post("/api/admin/v1/services/:id/check", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const result = await services.health.enqueue(
      "service",
      id,
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(202).send(result);
  });

  // Значения без секрета читают и operator с viewer: там нет ключей,
  // только адреса и модели. Правка — owner и admin; подтверждение
  // паролем зависит от интеграции (см. MEDIA_INTEGRATIONS ниже).
  app.get("/api/admin/v1/integrations/:id/config", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return await services.integrations.get(id);
  });

  // Решение владельца — «не спрашивать пароль при настройке синтеза» —
  // ограничено медиа-ключами и проверяется по интеграции, а не по
  // маршруту: маршрут один на все интеграции, и снятое с него
  // подтверждение сняло бы его заодно с Telegram bot_token, токена
  // секрета SearXNG и ключа Crawl4AI. Ключи ASR и TTS вводят,
  // меняют и проверяют десяток раз за настройку, и стоит их утечка
  // счёта у провайдера речи; bot_token — всего канала Евы. Поэтому
  // asr и tts сохраняются без пароля, остальные — под `secrets:write`,
  // как раньше.
  app.put("/api/admin/v1/integrations/:id/config", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const context = contexts.get(request)!;
    if (!MEDIA_INTEGRATIONS.has(id)) {
      await services.auth.requireSudo(context.session!.id, "secrets:write");
    }
    return await services.integrations.put(
      id,
      objectBody(request.body),
      context.session!.user.id,
    );
  });

  // Настоящая проверка ASR и TTS: круговой запрос к провайдеру, а не
  // доступность хоста. Operator может её запускать — она ничего не
  // меняет, только тратит несколько центов на синтез короткой фразы.
  app.post("/api/admin/v1/integrations/:id/test", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return await services.integrations.test(id);
  });

  app.post("/api/admin/v1/integrations/:id/check", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const result = await services.health.enqueue(
      "integration",
      id,
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(202).send(result);
  });

  app.get("/api/admin/v1/checks/:id", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return { check: await services.health.check(id) };
  });

  app.post("/api/admin/v1/services/:id/restart", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "services:restart",
    } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const operation = await services.operations.restart(
      id,
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(202).send(operation);
  });

  // Старт и стоп идут под тем же sudo-scope, что и перезапуск: это одно
  // и то же право «управлять жизненным циклом сервиса».
  app.post("/api/admin/v1/services/:id/start", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "services:restart",
    } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const operation = await services.operations.start(
      id,
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(202).send(operation);
  });

  app.post("/api/admin/v1/services/:id/stop", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "services:restart",
    } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const operation = await services.operations.stop(
      id,
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(202).send(operation);
  });

  // Пароль архива меняет только owner и только через sudo: с ним
  // архивы перестают расшифровываться мастер-ключом, и потеря пароля
  // означает потерю всех новых копий.
  app.put("/api/admin/v1/backups/password", {
    config: {
      roles: ["owner"],
      sudoScope: "secrets:write",
    } satisfies RouteAccess,
  }, async (request) => {
    const body = objectBody(request.body);
    const password = typeof body.password === "string" ? body.password : "";
    return await services.operations.setBackupPassword(password);
  });

  app.get("/api/admin/v1/operations/:id", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return { operation: await services.operations.get(id) };
  });

  app.get("/api/admin/v1/events", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const subscriber = services.events.duplicate();
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      subscriber.disconnect();
    };
    request.raw.on("close", cleanup);
    subscriber.on("message", (_channel, message) => {
      if (!reply.raw.destroyed) reply.raw.write(`event: update\ndata: ${message}\n\n`);
    });
    await subscriber.subscribe("eva.admin.events");
  });

  // Кнопка «Ошибки» на Обзоре. Читают все роли: это операционные
  // сообщения без секретов, и дежурному они нужны первыми.
  app.get("/api/admin/v1/errors", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const query = request.query as { hours?: string; limit?: string };
    const hours = Number(query.hours ?? 24);
    const limit = Number(query.limit ?? 50);
    return await services.health.errors(
      Number.isFinite(hours) ? hours : 24,
      Number.isFinite(limit) ? limit : 50,
    );
  });

  app.get("/api/admin/v1/providers", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const kind = String((request.query as { kind?: string }).kind ?? "llm");
    return await services.providers.list(kind);
  });

  app.post("/api/admin/v1/providers", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const provider = await services.providers.create(objectBody(request.body));
    return reply.status(201).send(provider);
  });

  app.patch("/api/admin/v1/providers/:id", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return await services.providers.update(id, objectBody(request.body));
  });

  app.delete("/api/admin/v1/providers/:id", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    await services.providers.remove(id);
    return reply.status(204).send();
  });

  app.post("/api/admin/v1/providers/:id/check", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return await services.providers.check(id);
  });

  app.post("/api/admin/v1/providers/:id/models/fetch", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return await services.providers.models(id);
  });

  // -------------------------------------------------------------------
  // LLM Router: цепочки, лимиты, бюджеты, circuit breaker
  // -------------------------------------------------------------------
  // Просмотр открыт и viewer'у: состояние моделей нужно дежурному, а
  // секретов в ответе нет. Правки — только owner и admin.
  // В состоянии есть последние отказы из llm_requests: содержимого
  // переписки там нет, но записи принадлежат конкретным пользователям,
  // поэтому просмотр фиксируется в аудите.
  app.get("/api/admin/v1/llm/state", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async () => await services.llmRouter.state());

  app.get("/api/admin/v1/llm/usage", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const days = Number((request.query as { days?: string }).days ?? 14);
    return await services.llmRouter.usage(Number.isFinite(days) ? days : 14);
  });

  app.get("/api/admin/v1/llm/routing-settings", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.llmRouter.routingSettings());

  app.put("/api/admin/v1/llm/routing-settings", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const actor = contexts.get(request)!.session!.user.id;
    return await services.llmRouter.updateRoutingSettings(objectBody(request.body), actor);
  });

  app.patch("/api/admin/v1/llm/providers/:id", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const result = await services.llmRouter.updateProvider(id, objectBody(request.body));
    return result;
  });

  app.patch("/api/admin/v1/llm/routes/:code", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const code = (request.params as { code?: string }).code ?? "";
    const result = await services.llmRouter.updateRoute(code, objectBody(request.body));
    return result;
  });

  app.put("/api/admin/v1/llm/routes/:code/chain", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const code = (request.params as { code?: string }).code ?? "";
    const body = objectBody(request.body);
    const result = await services.llmRouter.setChain(code, body.providers);
    return result;
  });

  app.post("/api/admin/v1/llm/providers/:id/breaker/reset", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const result = await services.llmRouter.resetBreaker(id);
    return result;
  });

  app.post("/api/admin/v1/llm/providers/:id/pin", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const pinned = objectBody(request.body).pinned_out === true;
    const result = await services.llmRouter.setPinnedOut(id, pinned);
    return result;
  });

  // Проверка распознавания медиа. Дежурному она нужна не меньше, чем
  // администратору, но это платный запрос к модели — viewer'у не даётся.
  app.post("/api/admin/v1/llm/vision/check", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async () => await services.providers.visionCheck());

  app.post("/api/admin/v1/providers/:id/activate", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "providers:activate",
    } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return await services.providers.activate(id);
  });

  app.get("/api/admin/v1/backups", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.operations.backups());

  app.post("/api/admin/v1/backups", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const key = typeof request.headers["idempotency-key"] === "string"
      ? request.headers["idempotency-key"]
      : undefined;
    const operation = await services.operations.createBackup(
      contexts.get(request)!.session!.user.id,
      key,
    );
    return reply.status(202).send(operation);
  });

  app.get("/api/admin/v1/updates", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.operations.updates());

  app.post("/api/admin/v1/updates/check", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const operation = await services.operations.checkUpdate(
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(202).send(operation);
  });

  app.post("/api/admin/v1/updates/install", {
    config: {
      roles: ["owner"],
      sudoScope: "operations:update",
    } satisfies RouteAccess,
  }, async (request, reply) => {
    const body = objectBody(request.body);
    if (body.confirm !== "UPDATE") {
      throw adminBadRequest("Для установки обновления передайте confirm=UPDATE");
    }
    const key = typeof request.headers["idempotency-key"] === "string"
      ? request.headers["idempotency-key"]
      : undefined;
    const operation = await services.operations.installUpdate(
      contexts.get(request)!.session!.user.id,
      key,
    );
    return reply.status(202).send(operation);
  });

  // -------------------------------------------------------------------
  // Распознавание речи: конфигурации, маршруты, проверка, телеметрия
  // -------------------------------------------------------------------
  // Схемы форм проксируются из media-service — источник истины там же,
  // где адаптеры. Панель не знает ни одного параметра провайдеров.
  app.get("/api/admin/v1/stt/provider-schemas", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.stt.providerSchemas());

  app.get("/api/admin/v1/stt/configs", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const withArchived = (request.query as { archived?: string }).archived === "true";
    return { configs: await services.stt.list(withArchived) };
  });

  app.get("/api/admin/v1/stt/configs/:id", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    return await services.stt.get((request.params as { id?: string }).id ?? "");
  });

  // Сохранение конфигурации несёт в себе ключ провайдера, поэтому
  // требует подтверждения паролем — как и любая запись секрета.
  app.post("/api/admin/v1/stt/configs", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const actor = contexts.get(request)!.session!.user.id;
    const created = await services.stt.create(objectBody(request.body), actor);
    return reply.status(201).send(created);
  });

  app.patch("/api/admin/v1/stt/configs/:id", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const actor = contexts.get(request)!.session!.user.id;
    return await services.stt.update(id, objectBody(request.body), actor);
  });

  // Отдельная write-only операция замены ключа: форма редактирования не
  // должна требовать заново вводить ключ ради правки модели.
  app.put("/api/admin/v1/stt/configs/:id/secret", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const actor = contexts.get(request)!.session!.user.id;
    return await services.stt.replaceSecret(id, objectBody(request.body), actor);
  });

  // Несколько ключей на провайдера. Перебор между ними media-service
  // делает внутри одного запроса, а заводит их администратор здесь.
  // Чтение открыто оператору — значений в ответе нет, только подписи и
  // состояние; запись требует sudo, как и любое обращение к секретам.
  app.get("/api/admin/v1/stt/configs/:id/keys", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    return { keys: await services.stt.listKeys(id) };
  });

  app.post("/api/admin/v1/stt/configs/:id/keys", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const actor = contexts.get(request)!.session!.user.id;
    const result = await services.stt.addKey(id, objectBody(request.body), actor);
    reply.code(201);
    return result;
  });

  app.patch("/api/admin/v1/stt/configs/:id/keys/:keyId", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const params = request.params as { id?: string; keyId?: string };
    return await services.stt.updateKey(
      params.id ?? "", params.keyId ?? "", objectBody(request.body),
    );
  });

  app.delete("/api/admin/v1/stt/configs/:id/keys/:keyId", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const params = request.params as { id?: string; keyId?: string };
    return await services.stt.removeKey(params.id ?? "", params.keyId ?? "");
  });

  // Проверка ничего не активирует и не сохраняет: это отдельное
  // действие, доступное и оператору.
  app.post("/api/admin/v1/stt/configs/:id/test", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body ? objectBody(request.body) : {};
    const audio = typeof body.audio_base64 === "string" ? body.audio_base64 : undefined;
    return await services.stt.test(id, audio);
  });

  app.post("/api/admin/v1/stt/configs/:id/activate", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = objectBody(request.body);
    const useCase = String(body.use_case ?? "");
    const slot = body.slot === "fallback" ? "fallback" : "primary";
    const actor = contexts.get(request)!.session!.user.id;
    return { routes: await services.stt.activate(id, useCase, slot, actor) };
  });

  app.post("/api/admin/v1/stt/configs/:id/rollback", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const actor = contexts.get(request)!.session!.user.id;
    return await services.stt.rollback(id, actor);
  });

  // DELETE нет намеренно: конфигурация связана с телеметрией, и
  // физическое удаление стёрло бы историю расходов.
  app.post("/api/admin/v1/stt/configs/:id/archive", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    return await services.stt.archive((request.params as { id?: string }).id ?? "");
  });

  app.post("/api/admin/v1/stt/configs/:id/restore", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    return await services.stt.restore((request.params as { id?: string }).id ?? "");
  });

  app.post("/api/admin/v1/stt/configs/:id/enabled", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const enabled = objectBody(request.body).enabled !== false;
    return await services.stt.setEnabled(id, enabled);
  });

  app.get("/api/admin/v1/stt/routes", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => ({ routes: await services.stt.routes() }));

  // Смена primary/fallback переводит живой трафик на другого провайдера.
  app.put("/api/admin/v1/stt/routes/:useCase", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    const useCase = (request.params as { useCase?: string }).useCase ?? "";
    const actor = contexts.get(request)!.session!.user.id;
    return { routes: await services.stt.updateRoute(useCase, objectBody(request.body), actor) };
  });

  // Проверка сценария целиком — тем же путём, каким идёт Telegram.
  // Отдельно от проверки конфигурации: та обращается к провайдеру
  // напрямую и о маршрутах ничего не знает.
  app.post("/api/admin/v1/stt/routes/:useCase/test", {
    config: { roles: ["owner", "admin", "operator"] } satisfies RouteAccess,
  }, async (request) => {
    const useCase = (request.params as { useCase?: string }).useCase ?? "";
    const body = request.body ? objectBody(request.body) : {};
    const audio = typeof body.audio_base64 === "string" ? body.audio_base64 : undefined;
    return await services.stt.testRoute(useCase, audio);
  });

  app.get("/api/admin/v1/stt/usage", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const days = Number((request.query as { days?: string }).days ?? 30);
    return await services.stt.usage(Number.isFinite(days) ? days : 30);
  });

  app.get("/api/admin/v1/stt/health", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => await services.stt.health());

  /**
   * Совместимость с панелью, закэшированной браузером до отмены
   * повторного пароля. Права сессия получает при входе; этот маршрут
   * только подтверждает scope и ничего не спрашивает. Пароль, если он
   * всё же пришёл из старой формы, не читается и никуда не попадает.
   */
  app.post("/api/admin/v1/sudo", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const scope = typeof body.scope === "string" ? body.scope : "";
    const expiresAt = await services.auth.grantSudo(
      contexts.get(request)!.session!,
      scope,
    );
    return reply.status(201).send({ scope, expires_at: expiresAt.toISOString() });
  });

  app.get("/api/admin/v1/context-management", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async () => {
    if (!services.contextManagement) throw adminNotFound("Управление контекстом недоступно");
    return await services.contextManagement.get();
  });

  app.put("/api/admin/v1/context-management", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    if (!services.contextManagement) throw adminNotFound("Управление контекстом недоступно");
    return await services.contextManagement.update(objectBody(request.body));
  });

  app.patch("/api/admin/v1/context-management/conversations/:conversationId", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    if (!services.contextManagement) throw adminNotFound("Управление контекстом недоступно");
    const id = (request.params as { conversationId: string }).conversationId;
    const value = Number(objectBody(request.body).context_window_limit);
    if (!Number.isInteger(value) || value < 1024 || value > 10_000_000) {
      throw adminBadRequest("context_window_limit должен быть целым числом 1024–10000000");
    }
    return await services.contextManagement.updateConversation(id, value);
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

  // -------------------------------------------------------------------
  // тарифы: лимиты, пробные, цены в звёздах и расход
  // -------------------------------------------------------------------
  // Смотреть может любая вошедшая роль: это настройка продукта, а не
  // персональные данные — в ответе только количества. Править — владелец
  // и администратор, как и остальную конфигурацию установки.
  app.get("/api/admin/v1/tariffs", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      // Сводка расхода читает `usage_counters`, а состав тарифов —
      // `subscriptions`: это данные людей, пусть и в виде одних только
      // количеств. Без объявления граница арендатора запрос не пропускает
      // и права: чтение чужих данных обязано попасть в аудит.
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async () => {
    if (!services.tariffs) throw adminBadRequest("Тарифы недоступны");
    return await services.tariffs.state();
  });

  app.put("/api/admin/v1/tariffs/limits", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    if (!services.tariffs) throw adminBadRequest("Тарифы недоступны");
    return await services.tariffs.setLimit(objectBody(request.body));
  });

  app.put("/api/admin/v1/tariffs/prices", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async (request) => {
    if (!services.tariffs) throw adminBadRequest("Тарифы недоступны");
    return await services.tariffs.setPrice(
      objectBody(request.body),
      contexts.get(request)!.session!.user.id,
    );
  });

  // Журнал платежей звёздами. Читают все роли — деньги установки видит и
  // оператор, — но персональные данные ограничены тем же, что и в списке
  // людей: идентификатор Telegram, username и имя.
  app.get("/api/admin/v1/tariffs/payments", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      // Журнал платежей называет людей поимённо — тем более аудит.
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async (request) => {
    if (!services.tariffs) throw adminBadRequest("Тарифы недоступны");
    const query = (request.query ?? {}) as { limit?: unknown };
    return await services.tariffs.payments(Number(query.limit ?? 50));
  });

  // Возврат звёзд. Действие необратимое и денежное: только владелец и
  // администратор, только под sudo, и всегда в аудите.
  app.post("/api/admin/v1/tariffs/payments/:chargeId/refund", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "payments:refund",
    } satisfies RouteAccess,
  }, async (request) => {
    if (!services.starsRefund) throw adminBadRequest("Возврат звёзд недоступен");
    const { chargeId } = request.params as { chargeId: string };
    return await services.starsRefund(chargeId);
  });

  // -------------------------------------------------------------------
  // боты Евы: набор токенов Telegram и переключение между ними
  // -------------------------------------------------------------------
  // Токен — секрет, поэтому права те же, что у остальных секретов, и
  // мутации требуют sudo. Наружу уходят только метка и @username: по ним
  // человек узнаёт своего бота, и секретом они не являются.
  app.get("/api/admin/v1/telegram/tokens", {
    config: { roles: ["owner", "admin"] } satisfies RouteAccess,
  }, async () => {
    if (!services.telegramTokens) throw adminBadRequest("Управление токенами недоступно");
    return await services.telegramTokens.list();
  });

  app.post("/api/admin/v1/telegram/tokens", {
    config: { roles: ["owner", "admin"], sudoScope: "secrets:write" } satisfies RouteAccess,
  }, async (request, reply) => {
    if (!services.telegramTokens) throw adminBadRequest("Управление токенами недоступно");
    const body = objectBody(request.body);
    const created = await services.telegramTokens.add(
      { token: body.token, label: body.label },
      contexts.get(request)!.session!.user.id,
    );
    return reply.status(201).send(created);
  });

  app.post("/api/admin/v1/telegram/tokens/:id/activate", {
    config: { roles: ["owner", "admin"], sudoScope: "secrets:write" } satisfies RouteAccess,
  }, async (request) => {
    if (!services.telegramTokens) throw adminBadRequest("Управление токенами недоступно");
    return await services.telegramTokens.activate(
      (request.params as { id?: string }).id ?? "",
      contexts.get(request)!.session!.user.id,
    );
  });

  app.delete("/api/admin/v1/telegram/tokens/:id", {
    config: { roles: ["owner", "admin"], sudoScope: "secrets:write" } satisfies RouteAccess,
  }, async (request, reply) => {
    if (!services.telegramTokens) throw adminBadRequest("Управление токенами недоступно");
    await services.telegramTokens.remove((request.params as { id?: string }).id ?? "");
    return reply.status(204).send();
  });

  app.get("/api/admin/v1/audit", {
    config: { roles: ["owner", "admin", "operator", "viewer"] } satisfies RouteAccess,
  }, async (request) => {
    const raw = (request.query as { limit?: string }).limit;
    const limit = raw ? Number.parseInt(raw, 10) : 100;
    return { events: await services.audit.list(Number.isFinite(limit) ? limit : 100) };
  });

  // -------------------------------------------------------------------
  // пользователи Евы
  // -------------------------------------------------------------------
  app.get("/api/admin/v1/users", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return await services.users.list({
      query: query.query,
      state: query.state,
      plan: query.plan,
      blocked: query.blocked === undefined ? undefined : query.blocked === "true",
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      offset: query.offset ? Number.parseInt(query.offset, 10) : undefined,
    });
  });

  app.get("/api/admin/v1/users/:id", {
    config: {
      roles: ["owner", "admin", "operator", "viewer"],
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async (request) => {
    return await services.users.get((request.params as { id: string }).id);
  });

  /**
   * Переписка. Автоматический аудит пропускает безопасные методы, поэтому
   * запись в журнал делается здесь руками: кто, чью переписку и сколько
   * сообщений открыл. Самих сообщений в журнале нет — только счётчик.
   */
  //
  // Автоматической пометки tenantAccess здесь намеренно нет: запись
  // аудита этот маршрут делает сам, с идентификатором пользователя в
  // параметрах. Вторая, автоматическая запись с тем же именем операции
  // ничего бы не добавила, зато перекрывала бы ручную при чтении
  // журнала. Область получает идентификатор ручной записи ниже — без
  // него граница арендатора до переписки не пропустит.
  app.get("/api/admin/v1/users/:id/conversation", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:messages",
    } satisfies RouteAccess,
  }, async (request) => {
    const context = contexts.get(request)!;
    const { id } = request.params as { id: string };
    const limit = (request.query as { limit?: string }).limit;
    const entry = await services.audit.start({
      requestId: context.requestId,
      operation: "GET /api/admin/v1/users/:id/conversation",
      target: `/api/admin/v1/users/${id}/conversation`,
      ip: safeIp(request.ip),
      actor: actorOf(context),
      params: { user_id: id, limit: limit ?? null },
    });
    context.scope.auditId = entry.id;
    try {
      const result = await services.users.conversation(id, limit);
      await services.audit.finish(
        entry.id,
        entry.startedAt,
        "success",
        `сообщений: ${result.messages.length}`,
        actorOf(context),
      );
      return result;
    } catch (error) {
      await services.audit.finish(
        entry.id,
        entry.startedAt,
        "failure",
        error instanceof AdminApiError ? error.code : "internal_error",
        actorOf(context),
      );
      throw error;
    }
  });

  app.post("/api/admin/v1/users/:id/block", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async (request) => {
    return await services.users.setBlocked((request.params as { id: string }).id, true);
  });

  app.post("/api/admin/v1/users/:id/unblock", {
    config: {
      roles: ["owner", "admin"],
      sudoScope: "users:write",
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async (request) => {
    return await services.users.setBlocked((request.params as { id: string }).id, false);
  });

  app.patch("/api/admin/v1/users/:id", {
    config: { roles: ["owner", "admin"], tenantAccess: "cross-user" } satisfies RouteAccess,
  }, async (request) => {
    return await services.users.update(
      (request.params as { id: string }).id,
      objectBody(request.body),
    );
  });

  app.post("/api/admin/v1/users/:id/notes", {
    config: {
      roles: ["owner", "admin", "operator"],
      tenantAccess: "cross-user",
    } satisfies RouteAccess,
  }, async (request) => {
    const body = objectBody(request.body);
    const key = typeof request.headers["idempotency-key"] === "string"
      ? request.headers["idempotency-key"]
      : undefined;
    const session = contexts.get(request)!.session!;
    return await services.users.addNote(
      (request.params as { id: string }).id,
      { id: session.user.id, username: session.user.username },
      body.note,
      key,
    );
  });

  return app;
}
