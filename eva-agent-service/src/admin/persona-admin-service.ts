/**
 * Раздел «Персона и промпт»: канонические источники личности Евы.
 *
 * Правда об этих текстах живёт в eva-agent-service — там реестр
 * артефактов, там процесс, который держит агентов, и там единственный
 * путь доставки текста живым агентам (`PersonaSync`). admin-api не
 * заводит второго хранилища и второй копии конфигурации: он вызывает
 * внутренние маршруты `/v1/canonical-context*` и добавляет к ним то, чего
 * у runtime нет, — роль, подтверждение и запись аудита.
 *
 * В аудит уходят отпечаток, номер версии и размер, но не текст: системный
 * промпт не раскрывается (раздел «Персона и границы» в CLAUDE.md), а
 * персона — это то, чем Ева говорит с человеком, и месту в журнале
 * административных вызовов она не принадлежит.
 */

import { adminBadRequest } from "./errors.js";
import type { InternalAgentClient } from "./provider-service.js";

export type PersonaSource = "persona" | "system_prompt";

function sourceOf(value: unknown): PersonaSource {
  const text = String(value ?? "");
  if (text === "persona" || text === "system_prompt") return text;
  throw adminBadRequest("Источник — persona или system_prompt");
}

function reasonOf(value: unknown): string {
  const reason = String(value ?? "").trim();
  if (!reason) throw adminBadRequest("Нужна причина изменения");
  return reason.slice(0, 200);
}

export class PersonaAdminService {
  constructor(private readonly agent: InternalAgentClient) {}

  /** Оба текста, их происхождение, версии и состояние применения. */
  async state(): Promise<Record<string, unknown>> {
    return (await this.agent.request("/v1/canonical-context")) ?? {};
  }

  async history(rawSource: unknown): Promise<Record<string, unknown>> {
    const source = sourceOf(rawSource);
    return (await this.agent.request(`/v1/canonical-context/${source}/history`)) ?? {};
  }

  /**
   * Сохранить и применить.
   *
   * Одно действие: панель не предлагает состояния «сохранено, но не
   * применено» — в нём система выглядит исправной и работает по-старому.
   * Ответ несёт итог применения: сколько агентов приведено к новой
   * версии, сколько отстало и почему.
   */
  async save(
    rawSource: unknown,
    input: Record<string, unknown>,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    const source = sourceOf(rawSource);
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim()) throw adminBadRequest("Текст пуст: сохранять нечего");
    return (await this.agent.request(`/v1/canonical-context/${source}`, {
      method: "PUT",
      body: JSON.stringify({ text, reason: reasonOf(input.reason), actor_id: actorId }),
    })) ?? {};
  }

  /** Вернуть предыдущую действующую версию и применить её. */
  async rollback(
    rawSource: unknown,
    input: Record<string, unknown>,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    const source = sourceOf(rawSource);
    return (await this.agent.request(`/v1/canonical-context/${source}/rollback`, {
      method: "POST",
      body: JSON.stringify({ reason: reasonOf(input.reason), actor_id: actorId }),
    })) ?? {};
  }

  /** Вернуться к тексту файла репозитория. */
  async restoreDefault(
    rawSource: unknown,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    const source = sourceOf(rawSource);
    return (await this.agent.request(`/v1/canonical-context/${source}/restore-default`, {
      method: "POST",
      body: JSON.stringify({ actor_id: actorId }),
    })) ?? {};
  }

  /** Догнать агентов, до которых прошлое применение не доехало. */
  async sync(): Promise<Record<string, unknown>> {
    return (await this.agent.request("/v1/canonical-context/sync", { method: "POST" })) ?? {};
  }

  /**
   * Что записать в аудит о применении.
   *
   * Отпечаток и номер версии — да, текст — нет.
   */
  static auditFacts(
    source: PersonaSource,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const document = (result.document ?? {}) as Record<string, unknown>;
    const sync = (result.sync ?? null) as Record<string, unknown> | null;
    return {
      source,
      version: document.version ?? null,
      checksum: document.checksum ?? null,
      bytes: document.bytes ?? null,
      origin: document.origin ?? null,
      sync_updated: sync?.updated ?? null,
      sync_failed: sync?.failed ?? null,
      sync_error: result.sync_error ?? null,
    };
  }
}
