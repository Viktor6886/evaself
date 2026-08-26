/**
 * Разделы единой панели: агенты, подписки, персона и промпт, Letta и
 * мониторинг.
 *
 * Что здесь проверяется:
 *
 *   кому доступен маршрут и что происходит без подтверждения — роли и
 *     sudo решает код, и ошибка в них не видна ни по одному ответу
 *     нормального запроса;
 *   куда уходит изменяющее действие — создание, изменение и удаление
 *     агента обязаны идти в eva-agent-service тем же путём, что и
 *     production; второй механизм создания агентов был бы вторым
 *     conversational runtime (инвариант 3);
 *   что попадает в аудит и чего в нём быть не должно — версия и
 *     отпечаток персоны да, её текст нет;
 *   как различаются оплата и ручное решение администратора
 *     (инвариант 27).
 *
 * Чего здесь нет: поведения настоящего PostgreSQL. Поддельная база
 * повторяет правила выборки, но не ограничения схемы — уникальный индекс
 * «одна действующая подписка на человека» проверяет живая база в CI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAdminServer } from "../dist/admin/server.js";
import { AgentDirectoryService } from "../dist/admin/agent-directory.js";
import { AdminAgentService } from "../dist/admin/agent-admin-service.js";
import { SubscriptionAdminService } from "../dist/admin/subscription-service.js";
import { PersonaAdminService } from "../dist/admin/persona-admin-service.js";
import { LettaConsoleService } from "../dist/admin/letta-console-service.js";
import { DeleteGuard } from "../dist/letta/delete-guard.js";

const PERSONA_TEXT = "Ева — внимательный собеседник, и этого текста в журнале быть не должно";

// ---------------------------------------------------------------------
// Поддельная база
// ---------------------------------------------------------------------

class FakeDb {
  agents: Array<Record<string, unknown>> = [
    {
      agent_id: "agent-1", user_id: 11, status: "active", kind: "eva", agent_name: "Ева",
      model: "gpt", embedding_model: "emb", message_count: 4, last_message_at: "2026-08-01",
      persona_version: "abc123", sync_status: "ok", sync_at: "2026-08-02",
    },
  ];

  conversations: Array<Record<string, unknown>> = [
    {
      conversation_id: "conv-1", agent_id: "agent-1", user_id: 11, title: "Разговор",
      status: "active", message_count: 3, started_at: "2026-08-01",
      last_message_at: "2026-08-01", archived_at: null, purpose: "chat",
    },
  ];

  turns: Array<Record<string, unknown>> = [];

  users: Array<Record<string, unknown>> = [
    {
      id: "11", telegram_id: "555", username: "eva_user", first_name: "Аня",
      is_blocked: false, state: "active", plan: "free", subscription_status: "none",
    },
  ];

  subscriptions: Array<Record<string, unknown>> = [];
  events: Array<Record<string, unknown>> = [];
  /** Всё, что реально ушло в базу на запись. */
  written: string[] = [];
  private seq = 0;

  connect = async () => ({
    query: async (sql: string, values: unknown[] = []) => await this.query(sql, values),
    release: () => undefined,
  });

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("BEGIN") || text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("SELECT l.agent_id, l.user_id, l.kind")) {
      const rows = this.agents.map((row) => ({
        ...row,
        conversations: this.conversations.filter((c) => c.agent_id === row.agent_id).length,
        active_turns: this.turns.filter(
          (t) => t.agent_id === row.agent_id && t.finished_at === null,
        ).length,
        total: this.agents.length,
      }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT c.conversation_id")) {
      const rows = this.conversations.map((row) => ({ ...row, total: this.conversations.length }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT run_id, state, conversation_id FROM turn_runs")) {
      const rows = this.turns.filter((row) => row.finished_at === null);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT agent_id, meta ->> 'persona_version'")) {
      return { rows: this.agents, rowCount: this.agents.length };
    }
    if (text.startsWith("UPDATE agent_links")) {
      this.written.push("agent_links");
      const row = this.agents.find((item) => item.agent_id === values[0]);
      if (row) {
        if (values[1] !== null) row.agent_name = values[1];
        if (values[2] !== null) row.model = values[2];
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT id, telegram_id, username, first_name, is_blocked, plan")) {
      const wanted = (values[0] ?? []) as number[];
      const rows = this.users.filter((row) => wanted.includes(Number(row.id)));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, telegram_id, is_blocked, state FROM v_user_overview")) {
      const rows = this.users.filter((row) => Number(row.id) === Number(values[0]));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, plan, status, source, provider, started_at")) {
      let rows = this.subscriptions.filter((row) => Number(row.user_id) === Number(values[0]));
      if (text.includes("status = ANY($2::text[])")) {
        const statuses = values[1] as string[];
        rows = rows.filter((row) => statuses.includes(String(row.status)));
      }
      if (text.includes("source = 'payment'")) {
        rows = rows.filter((row) => row.source === "payment" && row.id !== values[1]);
      }
      return { rows: [...rows].reverse(), rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, action, plan, status, period_end")) {
      return { rows: this.events, rowCount: this.events.length };
    }
    if (text.startsWith("SELECT id, provider, amount_minor")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("SELECT plan, source, status, count(*)")) {
      return { rows: [{ plan: "plus", source: "manual", status: "active", total: "1" }], rowCount: 1 };
    }
    if (text.startsWith("SELECT s.user_id, u.telegram_id")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("UPDATE subscriptions SET status = 'expired', updated_at")) {
      this.written.push("subscriptions.expire");
      for (const row of this.subscriptions) {
        if (Number(row.user_id) === Number(values[0])) row.status = "expired";
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE subscriptions SET status = 'expired', actor_id")) {
      this.written.push("subscriptions.clear");
      const row = this.subscriptions.find((item) => item.id === values[0]);
      if (row) row.status = "expired";
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE subscriptions SET status = 'active'")) {
      this.written.push("subscriptions.restore");
      const row = this.subscriptions.find((item) => item.id === values[0]);
      if (row) row.status = "active";
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE subscriptions SET current_period_end")) {
      this.written.push("subscriptions.extend");
      const row = this.subscriptions.find((item) => item.id === values[0]);
      if (row) { row.current_period_end = values[1]; row.actor_name = values[3]; row.note = values[4]; }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith("UPDATE subscriptions SET status = 'canceled'")) {
      this.written.push("subscriptions.cancel");
      const row = this.subscriptions.find((item) => item.id === values[0]);
      if (row) { row.status = "canceled"; row.canceled_at = "2026-08-26"; }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith("INSERT INTO subscriptions")) {
      this.written.push("subscriptions.insert");
      this.seq += 1;
      const row = {
        id: this.seq, user_id: values[0], plan: values[1], status: "active",
        source: "manual", provider: null, started_at: "2026-08-26",
        current_period_start: values[2] ?? "2026-08-26", current_period_end: values[3],
        canceled_at: null, actor_name: values[5], note: values[6],
      };
      this.subscriptions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO subscription_admin_events")) {
      this.written.push("subscription_admin_events");
      this.events.push({
        id: this.events.length + 1, action: values[2], plan: values[3],
        status: values[4], period_end: values[5], actor_name: values[7],
        reason: values[8], created_at: "2026-08-26",
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

/** Внутренний клиент Agent Runtime, суженный до записи вызовов. */
class FakeAgentClient {
  calls: Array<{ path: string; method: string; body: unknown }> = [];
  responses: Record<string, unknown> = {};
  failures: Record<string, Error> = {};

  request = async (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    this.calls.push({
      path,
      method,
      body: options.body ? JSON.parse(options.body) : null,
    });
    const key = `${method} ${path.split("?")[0]}`;
    if (this.failures[key]) throw this.failures[key];
    return this.responses[key] ?? this.responses[path.split("?")[0]!] ?? {};
  };
}

function directoryOf(db: FakeDb) {
  return new AgentDirectoryService(
    db as never,
    new DeleteGuard({
      query: db.query,
      withSystemScope: async (_reason: string, work: () => Promise<unknown>) => await work(),
    } as never),
  );
}

interface HarnessOptions {
  role?: string;
  agent?: FakeAgentClient;
  monitoring?: unknown;
}

function harness(db: FakeDb, options: HarnessOptions = {}) {
  process.env.EVA_ADMIN_CRUD = "0";
  process.env.EVA_ARTIFACT_VERSIONS = "0";
  const agentClient = options.agent ?? new FakeAgentClient();
  const audits: Array<{ operation: string; details: unknown }> = [];
  const guards: string[] = [];
  const session = {
    id: "session-1",
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      username: "кто-то",
      role: options.role ?? "owner",
    },
  };
  const app = buildAdminServer({
    auth: {
      authenticate: async () => session,
      requireCsrf: () => guards.push("csrf"),
      requireSudo: async (_id: string, scope: string) => { guards.push(`sudo:${scope}`); },
    },
    audit: {
      start: async (entry: { operation: string }) => {
        audits.push({ operation: entry.operation, details: null });
        return { id: `audit-${audits.length}`, startedAt: Date.now() };
      },
      finish: async () => undefined,
      annotate: async (id: string, details: unknown) => {
        const index = Number(id.split("-")[1]) - 1;
        if (audits[index]) audits[index]!.details = details;
      },
      list: async () => [],
    },
    panel: {
      agents: new AdminAgentService(db as never, directoryOf(db), agentClient as never),
      subscriptions: new SubscriptionAdminService(db as never),
      persona: new PersonaAdminService(agentClient as never),
      letta: new LettaConsoleService(agentClient as never),
    },
    health: {
      monitoring: async () => options.monitoring ?? {
        overall_status: "green", failing: [], groups: {}, host: {},
        summary: { services: 3, healthy: 3, warnings: 0, critical: 0 },
        recent_checks: [], errors: { items: [] },
      },
    },
    config: {}, secrets: {}, operations: {}, providers: {},
    llmRouter: {}, stt: {}, integrations: {}, users: {},
    events: { publish: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    readiness: async () => true,
  } as never);
  return { app, audits, guards, agentClient, db };
}

const COOKIE = { cookie: "eva_admin=session-1" };

// ---------------------------------------------------------------------
// 1. Агенты
// ---------------------------------------------------------------------

test("список агентов называет владельца и состояние доставки персоны", async () => {
  const db = new FakeDb();
  const { app } = harness(db);
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/agents", headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.equal(payload.agents.length, 1);
  assert.equal(payload.agents[0].owner.username, "eva_user");
  assert.equal(payload.agents[0].canonicalSyncStatus, "ok");
  assert.equal(payload.agents[0].personaVersion, "abc123");
  await app.close();
});

test("создание агента идёт тем же путём, что и первое сообщение в Telegram", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.responses["POST /v1/users/ensure"] = {
    user: { id: 11 }, agent: { agent_id: "agent-9" }, agent_created: true,
  };
  const { app, audits, guards } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/agents", headers: COOKIE,
    payload: { telegram_id: 555 },
  });
  assert.equal(response.statusCode, 200, response.body);

  // Единственный вызов — production-путь. Никакого прямого создания
  // агента в обход него: второй механизм был бы вторым runtime.
  assert.deepEqual(agent.calls.map((call) => `${call.method} ${call.path}`), [
    "POST /v1/users/ensure",
  ]);
  assert.equal(agent.calls[0]!.body.create_agent, true);
  assert.ok(guards.includes("sudo:users:write"), "создание агента прошло без sudo");
  assert.equal(audits.at(-1)!.details.agent_id, "agent-9");
  await app.close();
});

test("изменение агента пишет сначала в Letta, потом в зеркало", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.responses["PATCH /v1/sdk/agents/agent-1"] = { agent: { id: "agent-1", name: "Ева 2" } };
  const { app } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "PATCH", url: "/api/admin/v1/panel/agents/agent-1", headers: COOKIE,
    payload: { name: "Ева 2", model: "gpt-next" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(agent.calls[0]!.path, "/v1/sdk/agents/agent-1");
  // Зеркало обновилось только после успешной записи в Letta.
  assert.equal(db.written.includes("agent_links"), true);
  assert.equal(db.agents[0]!.model, "gpt-next");
  await app.close();
});

test("системный промпт нельзя подменить у одного агента", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  const { app } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "PATCH", url: "/api/admin/v1/panel/agents/agent-1", headers: COOKIE,
    payload: { system: "свой промпт" },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error.message, /Персона и промпт/);
  assert.equal(agent.calls.length, 0, "запрос ушёл в runtime до отказа");
  await app.close();
});

test("удаление агента требует подтверждения идентификатором", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  const { app } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "DELETE", url: "/api/admin/v1/panel/agents/agent-1", headers: COOKIE,
    payload: { confirm: "да" },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(agent.calls.length, 0, "агент удалён без подтверждения");
  await app.close();
});

test("удаление отклоняется, пока у агента идёт ход", async () => {
  const db = new FakeDb();
  db.turns.push({
    run_id: "11111111-1111-1111-1111-111111111111", conversation_id: "conv-1",
    agent_id: "agent-1", state: "approval_pending", finished_at: null,
  });
  const agent = new FakeAgentClient();
  const { app } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "DELETE", url: "/api/admin/v1/panel/agents/agent-1", headers: COOKIE,
    payload: { confirm: "agent-1" },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(agent.calls.length, 0, "необратимое удаление выполнено во время хода");
  await app.close();
});

test("подтверждённое удаление уходит в runtime вместе с confirm", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  const { app, guards } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "DELETE", url: "/api/admin/v1/panel/agents/agent-1", headers: COOKIE,
    payload: { confirm: "agent-1" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(agent.calls[0]!.method, "DELETE");
  assert.match(agent.calls[0]!.path, /^\/v1\/sdk\/agents\/agent-1\?confirm=agent-1$/);
  assert.ok(guards.includes("sudo:users:write"));
  await app.close();
});

test("viewer читает агентов, но не меняет их", async () => {
  const db = new FakeDb();
  const { app } = harness(db, { role: "viewer" });
  await app.ready();
  const read = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/agents", headers: COOKIE,
  });
  assert.equal(read.statusCode, 200, read.body);
  for (const [method, url] of [
    ["POST", "/api/admin/v1/panel/agents"],
    ["PATCH", "/api/admin/v1/panel/agents/agent-1"],
    ["DELETE", "/api/admin/v1/panel/agents/agent-1"],
  ] as const) {
    const response = await app.inject({ method, url, headers: COOKIE, payload: {} });
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
  }
  await app.close();
});

test("карточка агента переживает недоступный App Server", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.failures["GET /v1/sdk/agents/agent-1"] = new Error("App Server недоступен");
  const { app } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/agents/agent-1", headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.equal(payload.live, null);
  assert.ok(payload.live_error);
  assert.equal(payload.agent.agentId, "agent-1", "каталог пропал вместе с живым состоянием");
  await app.close();
});

// ---------------------------------------------------------------------
// 2. Подписки
// ---------------------------------------------------------------------

test("ручное назначение отличимо от оплаты и требует причины", async () => {
  const db = new FakeDb();
  const { app, guards } = harness(db);
  await app.ready();

  const noReason = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/assign", headers: COOKIE,
    payload: { plan: "plus", days: 30 },
  });
  assert.equal(noReason.statusCode, 400, noReason.body);

  const assigned = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/assign", headers: COOKIE,
    payload: { plan: "plus", days: 30, reason: "компенсация за сбой" },
  });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.equal(assigned.json().subscription.source, "manual");
  assert.ok(guards.includes("sudo:users:write"));
  // Решение попало и в доменную историю, и в аудит маршрута.
  assert.ok(db.written.includes("subscription_admin_events"));
  await app.close();
});

test("снятие ручного решения возвращает оплаченный доступ", async () => {
  const db = new FakeDb();
  db.subscriptions.push({
    id: 100, user_id: 11, plan: "pro", status: "expired", source: "payment",
    provider: "lava", started_at: "2026-07-01", current_period_start: "2026-07-01",
    current_period_end: "2027-01-01", canceled_at: null, actor_name: null, note: null,
  });
  db.subscriptions.push({
    id: 101, user_id: 11, plan: "plus", status: "active", source: "manual",
    provider: null, started_at: "2026-08-01", current_period_start: "2026-08-01",
    current_period_end: "2026-09-01", canceled_at: null, actor_name: "кто-то", note: "n",
  });
  const { app } = harness(db);
  await app.ready();
  const response = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/clear-manual", headers: COOKIE,
    payload: { reason: "решение отменено" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().restored_payment, true);
  assert.equal(db.subscriptions.find((row) => row.id === 101)!.status, "expired");
  assert.equal(db.subscriptions.find((row) => row.id === 100)!.status, "active");
  await app.close();
});

test("снять оплаченную подписку как «ручную» нельзя", async () => {
  const db = new FakeDb();
  db.subscriptions.push({
    id: 100, user_id: 11, plan: "pro", status: "active", source: "payment",
    provider: "lava", started_at: "2026-07-01", current_period_start: "2026-07-01",
    current_period_end: "2027-01-01", canceled_at: null, actor_name: null, note: null,
  });
  const { app } = harness(db);
  await app.ready();
  const response = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/clear-manual", headers: COOKIE,
    payload: { reason: "хочу снять" },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(db.subscriptions[0]!.status, "active", "оплаченный доступ снят снятием ручного решения");
  await app.close();
});

test("отмена подписки требует подтверждения идентификатором человека", async () => {
  const db = new FakeDb();
  db.subscriptions.push({
    id: 100, user_id: 11, plan: "pro", status: "active", source: "payment",
    provider: "lava", started_at: "2026-07-01", current_period_start: "2026-07-01",
    current_period_end: "2027-01-01", canceled_at: null, actor_name: null, note: null,
  });
  const { app } = harness(db);
  await app.ready();
  const without = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/cancel", headers: COOKIE,
    payload: { reason: "по просьбе" },
  });
  assert.equal(without.statusCode, 400, without.body);
  assert.equal(db.subscriptions[0]!.status, "active");

  const confirmed = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/cancel", headers: COOKIE,
    payload: { reason: "по просьбе", confirm: "11" },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(db.subscriptions[0]!.status, "canceled");
  await app.close();
});

test("продление считается от конца периода, а не от «сейчас»", async () => {
  const db = new FakeDb();
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
  db.subscriptions.push({
    id: 100, user_id: 11, plan: "pro", status: "active", source: "payment",
    provider: "lava", started_at: "2026-07-01", current_period_start: "2026-07-01",
    current_period_end: future, canceled_at: null, actor_name: null, note: null,
  });
  const { app } = harness(db);
  await app.ready();
  const response = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/subscriptions/11/extend", headers: COOKIE,
    payload: { days: 30, reason: "продление" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const end = new Date(String(response.json().subscription.current_period_end)).getTime();
  const expected = new Date(future).getTime() + 30 * 86_400_000;
  assert.ok(Math.abs(end - expected) < 60_000, "продление отобрало оставшийся период");
  await app.close();
});

test("действующее право доступа считает сервер, а не интерфейс", async () => {
  const db = new FakeDb();
  db.users[0]!.is_blocked = true;
  db.subscriptions.push({
    id: 100, user_id: 11, plan: "pro", status: "active", source: "payment",
    provider: "lava", started_at: "2026-07-01", current_period_start: "2026-07-01",
    current_period_end: "2027-01-01", canceled_at: null, actor_name: null, note: null,
  });
  const { app } = harness(db);
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/subscriptions/11", headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  // Блокировка старше оплаты — приоритет доступа инварианта 27.
  assert.equal(response.json().access.level, "blocked");
  await app.close();
});

// ---------------------------------------------------------------------
// 3. Персона и системный промпт
// ---------------------------------------------------------------------

test("сохранение персоны требует sudo и подтверждения именем источника", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.responses["PUT /v1/canonical-context/persona"] = {
    document: { version: 3, checksum: "deadbeef", bytes: 120, origin: "registry", text: PERSONA_TEXT },
    sync: { updated: 2, failed: 0 },
    sync_error: null,
  };
  const { app, guards, audits } = harness(db, { agent });
  await app.ready();

  const without = await app.inject({
    method: "PUT", url: "/api/admin/v1/panel/persona/persona", headers: COOKIE,
    payload: { text: PERSONA_TEXT, reason: "тон" },
  });
  assert.equal(without.statusCode, 400, without.body);
  assert.equal(agent.calls.length, 0, "текст ушёл в runtime без подтверждения");

  const saved = await app.inject({
    method: "PUT", url: "/api/admin/v1/panel/persona/persona", headers: COOKIE,
    payload: { text: PERSONA_TEXT, reason: "тон", confirm: "persona" },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.ok(guards.includes("sudo:settings:write"));

  // В аудите — версия, отпечаток и итог применения. Текста нет: персона
  // не раскрывается в журнале административных вызовов.
  const details = audits.at(-1)!.details as Record<string, unknown>;
  assert.equal(details.version, 3);
  assert.equal(details.checksum, "deadbeef");
  assert.equal(details.sync_updated, 2);
  assert.equal(JSON.stringify(audits).includes(PERSONA_TEXT), false);
  await app.close();
});

test("повторная синхронизация доступна оператору и ничего не подтверждает", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.responses["POST /v1/canonical-context/sync"] = {
    document: {}, sync: { updated: 1, failed: 0 }, sync_error: null,
  };
  const { app } = harness(db, { role: "operator", agent });
  await app.ready();
  const response = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/persona/sync", headers: COOKIE, payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(agent.calls[0]!.path, "/v1/canonical-context/sync");
  await app.close();
});

test("оператор не правит канонический текст", async () => {
  const db = new FakeDb();
  const { app } = harness(db, { role: "operator" });
  await app.ready();
  const response = await app.inject({
    method: "PUT", url: "/api/admin/v1/panel/persona/persona", headers: COOKIE,
    payload: { text: "x", reason: "y", confirm: "persona" },
  });
  assert.equal(response.statusCode, 403, response.body);
  await app.close();
});

// ---------------------------------------------------------------------
// 4. Letta
// ---------------------------------------------------------------------

test("раздел Letta собирается даже когда часть источников недоступна", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.responses["GET /v1/system"] = { version: "0.3.0", runtime: "letta-agent-sdk" };
  agent.failures["GET /v1/stats"] = new Error("недоступно");
  const { app } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/letta", headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.equal(payload.system.version, "0.3.0");
  assert.equal(payload.stats, null);
  assert.ok(payload.errors.length >= 1);
  await app.close();
});

test("переписка в разделе Letta читается только под отдельным грантом", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  agent.responses["GET /v1/sdk/conversations/conv-1/messages"] = {
    messages: [{ role: "user", content: "личное" }],
  };
  const { app, guards, audits } = harness(db, { agent });
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/v1/panel/letta/conversations/conv-1/messages?limit=10",
    headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(guards.includes("sudo:users:messages"), "переписка открыта без отдельного гранта");
  // В журнале — счётчик, а не текст.
  const entry = audits.at(-1)!;
  assert.match(entry.operation, /messages/);
  assert.equal(JSON.stringify(audits).includes("личное"), false);
  await app.close();
});

test("оператор не читает переписку, даже зная conversation_id", async () => {
  const db = new FakeDb();
  const { app } = harness(db, { role: "operator" });
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/v1/panel/letta/conversations/conv-1/messages",
    headers: COOKIE,
  });
  assert.equal(response.statusCode, 403, response.body);
  await app.close();
});

test("остановка хода требует подтверждения идентификатором диалога", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  const { app } = harness(db, { role: "operator", agent });
  await app.ready();
  const without = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/letta/conversations/conv-1/abort",
    headers: COOKIE, payload: {},
  });
  assert.equal(without.statusCode, 400, without.body);
  assert.equal(agent.calls.length, 0);

  const confirmed = await app.inject({
    method: "POST", url: "/api/admin/v1/panel/letta/conversations/conv-1/abort",
    headers: COOKIE, payload: { confirm: "conv-1" },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  await app.close();
});

test("раздел Letta не открывает произвольный внутренний путь", async () => {
  const db = new FakeDb();
  const agent = new FakeAgentClient();
  const { app } = harness(db, { agent });
  await app.ready();
  // Попытка выйти из-под фиксированного пути ловится проверкой
  // идентификатора, а не доезжает до runtime отдельным запросом.
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/v1/panel/letta/agents/..%2F..%2Fv1%2Fllm%2Fproviders/conversations",
    headers: COOKIE,
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(agent.calls.length, 0);
  await app.close();
});

// ---------------------------------------------------------------------
// 5. Мониторинг
// ---------------------------------------------------------------------

test("мониторинг отдаёт состояние, проверки и ошибки одним ответом", async () => {
  const db = new FakeDb();
  const { app } = harness(db, {
    monitoring: {
      overall_status: "yellow",
      failing: [{ id: "searxng", title: "SearXNG", color: "yellow" }],
      groups: { core: [] }, host: { hostname: "eva" },
      summary: { services: 5, healthy: 4, warnings: 1, critical: 0, critical_events_24h: 2 },
      recent_checks: [{ id: "c1", title: "SearXNG", status: "failure", ok: false }],
      errors: { items: [{ source: "check", title: "SearXNG", message: "таймаут" }] },
    },
  });
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/monitoring?hours=6&limit=10", headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.equal(payload.overall_status, "yellow");
  assert.equal(payload.recent_checks.length, 1);
  assert.equal(payload.errors.items.length, 1);
  await app.close();
});

test("мониторинг доступен на чтение любому вошедшему", async () => {
  const db = new FakeDb();
  const { app } = harness(db, { role: "viewer" });
  await app.ready();
  const response = await app.inject({
    method: "GET", url: "/api/admin/v1/panel/monitoring", headers: COOKIE,
  });
  assert.equal(response.statusCode, 200, response.body);
  await app.close();
});
