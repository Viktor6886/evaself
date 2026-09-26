/**
 * Счётчики инструментов для /metrics: поиск и вызов через мосты, вызовы
 * по источникам, обнаружение MCP, операции браузера и делегирование.
 *
 * Только события, исходы и длительности. Ни аргументов, ни результатов,
 * ни адресов страниц, ни запросов поиска. Метки — закрытые наборы
 * (источник, исход, операция), кроме группы MCP: её имя задаёт
 * администратор, и число серверов ограничено политиками.
 */

import type { ToolSource } from "./registry.js";

type Outcome = "ok" | "refused" | "error" | "denied";

const counters = new Map<string, number>();
const durations = new Map<string, { count: number; sum: number; max: number }>();

function add(key: string, amount = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + amount);
}

function observe(key: string, ms: number): void {
  const value = Math.max(0, ms);
  const current = durations.get(key) ?? { count: 0, sum: 0, max: 0 };
  current.count += 1;
  current.sum += value;
  current.max = Math.max(current.max, value);
  durations.set(key, current);
}

const SEP = "\u0000";

export function recordToolCall(source: ToolSource, bridged: boolean, outcome: Outcome, durationMs: number): void {
  add(["call", source, bridged ? "bridge" : "direct", outcome].join(SEP));
  observe(["call", source].join(SEP), durationMs);
}

export function recordToolSearch(outcome: "hit" | "empty"): void {
  add(["search", outcome].join(SEP));
}

export function recordMcpDiscovery(outcome: "ok" | "error", durationMs: number): void {
  add(["mcp_discovery", outcome].join(SEP));
  observe(["mcp_discovery"].join(SEP), durationMs);
}

export const BROWSER_OPERATIONS = ["open", "snapshot", "click", "type", "scroll", "back", "close"] as const;
export type BrowserOperation = typeof BROWSER_OPERATIONS[number];

export function recordBrowserOperation(operation: BrowserOperation, outcome: "ok" | "error" | "blocked", durationMs: number): void {
  add(["browser", operation, outcome].join(SEP));
  observe(["browser", operation].join(SEP), durationMs);
}

export function recordDelegation(role: string, outcome: "completed" | "failed" | "timeout" | "cancelled", durationMs: number): void {
  add(["delegation", role, outcome].join(SEP));
  observe(["delegation", role].join(SEP), durationMs);
}

export interface ToolMetricsSnapshot {
  calls: Array<{ source: string; path: string; outcome: string; value: number }>;
  callDurations: Array<{ source: string; count: number; sum: number; max: number }>;
  searches: Array<{ outcome: string; value: number }>;
  mcpDiscovery: Array<{ outcome: string; value: number }>;
  mcpDiscoveryDuration: { count: number; sum: number; max: number };
  browser: Array<{ operation: string; outcome: string; value: number }>;
  browserDurations: Array<{ operation: string; count: number; sum: number; max: number }>;
  delegation: Array<{ role: string; outcome: string; value: number }>;
  delegationDurations: Array<{ role: string; count: number; sum: number; max: number }>;
}

export function toolMetrics(): ToolMetricsSnapshot {
  const snapshot: ToolMetricsSnapshot = {
    calls: [], callDurations: [], searches: [], mcpDiscovery: [],
    mcpDiscoveryDuration: { count: 0, sum: 0, max: 0 },
    browser: [], browserDurations: [], delegation: [], delegationDurations: [],
  };
  for (const [key, value] of counters) {
    const [kind, a = "", b = "", c = ""] = key.split(SEP);
    if (kind === "call") snapshot.calls.push({ source: a, path: b, outcome: c, value });
    else if (kind === "search") snapshot.searches.push({ outcome: a, value });
    else if (kind === "mcp_discovery") snapshot.mcpDiscovery.push({ outcome: a, value });
    else if (kind === "browser") snapshot.browser.push({ operation: a, outcome: b, value });
    else if (kind === "delegation") snapshot.delegation.push({ role: a, outcome: b, value });
  }
  for (const [key, value] of durations) {
    const [kind, a = ""] = key.split(SEP);
    if (kind === "call") snapshot.callDurations.push({ source: a, ...value });
    else if (kind === "mcp_discovery") snapshot.mcpDiscoveryDuration = { ...value };
    else if (kind === "browser") snapshot.browserDurations.push({ operation: a, ...value });
    else if (kind === "delegation") snapshot.delegationDurations.push({ role: a, ...value });
  }
  return snapshot;
}

/** Только для тестов: счётчики процесса общие для всех тестов файла. */
export function resetToolMetrics(): void {
  counters.clear();
  durations.clear();
}
