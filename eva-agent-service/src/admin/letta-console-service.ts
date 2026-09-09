/**
 * Раздел «Letta» административной панели.
 *
 * Раньше это была отдельная консоль на своём поддомене за HTTP Basic Auth
 * (`letta-ui`). Она обращалась к тем же внутренним маршрутам
 * eva-agent-service, но мимо RBAC, sudo и аудита административного API:
 * пароль в Caddy открывал разом и настройки SDK, и переписку любого
 * человека. Здесь тот же набор операций живёт внутри одной панели, под
 * одной сессией и под теми правами, что и остальные разделы.
 *
 * Открытого прокси нет намеренно. Каждый метод — названная операция с
 * фиксированным внутренним путём: браузер не может попросить произвольный
 * `/v1/*`, а список того, что вообще достижимо, читается глазами. Ключ
 * `EVA_AGENT_API_KEY` остаётся у admin-api и в браузер не попадает
 * никогда.
 *
 * Чего здесь нет и почему:
 *
 *   стриминговый чат от лица агента — администратор, пишущий в личный
 *     диалог человека с Евой, неотличим для этого человека от самой Евы.
 *     Прежняя консоль это позволяла; в панели такой операции нет;
 *   создание и удаление агентов — они в разделе «Агенты», через
 *     production-путь Letta Agent SDK, и второго входа к ним не нужно;
 *   произвольный SQL и прямой доступ к App Server — по определению.
 */

import { adminBadRequest } from "./errors.js";
import type { InternalAgentClient } from "./provider-service.js";

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function objectId(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!ID_RE.test(text)) throw adminBadRequest(`Некорректный ${name}`);
  return text;
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

export class LettaConsoleService {
  constructor(private readonly agent: InternalAgentClient) {}

  /** Свод раздела: версия runtime, настройки SDK, счётчики и живые агенты. */
  async overview(): Promise<Record<string, unknown>> {
    const [system, settings, stats, agents] = await Promise.all([
      this.safe(async () => await this.agent.request("/v1/system")),
      this.safe(async () => await this.agent.request("/v1/sdk/settings")),
      this.safe(async () => await this.agent.request("/v1/stats")),
      this.safe(async () => await this.agent.request("/v1/sdk/agents")),
    ]);
    return {
      system: system.value,
      settings: (settings.value as { settings?: unknown } | null)?.settings ?? null,
      stats: stats.value,
      agents: (agents.value as { agents?: unknown[] } | null)?.agents ?? [],
      errors: [system.error, settings.error, stats.error, agents.error].filter(Boolean),
    };
  }

  /** Проверка соединения с App Server. Ничего не меняет. */
  async test(): Promise<unknown> {
    return await this.agent.request("/v1/sdk/test", { method: "POST" });
  }

  async settings(): Promise<unknown> {
    return await this.agent.request("/v1/sdk/settings");
  }

  async updateSettings(patch: Record<string, unknown>): Promise<unknown> {
    if (Object.keys(patch).length === 0) throw adminBadRequest("Нечего менять");
    return await this.agent.request("/v1/sdk/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Расход контекста по conversations: где ближе всего к пределу. */
  async contextManagement(): Promise<unknown> {
    return await this.agent.request("/v1/context-management");
  }

  async conversations(rawAgentId: string): Promise<unknown> {
    const id = objectId(rawAgentId, "идентификатор агента");
    return await this.agent.request(`/v1/sdk/agents/${encodeURIComponent(id)}/conversations`);
  }

  async conversation(rawId: string): Promise<unknown> {
    const id = objectId(rawId, "идентификатор conversation");
    return await this.agent.request(`/v1/sdk/conversations/${encodeURIComponent(id)}`);
  }

  /** Состояние сессии conversation: идёт ли ход прямо сейчас. */
  async session(rawId: string): Promise<unknown> {
    const id = objectId(rawId, "идентификатор conversation");
    return await this.agent.request(`/v1/sdk/conversations/${encodeURIComponent(id)}/session`);
  }

  /**
   * Остановить идущий ход.
   *
   * Дежурное действие: оно прекращает работу, а не меняет состояние
   * установки, — поэтому доступно и оператору.
   */
  async abort(rawId: string): Promise<unknown> {
    const id = objectId(rawId, "идентификатор conversation");
    return await this.agent.request(
      `/v1/sdk/conversations/${encodeURIComponent(id)}/abort`,
      { method: "POST" },
    );
  }

  /** Архивировать или вернуть conversation. Обратимо. */
  async setArchived(rawId: string, archived: boolean): Promise<unknown> {
    const id = objectId(rawId, "идентификатор conversation");
    return await this.agent.request(`/v1/sdk/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
    });
  }

  /**
   * История сообщений conversation.
   *
   * Личная переписка. Маршрут, который её отдаёт, требует отдельного
   * гранта `users:messages` и пишет собственную запись аудита — так же,
   * как карточка пользователя.
   */
  async messages(rawId: string, limit: unknown): Promise<unknown> {
    const id = objectId(rawId, "идентификатор conversation");
    const count = boundedLimit(limit, 50, 200);
    return await this.agent.request(
      `/v1/sdk/conversations/${encodeURIComponent(id)}/messages?limit=${count}`,
    );
  }

  /** Журнал административных операций Letta: создание, правка, удаление. */
  async audit(limit: unknown): Promise<unknown> {
    const count = boundedLimit(limit, 100, 200);
    return await this.agent.request(`/v1/audit?limit=${count}`);
  }

  /**
   * Обращение, которое не должно ронять весь свод.
   *
   * Раздел собирается из четырёх независимых источников; недоступность
   * одного значит «этой части сейчас нет», а не «страница не открылась».
   */
  private async safe<T>(work: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
    try {
      return { value: await work(), error: null };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "agent_runtime_error",
      };
    }
  }
}
