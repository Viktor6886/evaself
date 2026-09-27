/**
 * Каталог инструментов для панели: реестр, MCP discovery, браузер и
 * субагенты — метаданными, без аргументов, адресов и текста.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

import { ToolCatalogAdminService } from "../dist/admin/tool-catalog-service.js";
import { registerToolCatalogRoutes, toolCatalogReport } from "../dist/tools/catalog-routes.js";

function context(options: { browserEnabled?: boolean; mcp?: boolean } = {}) {
  const browserCalls: string[] = [];
  const refreshed: string[] = [];
  const ctx = {
    factory: {
      registry: { toolSearchEnabled: true },
      catalogSnapshot: async () => ({
        direct: [{ name: "delete_tasks", source: "product", group: "product", description: "Удаляет задачи" }],
        deferred: [{ name: "mcp__crm__find", source: "mcp", group: "mcp:crm", description: "x".repeat(500) }],
        rejected: [{ name: "tool_call", source: "mcp", reason: "reserved_name" }],
      }),
    },
    hooks: ["quota", "audit"],
    latency: { snapshot: () => [] },
    ...(options.mcp === false ? {} : {
      mcp: {
        policies: {
          listEnabled: async () => [{ name: "crm", policy: { allowedTools: ["find"] } }],
          getEnabled: async (name: string) => (name === "crm" ? { allowedTools: ["find"] } : null),
        },
        discovery: {
          effective: async () => [],
          refresh: async (name: string) => { refreshed.push(name); return { server: name, state: "ok", error: null, discovered: [{ name: "find" }], effective: [{ name: "find" }], missing: [] }; },
          snapshot: () => [
            { server: "crm", state: "ok", discoveredAt: "t", checkedAt: "t", error: null, durationMs: 5, discovered: [{ name: "find", description: "Find", inputSchema: {} }], allowed: ["find"], effective: [{ name: "find", description: "Find", inputSchema: {} }], missing: [] },
            { server: "retired", state: "ok", discoveredAt: "t", checkedAt: "t", error: null, durationMs: 5, discovered: [], allowed: [], effective: [], missing: [] },
          ],
        },
      },
    }),
    browser: {
      enabled: () => options.browserEnabled === true,
      client: {
        health: async () => { browserCalls.push("health"); return { ok: true }; },
        sessions: async () => { browserCalls.push("sessions"); return { sessions: [{ id: "s1", owner: "o1" }] }; },
      },
    },
    delegation: {
      enabled: () => true,
      runner: { activity: () => ({ active: 1, queued: 0, running: [] }), stats: { started: 1 }, limits: { maxParallel: 3, timeoutMs: 1000 } },
    },
  };
  return { ctx, browserCalls, refreshed };
}

test("отчёт: видимость, риск и согласие по реестру; MCP — только включённые серверы", async () => {
  const { ctx, browserCalls } = context();
  const report = await toolCatalogReport(ctx as never) as Record<string, any>;
  assert.deepEqual(report.tool_search, { enabled: true });
  const [direct, deferred] = report.tools;
  assert.equal(direct.exposure, "direct");
  assert.equal(direct.risk, "destructive");
  assert.equal(direct.approval_required, true);
  assert.equal(deferred.exposure, "deferred");
  assert.equal(deferred.approval_required, true, "MCP — внешнее действие");
  assert.ok(deferred.description.length <= 200);
  assert.deepEqual(report.mcp.servers.map((server: { server: string }) => server.server), ["crm"]);
  assert.deepEqual(report.mcp.servers[0].effective, ["find"]);
  assert.equal(report.browser.enabled, false);
  assert.deepEqual(browserCalls, [], "выключенный браузер не опрашивается");
  assert.equal(report.delegation.active, 1);
});

test("маршруты: опрос MCP только включённого сервера; панель проверяет имя до запроса", async () => {
  const { ctx, refreshed } = context({ browserEnabled: true });
  const app = Fastify();
  registerToolCatalogRoutes(app, ctx as never);
  const catalog = await app.inject({ method: "GET", url: "/v1/tools/catalog" });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().browser.sessions.length, 1);
  const ok = await app.inject({ method: "POST", url: "/v1/tools/mcp/crm/discover" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(refreshed, ["crm"]);
  const missing = await app.inject({ method: "POST", url: "/v1/tools/mcp/nope/discover" });
  assert.equal(missing.statusCode, 404);
  await app.close();

  const noMcp = Fastify();
  registerToolCatalogRoutes(noMcp, context({ mcp: false }).ctx as never);
  assert.equal((await noMcp.inject({ method: "POST", url: "/v1/tools/mcp/crm/discover" })).statusCode, 409);
  await noMcp.close();

  const paths: string[] = [];
  const admin = new ToolCatalogAdminService({ request: async (path: string) => { paths.push(path); return {}; } } as never);
  await admin.discover("crm");
  await assert.rejects(admin.discover("../v1/sdk/settings"), /Некорректное имя/);
  assert.deepEqual(paths, ["/v1/tools/mcp/crm/discover"]);
});
