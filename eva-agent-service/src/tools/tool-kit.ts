import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { AgentRuntimeContext } from "../db.js";

export type JsonObject = Record<string, unknown>;
export type ToolBuilder = (
  name: string,
  label: string,
  description: string,
  parameters: JsonObject,
  execute: (args: JsonObject, runtime: AgentRuntimeContext) => Promise<unknown>,
) => AnyAgentTool;

export const objectSchema = (
  properties: Record<string, JsonObject>,
  required: string[] = [],
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const text = (description: string): JsonObject => ({ type: "string", description });
export const integer = (description: string): JsonObject => ({ type: "integer", description });
export const boolean = (description: string): JsonObject => ({ type: "boolean", description });
export const json = (description: string): JsonObject => ({
  description,
  anyOf: [{ type: "array" }, { type: "object" }],
});

export function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Аргументы инструмента должны быть JSON-объектом");
  }
  return value as JsonObject;
}

export function requiredString(args: JsonObject, name: string, max = 20_000): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name}: требуется непустая строка`);
  }
  return value.trim().slice(0, max);
}

export function optionalString(
  args: JsonObject,
  name: string,
  max = 20_000,
): string | null {
  const value = args[name];
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name}: ожидается строка`);
  return value.trim().slice(0, max);
}

export function optionalInteger(args: JsonObject, name: string): number | null {
  const value = args[name];
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}: ожидается целое число`);
  return parsed;
}
