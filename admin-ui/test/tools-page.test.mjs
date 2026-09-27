/**
 * Раздел «Инструменты»: каталог, MCP discovery, браузер и субагенты.
 *
 * Проверяется то, чего не увидеть в `node --check`: раздел рисует
 * ответ целиком, повторный опрос MCP идёт отдельным POST только по
 * кнопке, и адреса страниц браузера на экран не попадают — их в ответе
 * нет, но и разметка не должна их выдумывать.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const CATALOG = {
  tool_search: { enabled: true },
  tools: [
    { name: "save_task", source: "product", group: "product", exposure: "direct", risk: "low_risk_write", approval_required: false, description: "Сохраняет задачу" },
    { name: "tool_search", source: "bridge", group: "bridge", exposure: "direct", risk: "read", approval_required: false, description: "Поиск инструмента" },
    { name: "mcp__crm__find_contact", source: "mcp", group: "mcp:crm", exposure: "deferred", risk: "external_side_effect", approval_required: true, description: "[MCP crm] Find a contact" },
    { name: "browser_open", source: "browser", group: "browser", exposure: "deferred", risk: "read", approval_required: false, description: "Открывает страницу" },
  ],
  rejected: [{ name: "delete_tasks", source: "mcp", reason: "duplicate_name" }],
  hooks: ["quota", "audit", "metrics", "tracing", "latency"],
  latency: [{ name: "save_task", source: "product", calls: 12, errors: 1, p50Ms: 40, p95Ms: 120, maxMs: 300 }],
  mcp: {
    configured: true,
    servers: [{
      server: "crm", state: "ok", discovered_at: "2026-09-26T10:00:00Z", checked_at: "2026-09-26T10:00:00Z", error: null, duration_ms: 230,
      discovered: [{ name: "find_contact", description: "Find a contact" }, { name: "delete_contact", description: "Delete" }],
      allowed: ["find_contact", "export_all"], effective: ["find_contact"], missing: ["export_all"],
    }],
  },
  browser: {
    enabled: true,
    health: { ok: true, browser: "connected", sessions: 1, limits: { max_sessions: 8, max_sessions_per_owner: 2, session_idle_ms: 300000 }, egress: { allowed: 10, blocked: 3, active: 0 } },
    sessions: [{ id: "sAbCdEfGhIjKlMnOpQrStUvWxYz012345", owner: "o0123456789abcdefghijklmnopqrstuv", ageMs: 42000, idleMs: 5000, operations: 4, blockedRequests: 1 }],
    error: null,
  },
  delegation: {
    enabled: true, limits: { maxParallel: 3, timeoutMs: 180000 },
    stats: { started: 5, completed: 4, failed: 1, timeout: 0, cancelled: 0, cleanupFailed: 0, orphansRemoved: 0 },
    active: 1, queued: 0, running: [{ role: "web", startedAt: "2026-09-26T10:00:00Z", runningMs: 12000 }],
  },
};

describe("раздел «Инструменты»", () => {
  let panel;
  after(async () => await panel?.close());

  test("рисует каталог, MCP, браузер, субагентов и задержку", async () => {
    panel = await openPanel({ routes: { "/panel/tools": CATALOG, "POST /panel/tools/mcp/crm/discover": { server: "crm", state: "ok", discovered: 2, effective: ["find_contact"], missing: [] } } });
    await panel.page.evaluate(() => openPage("tools"));
    await panel.page.waitForFunction(() => document.querySelectorAll("#tools-catalog-body tr").length === 4);
    const view = await panel.page.evaluate(() => ({
      summary: document.querySelector("#tools-summary").textContent,
      deferred: [...document.querySelectorAll("#tools-catalog-body tr")].filter((row) => row.textContent.includes("каталог")).length,
      rejected: document.querySelector("#tools-rejected").textContent,
      mcp: document.querySelector("#tools-mcp").textContent,
      offChips: [...document.querySelectorAll("#tools-mcp .chip-off")].map((node) => node.textContent),
      browser: document.querySelector("#tools-browser").textContent,
      delegation: document.querySelector("#tools-delegation").textContent,
      latency: document.querySelector("#tools-latency-body").textContent,
    }));
    assert.match(view.summary, /Поиск инструментов\s*включён/);
    assert.equal(view.deferred, 2);
    assert.match(view.rejected, /delete_tasks — duplicate_name/);
    assert.match(view.mcp, /find_contact/);
    assert.deepEqual(view.offChips, ["delete_contact"], "объявленное, но не разрешённое — погашено");
    assert.match(view.mcp, /export_all/, "разрешённое, но не объявленное — названо");
    assert.match(view.browser, /1 из 8/);
    assert.match(view.delegation, /1 из 3/);
    assert.match(view.delegation, /web/);
    assert.match(view.latency, /120 мс/);
    assert.equal(panel.countTo("/discover"), 0, "опрос MCP — только по кнопке");

    await panel.page.click('[data-mcp-discover="crm"]');
    await panel.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Сервер опрошен"));
    const posts = panel.requests.filter((item) => item.method === "POST" && item.path.endsWith("/panel/tools/mcp/crm/discover"));
    assert.equal(posts.length, 1);
  });
});
