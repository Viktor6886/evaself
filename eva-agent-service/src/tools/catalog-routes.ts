/**
 * Каталог инструментов для панели: что зарегистрировано, что видит
 * модель напрямую, что — через поиск, что отклонено; состояние MCP
 * discovery, браузера и делегирования.
 *
 * Только метаданные: имена, источники, риски, счётчики, длительности.
 * Ни аргументов, ни результатов вызовов, ни адресов страниц, ни текста
 * пользователей здесь нет — их здесь и не хранится.
 */

import type { FastifyInstance } from "fastify";

import { toolApprovalCategory, toolRisk, type AgentToolFactory } from "../agent-tools.js";
import type { BrowserServiceClient } from "../browser/client.js";
import { EvaError } from "../errors.js";
import type { LettaSubagentRunner } from "../letta/subagents.js";
import { approvalRequiredFor } from "./approvals.js";
import type { McpDiscovery } from "./mcp-discovery.js";
import type { McpServerPolicyRepository } from "./mcp.js";
import type { ToolLatencyTracker } from "./standard-hooks.js";

export interface ToolCatalogContext {
  factory: Pick<AgentToolFactory, "catalogSnapshot" | "registry">;
  hooks: string[];
  latency: Pick<ToolLatencyTracker, "snapshot">;
  mcp?: {
    policies: Pick<McpServerPolicyRepository, "listEnabled" | "getEnabled">;
    discovery: Pick<McpDiscovery, "effective" | "refresh" | "snapshot">;
  };
  browser: { enabled: () => boolean; client: Pick<BrowserServiceClient, "health" | "sessions"> };
  delegation: { enabled: () => boolean; runner: Pick<LettaSubagentRunner, "activity" | "stats" | "limits"> };
}

const SUMMARY = 200;

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY ? `${line.slice(0, SUMMARY - 1)}…` : line;
}

async function settle<T>(work: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await work(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.name : "unknown_error" };
  }
}

export async function toolCatalogReport(ctx: ToolCatalogContext): Promise<Record<string, unknown>> {
  const assembly = await ctx.factory.catalogSnapshot();
  const describe = (exposure: "direct" | "deferred") => (tool: { name: string; source: string; group: string; description: string }) => {
    const risk = toolRisk(tool.name);
    return {
      name: tool.name, source: tool.source, group: tool.group, exposure, risk,
      approval_required: approvalRequiredFor(risk, toolApprovalCategory(tool.name)),
      description: short(tool.description),
    };
  };
  const [mcp, browserHealth, browserSessions] = await Promise.all([
    ctx.mcp ? mcpReport(ctx.mcp) : Promise.resolve({ configured: false, servers: [] }),
    ctx.browser.enabled() ? settle(async () => await ctx.browser.client.health()) : Promise.resolve({ value: null, error: null }),
    ctx.browser.enabled() ? settle(async () => await ctx.browser.client.sessions()) : Promise.resolve({ value: null, error: null }),
  ]);
  const activity = ctx.delegation.runner.activity();
  return {
    tool_search: { enabled: ctx.factory.registry.toolSearchEnabled },
    tools: [...assembly.direct.map(describe("direct")), ...assembly.deferred.map(describe("deferred"))],
    rejected: assembly.rejected,
    hooks: ctx.hooks,
    latency: ctx.latency.snapshot().slice(0, 50),
    mcp,
    browser: {
      enabled: ctx.browser.enabled(),
      health: browserHealth.value,
      sessions: (browserSessions.value as { sessions?: unknown[] } | null)?.sessions ?? null,
      error: browserHealth.error ?? browserSessions.error,
    },
    delegation: {
      enabled: ctx.delegation.enabled(),
      limits: ctx.delegation.runner.limits,
      stats: { ...ctx.delegation.runner.stats },
      active: activity.active,
      queued: activity.queued,
      running: activity.running,
    },
  };
}

async function mcpReport(mcp: NonNullable<ToolCatalogContext["mcp"]>): Promise<Record<string, unknown>> {
  const enabled = await mcp.policies.listEnabled();
  // Сервер, который ещё ни разу не опрашивали, опрашивается здесь —
  // с тем же пределом ожидания первой загрузки, что и у сессии.
  await Promise.all(enabled.map(async ({ name, policy }) => await mcp.discovery.effective(name, policy).catch(() => [])));
  const names = new Set(enabled.map(({ name }) => name));
  return {
    configured: true,
    servers: mcp.discovery.snapshot().filter((server) => names.has(server.server)).map((server) => ({
      server: server.server,
      state: server.state,
      discovered_at: server.discoveredAt,
      checked_at: server.checkedAt,
      error: server.error,
      duration_ms: server.durationMs,
      discovered: server.discovered.map((tool) => ({ name: tool.name, description: short(tool.description) })),
      allowed: server.allowed,
      effective: server.effective.map((tool) => tool.name),
      missing: server.missing,
    })),
  };
}

export function registerToolCatalogRoutes(app: FastifyInstance, ctx: ToolCatalogContext): void {
  app.get("/v1/tools/catalog", async () => await toolCatalogReport(ctx));

  app.post("/v1/tools/mcp/:name/discover", async (request) => {
    const name = String((request.params as { name?: string }).name ?? "");
    if (!ctx.mcp) throw new EvaError("MCP-серверы не настроены", { code: "mcp_not_configured", statusCode: 409 });
    const policy = await ctx.mcp.policies.getEnabled(name);
    if (!policy) throw new EvaError("MCP-сервер не найден или выключен", { code: "mcp_server_not_found", statusCode: 404 });
    const server = await ctx.mcp.discovery.refresh(name, policy);
    return {
      server: server.server, state: server.state, error: server.error,
      discovered: server.discovered.length, effective: server.effective.map((tool) => tool.name), missing: server.missing,
    };
  });
}
