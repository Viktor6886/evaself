/**
 * OSINT для Евы: инструменты, отчёт, уведомление, метрики, Mini App.
 *
 * Проверяется граница, а не только работа: владелец берётся из хода, а не
 * из аргументов модели; исследование требует подтверждения человека;
 * без сервиса инструментов нет вовсе; Mini App не умеет начинать
 * исследование; метрики и уведомление не несут идентификаторов.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

import { AgentToolFactory, toolApprovalCategory, toolRisk } from "../dist/agent-tools.js";
import { completionText } from "../dist/osint/job.js";
import { osintStats, recordOsint } from "../dist/osint/metrics.js";
import { renderReport } from "../dist/osint/report.js";
import { OsintToolFactory, toolIdempotencyKey } from "../dist/osint/tools.js";
import { registerOsintPublicRoutes } from "../dist/public/osint-routes.js";

const RUNTIME = { userId: 42, conversationId: "conv-osint", agentId: "agent-1" };
const ID = "11111111-2222-4333-8444-555555555555";

type Built = { name: string; description: string; execute: (args: Record<string, unknown>, call?: string) => Promise<unknown> };

function harness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === "create") return { id: ID, created: true };
    if (method === "report") return REPORT;
    if (method === "status") return { id: ID, status: "processing" };
    if (method === "cancel" || method === "delete") return true;
    return [];
  };
  const service = Object.fromEntries(["create", "status", "report", "cancel", "search", "list", "delete"]
    .map((method) => [method, record(method)]));
  const builder = (name: string, _label: string, description: string, _schema: unknown,
    execute: (args: Record<string, unknown>, runtime: typeof RUNTIME, call: string) => Promise<unknown>) =>
    ({ name, description, execute: async (args: Record<string, unknown>, call = "call-1") => await execute(args, RUNTIME, call) });
  const tools = new Map((new OsintToolFactory(service as never).build(builder as never) as unknown as Built[])
    .map((tool) => [tool.name, tool]));
  return { calls, tools };
}

const REPORT = {
  id: ID, status: "completed", mode: "standard", purpose: "проверка контрагента",
  createdAt: "2026-09-26T00:00:00.000Z", completedAt: "2026-09-26T00:10:00.000Z",
  subject: { caption: "alice", schema: "Person", identifiers: [{ type: "username", value: "alice" }], properties: {} },
  accounts: [{ url: "https://github.com/alice", confidence: 0.6, collectors: ["maigret"], claims: [], match: null }],
  infrastructure: [{ schema: "eva:Domain", caption: "example.com", properties: { registrar: ["Example Registrar"] } }],
  mentions: [{ url: "https://example.com/a", quote: "alice пишет о проекте" }],
  discovered: [{ type: "domain", value: "example.com", depth: 1 }],
  runs: [{ collector: "web", status: "degraded", reason: "rate_limited", count: 1 }],
  externalRequests: 12, maxExternalRequests: 150,
  limitations: ["Найденные по нику аккаунты не подтверждены как принадлежащие субъекту."],
};

test("исследование пишется под владельцем хода, а не под аргументом модели", async () => {
  const { calls, tools } = harness();
  const result = await tools.get("osint_investigate")!.execute({
    query: "проверь контрагента", purpose: "сделка", subject: "person",
    seeds: [{ type: "username", value: "alice" }], user_id: 999,
  });
  assert.deepEqual(result, { ok: true, investigation_id: ID, status: "queued" });
  const input = calls[0]!.args[0] as Record<string, unknown>;
  assert.equal(input.userId, RUNTIME.userId);
  assert.equal(input.conversationId, RUNTIME.conversationId);
  assert.equal(JSON.stringify(input).includes("999"), false);
  assert.match(String(input.idempotencyKey), /^[A-Za-z0-9:_-]{8,200}$/);
});

test("повтор того же вызова даёт тот же ключ, другой вызов — другой", () => {
  const first = toolIdempotencyKey("conv", "call/1 with spaces");
  assert.equal(first, toolIdempotencyKey("conv", "call/1 with spaces"));
  assert.notEqual(first, toolIdempotencyKey("conv", "call-2"));
  assert.notEqual(first, toolIdempotencyKey("other", "call/1 with spaces"));
  // Без идентификатора вызова два вызова не склеиваются в одно исследование.
  assert.notEqual(toolIdempotencyKey("conv", ""), toolIdempotencyKey("conv", ""));
  assert.match(first, /^[A-Za-z0-9:_-]{8,200}$/);
});

test("чтение и удаление — под владельцем хода, идентификатор проверяется", async () => {
  const { calls, tools } = harness();
  const report = await tools.get("osint_get_report")!.execute({ investigation_id: ID });
  assert.equal(typeof report, "string");
  assert.deepEqual(calls.at(-1)!.args, [RUNTIME.userId, ID]);
  await tools.get("osint_delete")!.execute({ investigation_id: ID });
  assert.deepEqual(calls.at(-1), { method: "delete", args: [RUNTIME.userId, ID] });
  await assert.rejects(tools.get("osint_cancel")!.execute({ investigation_id: "1; DROP" }), /investigation_id/);
});

test("описание запуска называет явную просьбу, цель и запрет памяти", () => {
  const { tools } = harness();
  const investigate = tools.get("osint_investigate")!.description;
  assert.match(investigate, /явной просьбе/);
  assert.match(investigate, /purpose/);
  assert.match(investigate, /пробива/);
  assert.match(tools.get("osint_get_report")!.description, /Не сохраняй сведения о третьих лицах/);
});

test("риски: запуск и удаление требуют подтверждения, чтение — нет", () => {
  assert.equal(toolRisk("osint_investigate"), "sensitive_write");
  assert.equal(toolRisk("osint_delete"), "destructive");
  assert.equal(toolApprovalCategory("osint_delete"), "data_deletion");
  for (const name of ["osint_get_status", "osint_get_report", "osint_list", "osint_search_entity"]) {
    assert.equal(toolRisk(name), "read", name);
  }
  assert.equal(toolRisk("osint_cancel"), "low_risk_write");
});

test("инструменты OSINT — только при сервисе и включённом флаге, флаг читается на лету", () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const config = { vectorGoalsEnabled: false, osintEnabled: true };
  const factory = new AgentToolFactory(config as never, db as never, {} as never, silent);
  const names = () => factory.forConversation("conv-1").map((tool) => tool.name);
  const before = names();
  assert.equal(before.some((name) => name.startsWith("osint_")), false, "без сервиса инструментов нет");
  factory.setOsint({} as never);
  const after = names();
  for (const name of ["osint_investigate", "osint_get_status", "osint_get_report", "osint_list", "osint_search_entity", "osint_cancel", "osint_delete"]) {
    assert.ok(after.includes(name), name);
  }
  // Остальные инструменты на месте: OSINT добавляется, а не вытесняет.
  for (const name of before) assert.ok(after.includes(name), name);
  // Выключатель в панели меняет config без перезапуска.
  config.osintEnabled = false;
  assert.equal(names().some((name) => name.startsWith("osint_")), false, "выключенный флаг убирает инструменты");
});

test("отчёт текстом: ограничения всегда есть, принадлежность не утверждается", () => {
  const text = renderReport(REPORT as never);
  assert.match(text, /принадлежность субъекту НЕ установлена/);
  assert.match(text, /связь с субъектом не оценивалась/);
  assert.match(text, /Ограничения:/);
  assert.match(text, /«alice пишет о проекте»/);
  assert.ok(renderReport(REPORT as never, 200).length <= 200);
});

test("уведомление о завершении — только счётчики, без идентификаторов", () => {
  const text = completionText({ sources: 5, accounts: 3, discovered: 7, degradedRuns: 1, failedRuns: 0 } as never);
  assert.match(text, /Источников: 5/);
  assert.match(text, /не ответила \(1\)/);
  assert.equal(/@|https?:|alice/.test(text), false);
});

test("метрики копятся по закрытым меткам", () => {
  const before = osintStats();
  const count = (stats: ReturnType<typeof osintStats>) =>
    stats.requests.find((item) => item.collector === "web")?.value ?? 0;
  recordOsint("investigation", "created");
  recordOsint("run", "web", "succeeded");
  recordOsint("requests", "web", 4);
  recordOsint("requests", "web", -3);
  const after = osintStats();
  assert.equal(count(after) - count(before), 4);
  assert.ok(after.investigations.some((item) => item.outcome === "created" && item.value >= 1));
  assert.ok(after.runs.some((item) => item.collector === "web" && item.status === "succeeded"));
});

test("Mini App: чтение, отмена и удаление под своим пользователем; запуска нет", async () => {
  const calls: unknown[][] = [];
  const osint = {
    list: async (...args: unknown[]) => { calls.push(["list", ...args]); return []; },
    status: async (...args: unknown[]) => { calls.push(["status", ...args]); return null; },
    report: async (...args: unknown[]) => { calls.push(["report", ...args]); return REPORT; },
    cancel: async (...args: unknown[]) => { calls.push(["cancel", ...args]); return true; },
    delete: async (...args: unknown[]) => { calls.push(["delete", ...args]); return true; },
  };
  const app = Fastify();
  registerOsintPublicRoutes(app as never, osint as never, () => 777);
  await app.ready();
  assert.equal((await app.inject({ method: "GET", url: "/osint" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/osint/${ID}` })).statusCode, 404);
  const report = await app.inject({ method: "GET", url: `/osint/${ID}/report` });
  assert.equal(report.json().report.id, ID);
  assert.deepEqual((await app.inject({ method: "POST", url: `/osint/${ID}/cancel` })).json(), { cancelled: true });
  assert.deepEqual((await app.inject({ method: "DELETE", url: `/osint/${ID}` })).json(), { deleted: true });
  assert.equal((await app.inject({ method: "GET", url: "/osint/not-a-uuid" })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/osint", payload: {} })).statusCode, 404);
  assert.ok(calls.every((call) => call[1] === 777));
  await app.close();

  const disabled = Fastify();
  registerOsintPublicRoutes(disabled as never, undefined, () => 777);
  assert.equal((await disabled.inject({ method: "GET", url: "/osint" })).statusCode, 400);
  await disabled.close();
});
