/**
 * Внутренние маршруты канонического контекста: чтение, сохранение,
 * применение и откат персоны и системного промпта.
 *
 * Отдельный модуль, а не ещё двести строк в `server.ts`: тот уже за
 * полторы тысячи строк и перечитывается целиком каждой сессией, которая
 * его касается.
 *
 * Контур один и тот же для всех трёх изменяющих маршрутов:
 *
 *   1. реестр артефактов получает новую действующую версию (или откат);
 *   2. процесс переключается на новый текст — новый агент создаётся уже
 *      с ним;
 *   3. `PersonaSync` приводит существующих агентов к той же версии.
 *
 * Порядок именно такой и он важен. Сначала фиксируется решение (шаг 1),
 * и только потом оно применяется: если применение частично не удалось,
 * канонический текст всё равно один и известен, а повторный запуск
 * синхронизации доводит отставших. Обратный порядок оставлял бы систему
 * в состоянии «часть агентов уже с новым текстом, а какой текст
 * канонический — неизвестно».
 *
 * Второго когнитивного контура здесь не появляется (инвариант 3):
 * доставку выполняет единственный существующий `PersonaSync`, а решение
 * о том, что вспомнить и чем ответить, по-прежнему принимает Letta.
 */

import type { FastifyInstance } from "fastify";

import { badRequest } from "../errors.js";
import type { Logger } from "../logger.js";
import {
  canonicalSource,
  type CanonicalContextStore,
  type CanonicalDocument,
  type CanonicalSource,
} from "./canonical-context.js";
import { personaSyncState, type PersonaSyncResult } from "../letta/persona-sync.js";

export interface CanonicalRouteContext {
  store: CanonicalContextStore;
  /** Переключить процесс на новый текст. Возвращает `true`, если что-то поменялось. */
  applyToRuntime(input: { persona: string; systemPrompt: string }): boolean;
  /** Единственный путь доставки текста живым агентам. */
  sync(persona: string, systemPrompt: string): Promise<PersonaSyncResult>;
  logger: Logger;
}

function bodyOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Ожидается JSON-объект");
  }
  return value as Record<string, unknown>;
}

/**
 * Ответ, по которому видно состояние применения.
 *
 * Панель показывает именно это: что действует, сколько агентов приведено
 * к версии, сколько отстало и почему. Без `applied` и `sync` сохранение
 * выглядело бы успешным всегда — в том числе когда App Server недоступен
 * и ни один агент нового текста не увидел.
 */
async function applied(
  ctx: CanonicalRouteContext,
  document: CanonicalDocument,
): Promise<Record<string, unknown>> {
  const context = await ctx.store.current();
  const runtimeChanged = ctx.applyToRuntime(context);
  let sync: PersonaSyncResult | null = null;
  let syncError: string | null = null;
  try {
    sync = await ctx.sync(context.persona, context.systemPrompt);
  } catch (error) {
    // Отказ синхронизации не отменяет решения: канонический текст уже
    // зафиксирован реестром и достаётся новым агентам. Панель обязана
    // увидеть, что существующие агенты отстали, — молчание здесь было бы
    // худшим из исходов.
    syncError = error instanceof Error ? error.name : "unknown_error";
    ctx.logger.warn("Канонический текст сохранён, но синхронизация не выполнена", {
      source: document.source,
      code: syncError,
    });
  }
  return {
    document,
    runtime_changed: runtimeChanged,
    sync: sync
      ? {
          checked: sync.checked,
          updated: sync.updated,
          up_to_date: sync.upToDate,
          failed: sync.failed,
          unsupported: sync.unsupported,
          version: sync.version,
        }
      : null,
    sync_error: syncError,
    state: personaSyncState(),
  };
}

export function registerCanonicalRoutes(app: FastifyInstance, ctx: CanonicalRouteContext): void {
  /** Оба источника разом: текст, происхождение, версия и состояние применения. */
  app.get("/v1/canonical-context", async () => {
    const [persona, systemPrompt] = await Promise.all([
      ctx.store.document("persona"),
      ctx.store.document("system_prompt"),
    ]);
    return { documents: { persona, system_prompt: systemPrompt }, state: personaSyncState() };
  });

  app.get("/v1/canonical-context/:source/history", async (request) => {
    const source = canonicalSource((request.params as { source?: string }).source);
    return { source, history: await ctx.store.history(source) };
  });

  app.put("/v1/canonical-context/:source", async (request) => {
    const source: CanonicalSource = canonicalSource(
      (request.params as { source?: string }).source,
    );
    const body = bodyOf(request.body);
    const document = await ctx.store.save({
      source,
      text: typeof body.text === "string" ? body.text : "",
      actorId: typeof body.actor_id === "string" ? body.actor_id : null,
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    return await applied(ctx, document);
  });

  app.post("/v1/canonical-context/:source/rollback", async (request) => {
    const source = canonicalSource((request.params as { source?: string }).source);
    const body = bodyOf(request.body);
    const document = await ctx.store.rollback({
      source,
      reason: typeof body.reason === "string" ? body.reason : "",
      actorId: typeof body.actor_id === "string" ? body.actor_id : null,
    });
    return await applied(ctx, document);
  });

  app.post("/v1/canonical-context/:source/restore-default", async (request) => {
    const source = canonicalSource((request.params as { source?: string }).source);
    const body = bodyOf(request.body ?? {});
    const document = await ctx.store.restoreDefault({
      source,
      actorId: typeof body.actor_id === "string" ? body.actor_id : null,
    });
    return await applied(ctx, document);
  });

  /**
   * Повторная синхронизация без изменения текста.
   *
   * Нужна ровно тогда, когда предыдущее применение отстало: App Server
   * был недоступен, часть агентов осталась на старой версии. Кнопка
   * «Синхронизировать» в панели ведёт сюда.
   */
  app.post("/v1/canonical-context/sync", async () => {
    const document = await ctx.store.document("persona");
    return await applied(ctx, document);
  });
}
