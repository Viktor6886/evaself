/**
 * Мосты к отложенным инструментам: `tool_search`, `tool_describe`,
 * `tool_call`.
 *
 * Модель видит три небольших инструмента вместо десятков полных схем
 * MCP и браузера. Что искать, что прочитать и что вызвать, решает она
 * сама — мосты только отвечают на её запросы.
 *
 * `tool_call` — не обходной путь. Он вызывает настоящий инструмент через
 * ту же цепочку `ToolExecutor`, что и прямой вызов: область арендатора,
 * риск, подтверждение, журнал эффектов, аудит. Подтверждение SDK
 * спрашивается по настоящему инструменту: `unwrapBridgeCall` разворачивает
 * мост до имени и аргументов цели до того, как считать риск.
 */

import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import {
  BRIDGE_TOOL_NAMES,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_SEARCH_NAME,
  type RegisteredTool,
} from "./registry.js";
import type { ToolExecutor } from "./tool-executor.js";
import { toolResult } from "./tool-executor.js";
import { buildIndex, catalogListing, searchCatalog } from "./tool-search.js";
import { recordToolSearch } from "./tool-metrics.js";
import { integer, objectSchema, text, type JsonObject } from "./tool-kit.js";

const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_DESCRIBE = 8;
const SUMMARY_CHARS = 240;

export type BridgeCall =
  | { name: string; arguments: JsonObject }
  | "invalid";

/**
 * Настоящий инструмент за мостом `tool_call`.
 *
 * `null` — вызов не через мост. `"invalid"` — мост без понятной цели:
 * подтверждать такой вызов не по чему, и он отклоняется, а не
 * пропускается с риском моста.
 */
export function unwrapBridgeCall(toolName: string, input: unknown): BridgeCall | null {
  if (toolName !== TOOL_CALL_NAME) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid";
  const { name, arguments: args } = input as { name?: unknown; arguments?: unknown };
  if (typeof name !== "string" || !name.trim() || BRIDGE_TOOL_NAMES.has(name.trim())) return "invalid";
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) return "invalid";
  return { name: name.trim(), arguments: (args ?? {}) as JsonObject };
}

/**
 * Проверка аргументов по схеме цели до вызова.
 *
 * Не полная JSON Schema, а то, на чём модель ошибается чаще всего:
 * обязательные поля, лишние поля при `additionalProperties: false`,
 * базовые типы и `enum` верхнего уровня. Обработчик инструмента проверяет
 * аргументы и сам; здесь ошибка возвращается раньше и с подсказкой, как
 * её исправить.
 */
export function validateArguments(schema: JsonObject, args: JsonObject): string[] {
  const errors: string[] = [];
  const properties = (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties))
    ? schema.properties as Record<string, JsonObject>
    : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const name of required) {
    if (args[name] === undefined || args[name] === null) errors.push(`${name}: обязательное поле`);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      if (schema.additionalProperties === false) errors.push(`${name}: такого поля нет в схеме`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const expected = property.type;
    const types = Array.isArray(expected) ? expected : typeof expected === "string" ? [expected] : [];
    if (types.length && !types.some((type) => matchesType(type as string, value))) {
      errors.push(`${name}: ожидается ${types.join(" | ")}`);
    }
    if (Array.isArray(property.enum) && !property.enum.some((option) => option === value)) {
      errors.push(`${name}: допустимо одно из ${property.enum.map(String).join(", ")}`);
    }
  }
  return errors.slice(0, 12);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function summary(description: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/**
 * Мосты для conversation.
 *
 * `catalog` спрашивается при каждом вызове, а не запоминается: сервер
 * MCP мог пропасть или появиться между ходами, и мост обязан видеть тот
 * же набор, что и реестр.
 */
export function bridgeTools(input: {
  conversationId: string;
  executor: ToolExecutor;
  catalog: () => readonly RegisteredTool[];
  /** Инструменты, зарегистрированные напрямую: их через мост не зовут. */
  directNames: () => ReadonlySet<string>;
}): { search: RegisteredTool; describe: RegisteredTool; call: AnyAgentTool } {
  const listing = catalogListing(input.catalog());
  const search: RegisteredTool = {
    name: TOOL_SEARCH_NAME,
    label: "Поиск инструмента",
    description: "Находит инструмент по задаче среди подключаемых: MCP-серверы администратора,"
      + " браузер. Возвращает имена и краткие описания; полную схему даёт tool_describe,"
      + " вызов — tool_call. Ищи по сути задачи, по-русски или по-английски."
      + (listing ? ` Сейчас подключены группы: ${listing}.` : ""),
    parameters: objectSchema({
      query: text("Что нужно сделать: «открыть страницу в браузере», «github issue»"),
      limit: integer(`Сколько результатов вернуть, до ${MAX_SEARCH_RESULTS}`),
    }, ["query"]),
    source: "bridge",
    group: "bridge",
    exposure: "direct",
    execute: async (args) => {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
      if (!query) return { ok: false, error: "query: нужен текст запроса" };
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(args.limit) || DEFAULT_SEARCH_RESULTS));
      const tools = input.catalog();
      const found = searchCatalog(buildIndex(tools), query, limit);
      recordToolSearch(found.length ? "hit" : "empty");
      return {
        ok: true,
        results: found.map((tool) => ({ name: tool.name, group: tool.group, summary: summary(tool.description) })),
        total_tools: tools.length,
        ...(found.length === 0
          ? { hint: `Ничего не нашлось. Переформулируй задачу другими словами. Группы: ${catalogListing(tools) || "нет"}.` }
          : { hint: "Прочитай схему нужного инструмента через tool_describe и вызови его через tool_call." }),
      };
    },
  };

  const describe: RegisteredTool = {
    name: TOOL_DESCRIBE_NAME,
    label: "Схема инструмента",
    description: "Возвращает полное описание и JSON-схему аргументов инструментов, найденных через"
      + " tool_search. Вызывай перед tool_call, чтобы передать правильные аргументы.",
    parameters: objectSchema({
      names: { type: "array", items: { type: "string" }, description: `Имена инструментов, до ${MAX_DESCRIBE}` },
    }, ["names"]),
    source: "bridge",
    group: "bridge",
    exposure: "direct",
    execute: async (args) => {
      const names = Array.isArray(args.names)
        ? [...new Set(args.names.filter((name): name is string => typeof name === "string").map((name) => name.trim()))].slice(0, MAX_DESCRIBE)
        : [];
      if (!names.length) return { ok: false, error: "names: нужен список имён из tool_search" };
      const byName = new Map(input.catalog().map((tool) => [tool.name, tool]));
      return {
        ok: true,
        tools: names.flatMap((name) => {
          const tool = byName.get(name);
          return tool ? [{ name: tool.name, group: tool.group, description: tool.description, parameters: tool.parameters }] : [];
        }),
        missing: names.filter((name) => !byName.has(name)),
      };
    },
  };

  const call = {
    name: TOOL_CALL_NAME,
    label: "Вызов инструмента",
    description: "Вызывает инструмент, найденный через tool_search, с аргументами по его схеме из"
      + " tool_describe. Действует те же правила, что и для прямого вызова: подтверждение"
      + " человеком, проверка владельца, повтор без двойного действия.",
    parameters: objectSchema({
      name: text("Точное имя инструмента из tool_search"),
      arguments: { type: "object", description: "Аргументы по схеме из tool_describe", additionalProperties: true },
    }, ["name", "arguments"]),
    execute: async (toolCallId: string, rawArgs: unknown) => {
      const unwrapped = unwrapBridgeCall(TOOL_CALL_NAME, rawArgs);
      if (unwrapped === null || unwrapped === "invalid") {
        return toolResult({ ok: false, error: "tool_call: нужны name (строка) и arguments (объект)" });
      }
      if (input.directNames().has(unwrapped.name)) {
        return toolResult({ ok: false, error: `${unwrapped.name} доступен напрямую: вызови его обычным вызовом, без tool_call` });
      }
      const target = input.catalog().find((tool) => tool.name === unwrapped.name);
      if (!target) {
        return toolResult({ ok: false, error: `Инструмента ${unwrapped.name} нет в каталоге: найди его через tool_search` });
      }
      const invalid = validateArguments(target.parameters, unwrapped.arguments);
      if (invalid.length) {
        return toolResult({
          ok: false,
          error: `Аргументы не подходят к схеме ${target.name}: ${invalid.join("; ")}. Посмотри схему через tool_describe.`,
        });
      }
      return await input.executor.run({
        conversationId: input.conversationId,
        tool: target,
        rawArgs: unwrapped.arguments,
        toolCallId: String(toolCallId ?? ""),
        via: TOOL_CALL_NAME,
      });
    },
  } as AnyAgentTool;

  return { search, describe, call };
}
