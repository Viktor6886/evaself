/**
 * Раздел «Инструменты» административной панели.
 *
 * Каталог инструментов, состояние MCP discovery, браузера и субагентов
 * живёт в процессе eva-agent-service: там реестр, кэш discovery, клиент
 * браузера и раннер субагентов. Панель читает их фиксированными
 * внутренними маршрутами — открытого прокси к `/v1/*` здесь нет, а ключ
 * `EVA_AGENT_API_KEY` в браузер не попадает.
 */

import { adminBadRequest } from "./errors.js";
import type { InternalAgentClient } from "./provider-service.js";

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class ToolCatalogAdminService {
  constructor(private readonly agent: Pick<InternalAgentClient, "request">) {}

  async overview(): Promise<unknown> {
    return await this.agent.request("/v1/tools/catalog");
  }

  /** Опросить MCP-сервер заново. Меняет только кэш discovery процесса. */
  async discover(name: string): Promise<unknown> {
    if (!SERVER_NAME.test(name)) throw adminBadRequest("Некорректное имя MCP-сервера");
    return await this.agent.request(`/v1/tools/mcp/${encodeURIComponent(name)}/discover`, { method: "POST" });
  }
}
