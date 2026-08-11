/**
 * Agent tools run whatever the model decides to call, against a shared
 * database. The property that keeps one person's notes, budget and tasks
 * away from another's is that every statement is scoped by the `user_id`
 * derived from the conversation — never by an argument the model supplied.
 *
 * These tests assert that property directly on the SQL each tool emits.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentToolFactory, createCanonicalToolManifestRegistry } from "../dist/agent-tools.js";
import { McpServerPolicyRepository } from "../dist/tools/gateway.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";
import { runInTurn } from "../dist/turns/turn-context.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const RUNTIME = {
  userId: 7,
  telegramId: 42,
  chatId: 42,
  conversationId: "conv-1",
  // The main user-facing conversation: service purposes gate tools off.
  purpose: "chat" as const,
  timezone: "Europe/Amsterdam",
  responseMode: "text" as const,
  useEmoji: true,
};

/** Tables holding per-user rows: touching one without a user filter is a leak. */
const USER_SCOPED_TABLES = ["eva_notes", "budget_entries", "tasks", "user_preferences"];

function harness(options: { rows?: Record<string, unknown>[]; rowCount?: number; runtime?: Omit<typeof RUNTIME, "purpose"> & { purpose: "chat" | "research" } } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    getAgentRuntimeContext: () => Promise.resolve(options.runtime ?? RUNTIME),
    getQuotaStatus: () => Promise.resolve([{ metric: "web_search", remaining: 5 }]),
    incrementUsage: () => Promise.resolve(1),
    query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      return Promise.resolve({
        rows: options.rows ?? [{ id: 1, title: "x" }],
        rowCount: options.rowCount ?? 1,
      });
    },
    // Task tools write through a transaction; the fake client records the
    // same way so the scoping assertions see those statements too.
    transaction<T>(work: (client: { query: typeof db.query }) => Promise<T>) {
      return work({ query: db.query });
    },
  };
  const factory = new AgentToolFactory(
    {
      searxngUrl: "http://search",
      todoistApiUrl: "https://api.todoist.test",
      todoistApiToken: "",
      todoistProjectId: "",
      // VECTOR goal tools have their own suite; keep this one focused on the
      // per-user scoping of notes, budget and tasks.
      vectorGoalsEnabled: false,
    } as never,
    withTenantScopes(db) as never,
    { setReaction: () => Promise.resolve() } as never,
    silentLogger,
  );
  const tools = new Map(
    factory.forConversation("conv-1").map((tool) => [tool.name, tool]),
  );
  return { factory, tools, statements };
}

async function call(name: string, args: Record<string, unknown>) {
  const { tools, statements } = harness();
  const tool = tools.get(name);
  assert.ok(tool, `${name} is not registered`);
  const result = await tool.execute("call-1", args);
  return { result, statements };
}

/**
 * Every statement touching a per-user table must either filter on
 * `user_id = $n` or insert user_id as the first column — and the value bound
 * there has to be the runtime's user, not something the model passed in.
 */
function assertUserScoped(statements: Array<{ sql: string; values: unknown[] }>, label: string) {
  assert.ok(statements.length > 0, `${label} produced no SQL`);
  for (const { sql, values } of statements) {
    const normalized = sql.replace(/\s+/g, " ").toLowerCase();
    if (!USER_SCOPED_TABLES.some((table) => normalized.includes(table))) continue;

    const filter = /user_id\s*=\s*\$(\d+)/.exec(normalized);
    if (filter) {
      const index = Number(filter[1]) - 1;
      assert.equal(
        values[index],
        RUNTIME.userId,
        `${label}: user_id placeholder $${filter[1]} is not bound to the runtime user`,
      );
      continue;
    }
    // INSERT … (user_id, …) VALUES ($1, …)
    assert.match(
      normalized,
      /insert into \w+\s*\(\s*user_id[,)]/,
      `${label}: statement is not scoped by user_id -> ${normalized.slice(0, 120)}`,
    );
    assert.equal(
      values[0],
      RUNTIME.userId,
      `${label}: an insert must bind the runtime user id first`,
    );
  }
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ["save_note", { title: "t", content: "c" }],
  ["get_notes", { query: "что-нибудь" }],
  ["update_note", { id: 1, title: "new" }],
  ["delete_notes", { ids: [1, 2], confirm: "DELETE" }],
  ["save_budget_record", { type: "expense", amount: 12.5 }],
  ["get_budget_records", {}],
  ["update_budget_record", { id: 1, amount: 3 }],
  ["delete_budget_records", { ids: [1], confirm: "DELETE" }],
  ["save_task", { title: "задача" }],
  ["get_tasks", {}],
  ["update_task", { id: 1, status: "done" }],
  ["delete_tasks", { ids: [1], confirm: "DELETE" }],
  ["get_tasks_from_nocodb", {}],
  ["update_task_in_nocodb", { id: 1, status: "done" }],
  ["delete_tasks_from_nocodb", { ids: [1], confirm: "DELETE" }],
  ["update_response_mode", { mode: "voice" }],
  ["update_llm_quality_mode", { mode: "quality" }],
  ["LIGHTRAG_INSERT", { text: "материал" }],
  ["LIGHTRAG_QUERY", { query: "что-нибудь" }],
];

for (const [name, args] of CASES) {
  test(`${name} scopes every statement to the conversation's user`, async () => {
    const { statements } = await call(name, args);
    assertUserScoped(statements, name);
  });
}

test("a model-supplied user_id cannot widen the scope", async () => {
  // The tool schemas have no user_id, but a model can pass anything.
  const { statements } = await call("get_notes", { user_id: 999, query: "x" });
  assertUserScoped(statements, "get_notes");
  for (const { values } of statements) {
    assert.ok(!values.includes(999), "a model-supplied id must never be bound");
  }
});

test("all built domain tools have manifests and gateway side effects fail closed", async () => {
  const statements: unknown[] = [];
  const db = withTenantScopes({
    getAgentRuntimeContext: () => Promise.resolve(RUNTIME),
    getQuotaStatus: async () => [], incrementUsage: async () => 0,
    query: async (...args: unknown[]) => {
      statements.push(args);
      if (String(args[0]).includes("tool_gateway_state")) return { rows: [{ enabled: true, breaker_state: "closed", probe_after: null }], rowCount: 1 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
    transaction: async (work: (client: unknown) => Promise<unknown>) => await work({ query: async () => ({ rows: [] }) }),
  } as never);
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true, todoistApiToken: "test" } as never, db as never, { setReaction: async () => {} } as never, silentLogger);
  const tools = factory.forConversation("conv-1");
  const canonicalNames = new Set(factory.manifests.list().map((item) => item.name));
  assert.ok(tools.every((tool) => canonicalNames.has(tool.name)));
  assert.equal(factory.manifests.get("TODOIST_CREATE_TASK")?.risk, "external_side_effect");
  assert.equal(factory.manifests.get("TODOIST_DELETE_TASK")?.risk, "destructive");
  const response = await tools.find((item) => item.name === "save_note")!.execute("call", { title: "t", content: "c" });
  assert.match(String((response.details as { error: string }).error), /journal|disabled|lease/i);
  assert.ok(!statements.some((entry) => String((entry as unknown[])[0]).includes("eva_notes")));
});


test("canonical registry is populated independently and carries tool-specific policy", () => {
  const registry = createCanonicalToolManifestRegistry();
  assert.ok(registry.list().length > 20);
  assert.equal(registry.get("get_notes")?.risk, "read");
  assert.deepEqual(registry.get("web_search")?.purposes, ["chat", "research"]);
  assert.equal(registry.get("delete_tasks")?.approvalRequired, true);
  assert.equal(registry.get("delete_tasks")?.mandatoryApprovalCategory, "data_deletion");
});

test("side effects require a canonical call key and strict journal", async () => {
  const statements: unknown[] = [];
  const db = withTenantScopes({
    getAgentRuntimeContext: () => Promise.resolve(RUNTIME), getQuotaStatus: async () => [], incrementUsage: async () => 0,
    query: async (...args: unknown[]) => { statements.push(args); return String(args[0]).includes("tool_gateway_state") ? { rows: [{ enabled: true, breaker_state: "closed", probe_after: null }], rowCount: 1 } : { rows: [], rowCount: 0 }; },
  } as never);
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true } as never, db as never, {} as never, silentLogger);
  const response = await factory.forConversation("conv-1").find((tool) => tool.name === "save_note")!.execute("", { title: "t", content: "c" });
  assert.match(String((response.details as { error: string }).error), /journal|canonical.*call|disabled|lease/i);
  assert.ok(!statements.some((entry) => String((entry as unknown[])[0]).includes("eva_notes")));
});

test("delete tools refuse to run without ids", async () => {
  const { result } = await call("delete_notes", { ids: [], confirm: "DELETE" });
  const payload = result.details as { ok: boolean; error?: string };
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /ids/);
});

test("delete tools refuse to run without the confirmation word", async () => {
  for (const name of ["delete_notes", "delete_budget_records", "delete_tasks"]) {
    const { result, statements } = await call(name, { ids: [1] });
    assert.equal((result.details as { ok: boolean }).ok, false, name);
    assert.equal(statements.length, 0, `${name} must not touch the database`);
  }
});

test("a tool failure is reported to the model, not thrown at the runtime", async () => {
  const { tools } = harness();
  const tool = tools.get("save_note");
  // Missing required argument: the model must get a structured error back
  // so it can retry, and the turn must not blow up.
  const result = await tool!.execute("call-1", { title: "only a title" });
  assert.equal((result.details as { ok: boolean }).ok, false);
});

test("arguments that are not a JSON object are rejected", async () => {
  const { tools } = harness();
  const result = await tools.get("get_notes")!.execute("call-1", "not an object" as never);
  assert.equal((result.details as { ok: boolean }).ok, false);
});


test("ordinary tool errors reach the gateway breaker before becoming safe model errors", async () => {
  let recordedFailures = 0;
  const db = withTenantScopes({
    getAgentRuntimeContext: () => Promise.resolve(RUNTIME), getQuotaStatus: async () => [], incrementUsage: async () => 0,
    query: async (sql: string) => {
      if (sql.includes("FROM tool_gateway_state")) return { rows: [] };
      if (sql.includes("consecutive_errors")) { recordedFailures += 1; return { rows: [{ tool_name: "get_notes", enabled: true, breaker_state: "closed", consecutive_errors: 1, probe_after: null }] }; }
      throw new Error("database unavailable");
    },
  } as never);
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true } as never, db as never, {} as never, silentLogger);
  const response = await factory.forConversation("conv-1").find((tool) => tool.name === "get_notes")!.execute("call-1", {});
  assert.equal((response.details as { ok: boolean }).ok, false);
  assert.equal(recordedFailures, 1);
});

test("an unparseable cron is refused before a task row is written", async () => {
  const { result, statements } = await call("save_task", {
    title: "невозможная задача",
    repeat: true,
    cron: "0 0 30 2 *",
  });
  assert.equal((result.details as { ok: boolean }).ok, false);
  assert.equal(statements.length, 0, "nothing may be written for a cron that never fires");
});

test("a cron with the wrong number of fields is refused", async () => {
  const { result, statements } = await call("save_task", {
    title: "плохой cron",
    repeat: true,
    cron: "0 0 *",
  });
  assert.equal((result.details as { ok: boolean }).ok, false);
  assert.equal(statements.length, 0);
});

test("a valid repeating task is written with its next run", async () => {
  const { result, statements } = await call("save_task", {
    title: "каждое утро",
    repeat: true,
    cron: "0 9 * * *",
  });
  assert.equal((result.details as { ok: boolean }).ok, true);
  assert.equal(statements.length, 2, "задача и событие created записываются отдельно");
  const nextRun = statements[0]!.values[9];
  assert.ok(typeof nextRun === "string" && !Number.isNaN(Date.parse(nextRun)));
});

test("set_reaction refuses an emoji Telegram does not support", async () => {
  const { result } = await call("set_reaction", { emoji: "🧿" });
  assert.equal((result.details as { ok: boolean }).ok, false);
});

test("web_search stops at the quota instead of spending it", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const factory = new AgentToolFactory(
    { searxngUrl: "http://search", todoistApiUrl: "", todoistApiToken: "", todoistProjectId: "", vectorGoalsEnabled: false } as never,
    withTenantScopes({
      getAgentRuntimeContext: () => Promise.resolve(RUNTIME),
      getQuotaStatus: () => Promise.resolve([{ metric: "web_search", remaining: 0 }]),
      incrementUsage: () => Promise.resolve(1),
      query(sql: string, values: unknown[] = []) {
        statements.push({ sql, values });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    }) as never,
    {} as never,
    silentLogger,
  );
  const tool = factory.forConversation("conv-1").find((item) => item.name === "web_search");
  const result = await tool!.execute("call-1", { query: "погода" });
  const payload = result.details as { ok: boolean; error?: string };
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /[Лл]имит/);
});

test("live session policy uses canonical runtime and purpose-constrained inventory", async () => {
  const runtime = { ...RUNTIME, conversationId: "research-conversation", purpose: "research" as const };
  const { factory } = harness({ runtime });
  const policy = await factory.sessionPolicy(runtime.conversationId);
  assert.equal(policy.runtime, runtime);
  assert.ok(policy.visibleTools.every((name) => [
    "web_search", "PERPLEXITY_SEARCH", "brave_search", "LIGHTRAG_QUERY",
  ].includes(name)));
  assert.equal(policy.visibleTools.includes("save_task"), false);
});


test("live session policy intersects canonical task and skill selectors from the conversation", async () => {
  const runtime = { ...RUNTIME, currentTaskTools: ["get_notes", "save_task"], selectedSkillTools: ["get_notes"] };
  const { factory } = harness({ runtime });
  const policy = await factory.sessionPolicy("conv-1");
  assert.deepEqual(policy.visibleTools, ["get_notes"]);
});

test("gateway materializes a purpose-constrained baseline for fresh null selectors and uses it live", async () => {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const runtime = { ...RUNTIME, currentTaskTools: null, selectedSkillTools: null, userText: "__INJECTED_TOOL__" };
  const db = withTenantScopes({
    getAgentRuntimeContext: async () => runtime,
    getQuotaStatus: async () => [], incrementUsage: async () => 0,
    query: async (sql: string, values: unknown[] = []) => {
      writes.push({ sql, values });
      const baseline = values[2] as string[];
      return { rows: [{ current_task_tools: baseline, selected_skill_tools: baseline }], rowCount: 1 };
    },
  } as never);
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true } as never, db as never, {} as never, silentLogger);
  const session = await factory.sessionPolicy("conv-1");
  const update = writes.find(({ sql }) => sql.includes("UPDATE agent_conversations"));
  assert.ok(update);
  assert.match(update.sql, /current_task_tools\s*=\s*COALESCE\(current_task_tools/i);
  assert.match(update.sql, /selected_skill_tools\s*=\s*COALESCE\(selected_skill_tools/i);
  assert.match(update.sql, /user_id\s*=\s*\$2/i);
  assert.deepEqual(update.values.slice(0, 2), ["conv-1", RUNTIME.userId]);
  assert.deepEqual(session.visibleTools, update.values[2]);
  assert.ok(session.visibleTools.length > 0);
  assert.equal(session.visibleTools.includes("__INJECTED_TOOL__"), false);
  assert.ok(session.visibleTools.every((name) => factory.manifests.get(name)?.purposes.includes("chat")));
});

test("materialization preserves explicit narrower and empty selectors", async () => {
  for (const runtime of [
    { ...RUNTIME, currentTaskTools: ["get_notes", "save_task"], selectedSkillTools: ["get_notes"] },
    { ...RUNTIME, currentTaskTools: [], selectedSkillTools: null },
  ]) {
    let updateValues: unknown[] = [];
    const db = withTenantScopes({
      getAgentRuntimeContext: async () => runtime,
      getQuotaStatus: async () => [], incrementUsage: async () => 0,
      query: async (_sql: string, values: unknown[] = []) => {
        updateValues = values;
        const baseline = values[2] as string[];
        return { rows: [{
          current_task_tools: runtime.currentTaskTools ?? baseline,
          selected_skill_tools: runtime.selectedSkillTools ?? baseline,
        }], rowCount: 1 };
      },
    } as never);
    const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true } as never, db as never, {} as never, silentLogger);
    const session = await factory.sessionPolicy("conv-1");
    assert.deepEqual(session.visibleTools, runtime.currentTaskTools?.length === 0 ? [] : ["get_notes"]);
    if (runtime.selectedSkillTools === null) assert.deepEqual(updateValues.slice(0, 2), ["conv-1", RUNTIME.userId]);
    else assert.deepEqual(updateValues, []);
  }
});

test("selector baseline cannot be influenced by untrusted text and failure fails closed", async () => {
  const injected = "delete_notes";
  const runtime = { ...RUNTIME, currentTaskTools: null, selectedSkillTools: null, userText: injected };
  const db = withTenantScopes({
    getAgentRuntimeContext: async () => runtime,
    getQuotaStatus: async () => [], incrementUsage: async () => 0,
    query: async () => { throw new Error("materialization unavailable"); },
  } as never);
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true } as never, db as never, {} as never, silentLogger);
  await assert.rejects(factory.sessionPolicy("conv-1"), /materialization unavailable/);
});

test("admin-created enabled MCP policy becomes a live allowlisted SDK tool and invokes by server name", async () => {
  const policyRows: Record<string, unknown>[] = [];
  const db = withTenantScopes({
    getAgentRuntimeContext: async () => RUNTIME, getQuotaStatus: async () => [], incrementUsage: async () => 0,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO mcp_server_policies")) { const row = { id: 1, name: values[0], url: values[1], transport: values[2], allowed_tools: values[3], secret_record_ids: values[4], timeout_ms: values[5], max_result_bytes: values[6], enabled: false }; policyRows.push(row); return { rows: [row], rowCount: 1 }; }
      if (sql.includes("UPDATE mcp_server_policies") && sql.includes("enabled")) { policyRows[0]!.enabled = values[1]; return { rows: [policyRows[0]!], rowCount: 1 }; }
      if (sql.includes("FROM mcp_server_policies") && sql.includes("enabled")) return { rows: policyRows.filter((row) => row.enabled), rowCount: policyRows.length };
      if (sql.includes("UPDATE agent_conversations")) return { rows: [{ current_task_tools: values[2], selected_skill_tools: values[2] }], rowCount: 1 };
      if (sql.includes("tool_gateway_state") && sql.includes("RETURNING generation")) return { rows: [{ generation: 1 }], rowCount: 1 };
      if (sql.includes("tool_gateway_state")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  } as never);
  const policies = new McpServerPolicyRepository(db as never);
  await policies.create({ name: "knowledge", url: "https://mcp.test/rpc", transport: "http", allowedTools: ["search"], secretIds: ["secret-record-id"], timeoutMs: 700, maxResultBytes: 4096, createdBy: "00000000-0000-0000-0000-000000000009" });
  await policies.setEnabled("knowledge", true);
  const calls: unknown[] = [];
  const effects = { strict: true, begin: async () => ({ action: "execute", attempt: 1 }), succeed: async () => {}, fail: async () => {} };
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, toolGatewayEnabled: true } as never, db as never, {} as never, silentLogger, undefined, undefined, undefined, effects as never, { policies, invoker: { invokeServer: async (...args: unknown[]) => { calls.push(args); return { hits: 1 }; } } as never });
  const session = await factory.sessionPolicy("conv-1");
  assert.ok(session.visibleTools.includes("mcp__knowledge__search"));
  const live = factory.forConversation("conv-1").find((tool) => tool.name === "mcp__knowledge__search");
  assert.ok(live);
  const executed = await runInTurn({ runId: "11111111-1111-1111-1111-111111111111", recorded: true, isCancelled: async () => false }, async () => await live.execute("call-1", { q: "safe" }));
  assert.deepEqual(executed.details, { hits: 1 });
  assert.deepEqual(calls, [["knowledge", "search", { q: "safe" }]]);
  assert.equal(factory.manifests.get("mcp__knowledge__search")?.limits.maxResultBytes, 4096);
});
