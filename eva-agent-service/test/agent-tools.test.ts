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

import { AgentToolFactory } from "../dist/agent-tools.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

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

function harness(options: { rows?: Record<string, unknown>[]; rowCount?: number } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    getAgentRuntimeContext: () => Promise.resolve(RUNTIME),
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
  return { tools, statements };
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
