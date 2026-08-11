/**
 * Административная поверхность единого реестра артефактов.
 *
 * Отдельный модуль, а не ещё сто строк в `admin/server.ts`: тот уже за
 * тысячу строк и перечитывается целиком каждой сессией, которая его
 * касается. Регистрация вынесена функцией, доступ к ролям и аудит
 * передаются снаружи — своей проверки прав здесь нет и быть не должно.
 *
 * Разделение ролей повторяет смысл действий, а не их технический вид:
 * читать реестр может любой вошедший, создавать версии — admin, а
 * публиковать и откатывать — только owner и admin. Публикация меняет то,
 * на чём работают живые ходы.
 */

import type { FastifyInstance } from "fastify";

import { ArtifactRegistry } from "../artifacts/registry.js";
import { isArtifactKind } from "../artifacts/validation.js";
import { badRequest } from "../errors.js";

/** Ровно то, что модулю нужно от админ-сервера. Ничего больше. */
export interface ArtifactRouteContext {
  registry: ArtifactRegistry;
  /** Кто выполняет действие. Идентификатор администратора либо null. */
  actorId(request: unknown): string | null;
  /** Дописать подробности в уже открытую запись аудита. */
  audit(request: unknown, details: Record<string, unknown>): Promise<void>;
}

/*
 * Роли объявляются литералами в каждом маршруте, а не выносятся в общую
 * функцию. Косвенность здесь стоила бы дорого: `scripts/ci/assert-admin-
 * route-access.py` читает исходник и ищет именно список `roles`, поэтому
 * маршрут с `config: access(READERS)` он бы пропустил — и правило «каждый
 * маршрут объявляет, кому он доступен» перестало бы проверяться ровно там,
 * где появились новые маршруты.
 */

function intParam(value: unknown, name: string): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest(`${name} — целое число`);
  return parsed;
}

function body(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Окружение публикации.
 *
 * Проверяется здесь, а не только в схеме: сообщение «строка не подошла под
 * регулярное выражение колонки» администратору ничего не объясняет.
 */
function environment(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw badRequest("Окружение — строчные латинские буквы, цифры, дефис и подчёркивание");
  }
  return name;
}

export function registerArtifactRoutes(app: FastifyInstance, ctx: ArtifactRouteContext): void {
  app.get("/api/admin/v1/artifacts", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const kind = (request.query as { kind?: string }).kind;
    if (kind !== undefined && !isArtifactKind(kind)) throw badRequest("Неизвестный тип артефакта");
    return { artifacts: await ctx.registry.list(kind) };
  });

  app.post("/api/admin/v1/artifacts", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const input = body(request.body);
    const kind = String(input.kind ?? "");
    if (!isArtifactKind(kind)) throw badRequest("Неизвестный тип артефакта");
    const artifact = await ctx.registry.create({
      kind,
      slug: String(input.slug ?? ""),
      title: String(input.title ?? ""),
      description: typeof input.description === "string" ? input.description : "",
      createdBy: ctx.actorId(request),
    });
    await ctx.audit(request, { artifact_id: artifact.id, kind, slug: artifact.slug });
    return { artifact };
  });

  app.get("/api/admin/v1/artifacts/:id/versions", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    return { versions: await ctx.registry.versions(id) };
  });

  app.post("/api/admin/v1/artifacts/:id/versions", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    const input = body(request.body);
    if (input.body === undefined) throw badRequest("Нужно содержимое версии в поле body");
    const created = await ctx.registry.createVersion({
      artifactId: id,
      body: input.body,
      createdBy: ctx.actorId(request),
    });
    // В аудит идут номер, отпечаток и итог проверки — не содержимое:
    // артефактом может быть системный промпт, а он не раскрывается.
    await ctx.audit(request, {
      artifact_id: id,
      version: created.version.version,
      checksum: created.version.checksum,
      validation_ok: created.validation.ok,
    });
    return { version: created.version, validation: created.validation };
  });

  app.post("/api/admin/v1/artifacts/versions/:versionId/status", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const versionId = intParam((request.params as { versionId?: string }).versionId, "versionId");
    const status = String(body(request.body).status ?? "");
    if (status !== "candidate" && status !== "approved" && status !== "archived") {
      throw badRequest("Статус — candidate, approved или archived");
    }
    const version = await ctx.registry.setStatus(versionId, status, ctx.actorId(request));
    await ctx.audit(request, { version_id: versionId, status });
    return { version };
  });

  app.get("/api/admin/v1/artifacts/versions/:versionId/diff/:otherId", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const params = request.params as { versionId?: string; otherId?: string };
    return await ctx.registry.diff(
      intParam(params.versionId, "versionId"),
      intParam(params.otherId, "otherId"),
    );
  });

  app.get("/api/admin/v1/artifacts/:id/publications", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    const env = environment((request.query as { environment?: string }).environment ?? "production");
    return {
      environment: env,
      active: await ctx.registry.active(id, env),
      history: await ctx.registry.history(id, env),
    };
  });

  /**
   * Публикация — опасное действие: она меняет то, на чём работают живые
   * ходы. Поэтому подтверждение обязательно и проверяется явно, а не
   * подразумевается кнопкой в интерфейсе.
   */
  app.post("/api/admin/v1/artifacts/:id/publish", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    const input = body(request.body);
    const env = environment(input.environment);
    if (input.confirm !== env) {
      throw badRequest("Публикация требует поле confirm, равное имени окружения");
    }
    const publication = await ctx.registry.publish({
      artifactId: id,
      environment: env,
      versionId: intParam(input.version_id, "version_id"),
      rolloutPercent: input.rollout_percent === undefined
        ? undefined
        : Number(input.rollout_percent),
      reason: typeof input.reason === "string" ? input.reason : "",
      publishedBy: ctx.actorId(request),
    });
    await ctx.audit(request, {
      artifact_id: id,
      environment: env,
      version_id: publication.versionId,
      rollout_percent: publication.rolloutPercent,
      previous_version_id: publication.previousVersionId,
    });
    return { publication };
  });

  /**
   * Откат одним действием.
   *
   * Подтверждение не требуется намеренно: откат — это то, что делают, когда
   * уже плохо, и лишний шаг здесь стоит дороже ошибки. Причина обязательна:
   * она теряется первой, а спрашивают о ней всегда.
   */
  app.post("/api/admin/v1/artifacts/:id/rollback", {
    config: { roles: ["owner", "admin"] },
  }, async (request) => {
    const id = intParam((request.params as { id?: string }).id, "id");
    const input = body(request.body);
    const env = environment(input.environment);
    const publication = await ctx.registry.rollback({
      artifactId: id,
      environment: env,
      reason: String(input.reason ?? ""),
      publishedBy: ctx.actorId(request),
    });
    await ctx.audit(request, {
      artifact_id: id,
      environment: env,
      version_id: publication.versionId,
      rolled_back_from: publication.previousVersionId,
    });
    return { publication };
  });

  /** Чем воспроизводится прогон: точные версии, на которых он выполнялся. */
  app.get("/api/admin/v1/artifacts/usages/:runKind/:runId", {
    config: { roles: ["owner", "admin", "operator", "viewer"] },
  }, async (request) => {
    const params = request.params as { runKind?: string; runId?: string };
    const runKind = String(params.runKind ?? "");
    const allowed = ["turn", "job", "tool_call", "insight", "research", "eval"];
    if (!allowed.includes(runKind)) throw badRequest("Неизвестный вид прогона");
    const runId = String(params.runId ?? "");
    if (!runId || runId.length > 128) throw badRequest("Идентификатор прогона пуст или слишком длинный");
    return {
      run_kind: runKind,
      run_id: runId,
      versions: await ctx.registry.usagesOf(runKind as never, runId),
    };
  });
}
