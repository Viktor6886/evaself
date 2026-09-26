/**
 * Реестр инструментов, поиск по каталогу и мосты.
 *
 * Главное свойство: `tool_call` — не обходной путь. Он вызывает настоящий
 * инструмент через ту же цепочку, что и прямой вызов, и подтверждение
 * спрашивается по настоящему инструменту.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentToolFactory, isHostExecutionTool, toolRisk } from "../dist/agent-tools.js";
import { ApprovalService, fingerprintApprovalArguments } from "../dist/tools/approvals.js";
import { unwrapBridgeCall, validateArguments } from "../dist/tools/bridge-tools.js";
import { ToolRegistry } from "../dist/tools/registry.js";
import { sessionPermission } from "../dist/tools/session-permission.js";
import { buildIndex, catalogListing, searchCatalog, stem } from "../dist/tools/tool-search.js";
import { runInTurn } from "../dist/turns/turn-context.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const RUNTIME = {
  userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-1", purpose: "chat" as const,
  timezone: "Europe/Amsterdam", responseMode: "text" as const, useEmoji: true,
};

function tool(name: string, description: string, group = "mcp:test", properties: Record<string, unknown> = {}) {
  return { name, description, group, parameters: { type: "object", properties } };
}

const CATALOG = [
  tool("mcp__gmail__send_email", "Send an email message from the connected Gmail account", "mcp:gmail", { to: {}, subject: {}, body: {} }),
  tool("mcp__gmail__search_threads", "Search Gmail threads by query", "mcp:gmail", { query: {} }),
  tool("mcp__incident__notify_email", "Notify on-call by email about an incident", "mcp:incident"),
  tool("mcp__incident__create_incident", "Create an incident record", "mcp:incident"),
  tool("mcp__github__create_issue", "Create a GitHub issue in a repository", "mcp:github", { repo: {}, title: {} }),
  tool("mcp__github__list_issues", "List issues of a GitHub repository", "mcp:github", { repo: {} }),
  tool("browser_open", "Открывает страницу по адресу в изолированном браузере", "browser", { url: {} }),
  tool("browser_snapshot", "Снимок доступности открытой страницы со ссылками на элементы", "browser"),
];

test("поиск допускает документ по самому редкому слову запроса, а не по любому совпадению", () => {
  const index = buildIndex(CATALOG);
  const found = searchCatalog(index, "send gmail email", 5).map((item) => item.name);
  // «email» есть и у инцидентов, но намерение называет самое редкое
  // слово запроса — «send»: отправку письма, а не всё, где встречена почта.
  assert.deepEqual(found, ["mcp__gmail__send_email"]);
  assert.ok(!found.includes("mcp__incident__notify_email"));
});

test("слово, которого нет ни в одном инструменте, ничего не допускает", () => {
  assert.deepEqual(searchCatalog(buildIndex(CATALOG), "kubernetes", 5), []);
});

test("точное имя инструмента ранжируется первым", () => {
  const found = searchCatalog(buildIndex(CATALOG), "mcp__github__list_issues", 3);
  assert.equal(found[0]?.name, "mcp__github__list_issues");
});

test("русские окончания снимаются: «страницы» находит «страницу»", () => {
  assert.equal(stem("страницы"), stem("страница"));
  assert.equal(stem("issues"), stem("issue"));
  const found = searchCatalog(buildIndex(CATALOG), "открыть страницы в браузере", 3).map((item) => item.name);
  assert.equal(found[0], "browser_open");
});

test("перечень групп короткий и не растёт схемами", () => {
  assert.equal(catalogListing(CATALOG), "browser (2), mcp:github (2), mcp:gmail (2), mcp:incident (2)");
});

function registered(name: string, source: "product" | "mcp" | "browser", exposure: "direct" | "deferred") {
  return {
    name, label: name, description: name, parameters: { type: "object" }, source,
    group: source === "mcp" ? "mcp:x" : source, exposure, execute: async () => ({ ok: true }),
  };
}

test("реестр: мосты зарезервированы, одноимённый MCP не подменяет продуктовый, отложенное без поиска — прямое", () => {
  let search = false;
  const registry = new ToolRegistry({ toolSearchEnabled: () => search });
  registry.register({ id: "product", tools: () => [registered("delete_tasks", "product", "direct")] });
  registry.register({
    id: "mcp",
    tools: () => [
      registered("delete_tasks", "mcp", "deferred"),
      registered("tool_call", "mcp", "deferred"),
      registered("mcp__x__bad name", "mcp", "deferred"),
      registered("mcp__x__ok", "mcp", "deferred"),
    ],
  });
  assert.throws(() => registry.register({ id: "mcp", tools: () => [] }), /уже зарегистрирован/);

  let assembly = registry.assemble("conv-1");
  assert.deepEqual(assembly.direct.map((item) => `${item.source}:${item.name}`), ["product:delete_tasks", "mcp:mcp__x__ok"]);
  assert.deepEqual(assembly.deferred, []);
  assert.deepEqual(assembly.rejected.map((item) => item.reason).sort(), ["duplicate_name", "invalid_name", "reserved_name"]);

  search = true;
  assembly = registry.assemble("conv-1");
  assert.deepEqual(assembly.deferred.map((item) => item.name), ["mcp__x__ok"]);
  assert.equal(assembly.deferred[0]?.exposure, "deferred");
});

test("разворот моста: цель и её аргументы, мост без цели — отказ", () => {
  assert.equal(unwrapBridgeCall("delete_tasks", { ids: [1] }), null);
  assert.deepEqual(unwrapBridgeCall("tool_call", { name: " mcp__x__y ", arguments: { a: 1 } }), { name: "mcp__x__y", arguments: { a: 1 } });
  assert.equal(unwrapBridgeCall("tool_call", { name: "tool_call", arguments: {} }), "invalid");
  assert.equal(unwrapBridgeCall("tool_call", { arguments: {} }), "invalid");
  assert.equal(unwrapBridgeCall("tool_call", { name: "x", arguments: [1] }), "invalid");
  // Риск моста без разворота — худший: пропущенный разворот спросит, а не пропустит.
  assert.equal(toolRisk("tool_call"), "destructive");
  assert.equal(toolRisk("tool_search"), "read");
});

test("подтверждение tool_call спрашивается по настоящему инструменту", async () => {
  const asked: Array<{ name: string; input: unknown }> = [];
  const permission = sessionPermission({
    approve: async (name, input) => { asked.push({ name, input }); return { behavior: "allow", message: "ok" }; },
    isHostExecutionTool,
  });
  await permission("tool_call", { name: "mcp__crm__delete_contact", arguments: { id: 5 } }, { requestId: "r-1" } as never);
  assert.deepEqual(asked, [{ name: "mcp__crm__delete_contact", input: { id: 5 } }]);

  // Оболочка за мостом отклоняется до подтверждения, даже при выключенных подтверждениях.
  const bash = await permission("tool_call", { name: "Bash", arguments: { command: "id" } }, { requestId: "r-2" } as never);
  assert.equal(bash.behavior, "deny");
  const invalid = await permission("tool_call", { arguments: {} }, { requestId: "r-3" } as never);
  assert.equal(invalid.behavior, "deny");
  assert.equal(asked.length, 1);
});

test("аргументы проверяются по схеме цели до вызова", () => {
  const schema = {
    type: "object",
    properties: { url: { type: "string" }, depth: { type: "integer" }, mode: { type: "string", enum: ["a", "b"] } },
    required: ["url"],
    additionalProperties: false,
  };
  assert.deepEqual(validateArguments(schema, { url: "https://x" }), []);
  const errors = validateArguments(schema, { depth: 1.5, mode: "c", extra: true });
  assert.equal(errors.length, 4);
});

function mcpHarness(options: { gate?: "allow" | "deny" | "approval_missing"; purpose?: string } = {}) {
  const calls: unknown[] = [];
  const journal: Array<{ stage: string; toolName?: string; key?: string }> = [];
  const completions: unknown[] = [];
  const db = withTenantScopes({
    getAgentRuntimeContext: async () => ({ ...RUNTIME, ...(options.purpose ? { purpose: options.purpose } : {}) }),
    getQuotaStatus: async () => [],
    incrementUsage: async () => 0,
    query: async () => ({ rows: [], rowCount: 0 }),
  } as never);
  const policies = {
    listEnabled: async () => [{ name: "crm", policy: { allowedTools: ["delete_contact"], adminAdded: true } }],
  };
  const effects = {
    strict: true,
    begin: async (input: { key: string; toolName: string }) => { journal.push({ stage: "begin", toolName: input.toolName, key: input.key }); return { action: "execute", attempt: 1 }; },
    succeed: async () => { journal.push({ stage: "succeed" }); },
    fail: async () => { journal.push({ stage: "fail" }); },
  };
  const factory = new AgentToolFactory(
    { vectorGoalsEnabled: false, toolSearchEnabled: true } as never,
    db as never, {} as never, silentLogger, undefined, undefined, effects as never,
    { policies: policies as never, invoker: { invokeServer: async (...args: unknown[]) => { calls.push(args); return { deleted: true }; } } as never },
  );
  factory.setApprovalCompletionCallback(async (input) => { completions.push(input); });
  if (options.gate) factory.setExecutionGate(async () => options.gate!);
  return { factory, calls, journal, completions };
}

const TURN = { runId: "11111111-1111-1111-1111-111111111111", recorded: true, isCancelled: async () => false };

test("MCP при поиске инструментов — в каталоге, а в сессии только мосты", async () => {
  const { factory } = mcpHarness();
  await factory.sessionRuntime("conv-1");
  const names = factory.forConversation("conv-1").map((item) => item.name);
  assert.ok(!names.includes("mcp__crm__delete_contact"));
  for (const bridge of ["tool_search", "tool_describe", "tool_call"]) assert.ok(names.includes(bridge), bridge);
  assert.ok(names.includes("get_notes"), "продуктовые инструменты остаются прямыми");

  const search = factory.forConversation("conv-1").find((item) => item.name === "tool_search")!;
  const found = await runInTurn(TURN, async () => await search.execute("call-s", { query: "crm delete contact" }));
  assert.deepEqual((found.details as { results: Array<{ name: string }> }).results.map((item) => item.name), ["mcp__crm__delete_contact"]);

  const describe = factory.forConversation("conv-1").find((item) => item.name === "tool_describe")!;
  const described = await describe.execute("call-d", { names: ["mcp__crm__delete_contact", "nope"] });
  assert.deepEqual((described.details as { missing: string[] }).missing, ["nope"]);
});

test("tool_call идёт через цепочку: журнал эффектов и учёт согласия — по настоящему инструменту", async () => {
  const { factory, calls, journal, completions } = mcpHarness({ gate: "allow" });
  await factory.sessionRuntime("conv-1");
  const call = factory.forConversation("conv-1").find((item) => item.name === "tool_call")!;
  const result = await runInTurn(TURN, async () => await call.execute("call-1", { name: "mcp__crm__delete_contact", arguments: { id: 5 } }));
  assert.equal((result.details as { untrusted: boolean }).untrusted, true);
  assert.deepEqual(calls, [["crm", "delete_contact", { id: 5 }]]);
  assert.equal(journal[0]?.toolName, "mcp__crm__delete_contact");
  assert.match(String(journal[0]?.key), /mcp__crm__delete_contact/);
  assert.deepEqual(completions, [{ userId: 7, conversationId: "conv-1", toolName: "mcp__crm__delete_contact", args: { id: 5 }, outcome: "executed" }]);
});

test("tool_call без записанного согласия не выполняет инструмент", async () => {
  for (const verdict of ["approval_missing", "deny"] as const) {
    const { factory, calls, journal } = mcpHarness({ gate: verdict });
    await factory.sessionRuntime("conv-1");
    const call = factory.forConversation("conv-1").find((item) => item.name === "tool_call")!;
    const result = await runInTurn(TURN, async () => await call.execute("call-1", { name: "mcp__crm__delete_contact", arguments: { id: 5 } }));
    assert.equal((result.details as { ok: boolean }).ok, false);
    assert.deepEqual(calls, [], verdict);
    assert.deepEqual(journal, [], "журнал эффектов не начат");
  }
});

test("tool_call соблюдает назначение conversation и не зовёт прямые инструменты", async () => {
  const restricted = mcpHarness({ gate: "allow", purpose: "profile" });
  await restricted.factory.sessionRuntime("conv-1");
  const bridge = restricted.factory.forConversation("conv-1").find((item) => item.name === "tool_call")!;
  const refused = await bridge.execute("call-1", { name: "mcp__crm__delete_contact", arguments: { id: 5 } });
  assert.match(String((refused.details as { error: string }).error), /недоступен в служебном conversation/);
  assert.deepEqual(restricted.calls, []);

  const { factory } = mcpHarness({ gate: "allow" });
  await factory.sessionRuntime("conv-1");
  const call = factory.forConversation("conv-1").find((item) => item.name === "tool_call")!;
  const direct = await call.execute("call-2", { name: "delete_tasks", arguments: { ids: [1], confirm: "DELETE" } });
  assert.match(String((direct.details as { error: string }).error), /доступен напрямую/);
  const unknown = await call.execute("call-3", { name: "mcp__crm__drop_all", arguments: {} });
  assert.match(String((unknown.details as { error: string }).error), /нет в каталоге/);
});

test("проверка согласия при выполнении: чтение проходит, опасное — только с записанным согласием", async () => {
  const approvals: Array<Record<string, unknown>> = [];
  const db = {
    withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM tool_approval_rules")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM tool_approvals")) {
        const rows = approvals.filter((row) => row.user_id === values[0] && row.conversation_id === values[1]
          && row.tool_name === values[2] && row.argument_fingerprint === values[3]
          && ["approved_once", "approved_session"].includes(String(row.status)));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new ApprovalService(db as never, true);
  const base = { userId: 7, conversationId: "conv-1", toolName: "mcp__crm__delete_contact", args: { id: 5 } };
  assert.equal(await service.authorizeExecution({ ...base, toolName: "browser_snapshot", risk: "read" }), "allow");
  assert.equal(await service.authorizeExecution({ ...base, risk: "external_side_effect" }), "approval_missing");
  approvals.push({ user_id: 7, conversation_id: "conv-1", tool_name: "mcp__crm__delete_contact", argument_fingerprint: fingerprintApprovalArguments({ id: 6 }), status: "approved_once" });
  assert.equal(await service.authorizeExecution({ ...base, risk: "external_side_effect" }), "approval_missing", "согласие на другие аргументы не подходит");
  approvals.push({ user_id: 7, conversation_id: "conv-1", tool_name: "mcp__crm__delete_contact", argument_fingerprint: fingerprintApprovalArguments({ id: 5 }), status: "approved_once" });
  assert.equal(await service.authorizeExecution({ ...base, risk: "external_side_effect" }), "allow");
  assert.equal(await new ApprovalService(db as never, false).authorizeExecution({ ...base, risk: "destructive" }), "allow");
});
