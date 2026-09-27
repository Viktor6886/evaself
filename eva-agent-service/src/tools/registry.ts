/**
 * Единый реестр инструментов Evaself.
 *
 * Все инструменты, которые Evaself регистрирует в Letta, проходят через
 * одну точку: продуктовые, MCP, браузерные. Реестр отвечает на два
 * вопроса — какие имена вообще существуют и какие из них модель видит
 * полной схемой, а какие находит через `tool_search`. Выбора «какой
 * инструмент вызвать» здесь нет: это решает Letta.
 *
 * Реестр управляемый. Источники регистрируются кодом сервиса при старте;
 * загрузки плагинов из npm или GitHub нет и не будет — внешние
 * возможности подключаются через MCP, где список серверов и разрешённых
 * инструментов заводит администратор.
 *
 * Сборка без состояния: `assemble()` строит набор из живых источников
 * при каждом открытии сессии. Закреплённый набор расходится с
 * реальностью — MCP-сервер добавили, браузер выключили — и молча теряет
 * инструменты.
 */

import { createHash } from "node:crypto";

import type { AgentRuntimeContext } from "../db.js";
import type { JsonObject } from "./tool-kit.js";

/** Откуда инструмент. Список закрытый: он же метка метрик. */
export type ToolSource = "product" | "bridge" | "mcp" | "browser";
export type ToolExposure = "direct" | "deferred";

export type ToolHandler = (
  args: JsonObject,
  runtime: AgentRuntimeContext,
  toolCallId: string,
) => Promise<unknown>;

export interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: JsonObject;
  source: ToolSource;
  /** Группа каталога: `product`, `browser`, `mcp:<server>`. */
  group: string;
  /**
   * Желаемая видимость. `deferred` становится действующей, только когда
   * включён поиск инструментов; иначе инструмент регистрируется напрямую,
   * как было до реестра.
   */
  exposure: ToolExposure;
  execute: ToolHandler;
}

export const TOOL_SEARCH_NAME = "tool_search";
export const TOOL_DESCRIBE_NAME = "tool_describe";
export const TOOL_CALL_NAME = "tool_call";
/** Имена мостов зарезервированы: ни MCP, ни продуктовый инструмент их не займёт. */
export const BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_SEARCH_NAME, TOOL_DESCRIBE_NAME, TOOL_CALL_NAME,
]);

/**
 * Имя, которое модель получает функцией, обязано пройти ограничение
 * провайдеров (`^[a-zA-Z0-9_-]{1,64}$` у OpenAI-совместимых). Отложенный
 * инструмент функцией не становится — его имя лишь аргумент `tool_call`,
 * поэтому ему позволено быть длиннее.
 */
const DIRECT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFERRED_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Имя отложенного инструмента, выставленного прямо (поиск выключен).
 *
 * MCP разрешает в имени точку, а приставка `mcp__<сервер>__` уводит
 * длинное имя за 64 знака — такой инструмент провайдер не примет
 * функцией, и без псевдонима он молча выпадал из сессии. Обратное
 * отображение не нужно: вызов исполняет замыкание инструмента, которое
 * знает настоящее имя. Хеш полного имени держит псевдонимы `a.b` и `a_b`
 * разными.
 */
export function directAlias(name: string): string {
  if (DIRECT_NAME.test(name)) return name;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${safe.slice(0, 64 - suffix.length - 1)}_${suffix}`;
}

export interface ToolSourceProvider {
  /** Имя источника: одно на реестр. */
  readonly id: string;
  tools(conversationId: string): readonly RegisteredTool[];
}

export interface RejectedTool {
  name: string;
  source: ToolSource;
  reason: "reserved_name" | "invalid_name" | "duplicate_name";
}

export interface ToolAssembly {
  direct: RegisteredTool[];
  deferred: RegisteredTool[];
  rejected: RejectedTool[];
}

export class ToolRegistry {
  private readonly providers: ToolSourceProvider[] = [];

  constructor(private readonly options: { toolSearchEnabled: () => boolean }) {}

  register(provider: ToolSourceProvider): void {
    if (this.providers.some((existing) => existing.id === provider.id)) {
      throw new Error(`Источник инструментов ${provider.id} уже зарегистрирован`);
    }
    this.providers.push(provider);
  }

  get toolSearchEnabled(): boolean {
    return this.options.toolSearchEnabled();
  }

  /**
   * Набор инструментов conversation.
   *
   * Коллизия имён не решается «последний победил»: продуктовый
   * инструмент регистрируется первым и остаётся, одноимённый MCP
   * отклоняется. Иначе администратор, добавивший сервер с инструментом
   * `delete_tasks`, подменил бы продуктовое удаление чужим — вместе с его
   * подтверждением и проверкой владельца.
   */
  assemble(conversationId: string): ToolAssembly {
    const deferAllowed = this.options.toolSearchEnabled();
    const names = new Set<string>();
    const assembly: ToolAssembly = { direct: [], deferred: [], rejected: [] };
    for (const provider of this.providers) {
      for (const tool of provider.tools(conversationId)) {
        const exposure: ToolExposure = tool.exposure === "deferred" && deferAllowed ? "deferred" : "direct";
        const reject = (reason: RejectedTool["reason"]) =>
          assembly.rejected.push({ name: tool.name, source: tool.source, reason });
        if (BRIDGE_TOOL_NAMES.has(tool.name) && tool.source !== "bridge") { reject("reserved_name"); continue; }
        // Отложенный инструмент проверяется по правилам отложенного имени
        // в любом режиме; выставленный прямо получает псевдоним функции.
        const deferredByNature = tool.exposure === "deferred";
        if (!(deferredByNature ? DEFERRED_NAME : DIRECT_NAME).test(tool.name)) { reject("invalid_name"); continue; }
        const name = deferredByNature && exposure === "direct" ? directAlias(tool.name) : tool.name;
        if (names.has(name)) { reject("duplicate_name"); continue; }
        names.add(name);
        (exposure === "deferred" ? assembly.deferred : assembly.direct).push(
          exposure === tool.exposure ? tool : { ...tool, name, exposure },
        );
      }
    }
    return assembly;
  }
}
