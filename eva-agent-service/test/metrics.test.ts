/**
 * Prometheus-выдача /metrics.
 *
 * Проверяется не «endpoint отвечает», а три вещи, ради которых он и
 * заводился: перечисленные в задании метрики действительно есть,
 * недоступная база выдачу не роняет, и открыть её без внутреннего ключа
 * нельзя.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MetricsCollector } from "../dist/metrics.js";
import { buildServer } from "../dist/server.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Метрики, перечисленные в заданиях шагов 3 и 4, вместе с ожидаемым
 * типом. Тип проверяется поимённо, а не «gauge или counter»: счётчик,
 * молча ставший датчиком, — это сломанная арифметика в панели.
 */
const REQUIRED: Record<string, "gauge" | "counter"> = {
  eva_inbox_pending: "gauge",
  eva_inbox_oldest_age_seconds: "gauge",
  eva_outbox_pending: "gauge",
  eva_outbox_oldest_age_seconds: "gauge",
  eva_turns_active: "gauge",
  eva_turns_active_total: "gauge",
  eva_turn_wait_ms: "gauge",
  eva_turn_duration_ms: "gauge",
  eva_user_locks: "gauge",
  eva_letta_sessions: "gauge",
  eva_postgres_pool_connections: "gauge",
  eva_event_loop_lag_seconds: "gauge",
  eva_turn_slots_used: "gauge",
  eva_turn_slots_limit: "gauge",
  eva_inbox_foreign_lock_releases_total: "counter",
};

function collector(query: (sql: string) => Promise<{ rows: unknown[] }>): MetricsCollector {
  return new MetricsCollector({
    db: withTenantScopes({ query: async (sql: string) => await query(sql) }) as never,
    sessions: () => ({ active: 2, idle: 3 }),
    locks: () => ({ held: 1, queued: 4 }),
    poolStats: () => ({ total: 10, idle: 7, waiting: 0 }),
    slots: async () => ({
      interactive: { used: 5, limit: 108 },
      background: { used: 1, limit: 12 },
      research: { used: 0, limit: 8 },
    }),
    foreignLockReleases: () => 7,
    version: "0.3.0",
    turnLifecycleEnabled: true,
  });
}

const CANNED = async (sql: string): Promise<{ rows: unknown[] }> => {
  if (sql.includes("inbox_pending")) {
    return {
      rows: [{
        inbox_pending: "3",
        inbox_oldest: "12.5",
        outbox_pending: "1",
        outbox_oldest: "2",
      }],
    };
  }
  if (sql.includes("GROUP BY state")) {
    return { rows: [{ state: "letta_processing", active: "2" }, { state: "queued", active: "1" }] };
  }
  return {
    rows: [{
      wait_avg: "18.5",
      wait_max: "120",
      wait_count: "9",
      duration_avg: "2100",
      duration_max: "8000",
      duration_count: "9",
    }],
  };
};

/** Разбор текстовой выдачи Prometheus в пары «строка → значение». */
function parse(body: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const index = line.lastIndexOf(" ");
    assert.ok(index > 0, `строка без значения: ${line}`);
    const value = Number(line.slice(index + 1));
    assert.ok(Number.isFinite(value), `не число: ${line}`);
    values.set(line.slice(0, index), value);
  }
  return values;
}

test("/metrics отдаёт все метрики, перечисленные в задании", async () => {
  const body = await collector(CANNED).render();

  for (const [name, type] of Object.entries(REQUIRED)) {
    assert.ok(body.includes(`# HELP ${name} `), `нет HELP для ${name}`);
    assert.ok(body.includes(`# TYPE ${name} ${type}`), `${name} объявлена не как ${type}`);
  }

  const values = parse(body);
  assert.equal(values.get("eva_inbox_pending"), 3);
  assert.equal(values.get("eva_inbox_oldest_age_seconds"), 12.5);
  assert.equal(values.get("eva_outbox_pending"), 1);
  assert.equal(values.get("eva_turns_active{state=\"letta_processing\"}"), 2);
  assert.equal(values.get("eva_turns_active{state=\"queued\"}"), 1);
  assert.equal(values.get("eva_turns_active{state=\"completed\"}"), 0);
  assert.equal(values.get("eva_turns_active_total"), 3);
  assert.equal(values.get("eva_turn_wait_ms{stat=\"avg\"}"), 18.5);
  assert.equal(values.get("eva_turn_duration_ms{stat=\"max\"}"), 8000);
  assert.equal(values.get("eva_user_locks{state=\"held\"}"), 1);
  assert.equal(values.get("eva_user_locks{state=\"queued\"}"), 4);
  assert.equal(values.get("eva_letta_sessions{state=\"active\"}"), 2);
  assert.equal(values.get("eva_letta_sessions{state=\"idle\"}"), 3);
  assert.equal(values.get("eva_postgres_pool_connections{state=\"total\"}"), 10);
  assert.equal(values.get("eva_postgres_pool_connections{state=\"idle\"}"), 7);
  assert.ok(values.has("eva_event_loop_lag_seconds{quantile=\"0.99\"}"));
  assert.equal(values.get("eva_turn_lifecycle_enabled"), 1);
  assert.equal(values.get("eva_inbox_foreign_lock_releases_total"), 7);
});

test("недоступная база не роняет выдачу: метрики остаются, значения нулевые", async () => {
  const body = await collector(async () => {
    throw new Error("connection refused");
  }).render();

  const values = parse(body);
  for (const [name, type] of Object.entries(REQUIRED)) {
    assert.ok(body.includes(`# TYPE ${name} ${type}`), `метрика ${name} исчезла при сбое базы`);
  }
  assert.equal(values.get("eva_inbox_pending"), 0);
  assert.equal(values.get("eva_turns_active_total"), 0);
  // Данные, которые не зависят от базы, остаются настоящими.
  assert.equal(values.get("eva_user_locks{state=\"queued\"}"), 4);
});

test("в выдаче нет идентификаторов пользователей и conversation", async () => {
  const body = await collector(CANNED).render();
  // Проверяются сами метрики, а не текст HELP: в описании слово
  // «Telegram» уместно, в имени метрики или в метке — уже нет.
  for (const name of parse(body).keys()) {
    assert.doesNotMatch(name, /user_id|telegram_|conversation|run_id|\d{6,}/i);
  }
});

// ---------------------------------------------------------------------
// Доступ
// ---------------------------------------------------------------------

const API_KEY = "test-internal-key-32-characters!!";

function server() {
  return buildServer({
    config: {
      apiKey: API_KEY,
      port: 0,
      host: "127.0.0.1",
      domains: { root: "", app: "", api: "", letta: "", status: "" },
      turnLifecycleEnabled: false,
      healthRateLimitPerIp: 100,
      rateLimitWindowSeconds: 60,
      publicRateLimitPerIp: 100,
      publicRateLimitPerUser: 100,
      webhookRateLimitPerIp: 100,
    } as never,
    logger: logger as never,
    db: withTenantScopes({
      query: async () => ({ rows: [] }),
      poolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
    }) as never,
    letta: { sessionStats: () => ({ active: 0, idle: 0 }) } as never,
    sdk: {} as never,
    llm: {} as never,
    inbox: {} as never,
    profile: {} as never,
    goals: {} as never,
    queue: { activeUsers: 0, queuedUsers: 0 } as never,
    telegram: {} as never,
    redisPing: async () => true,
  });
}

test("/metrics закрыт тем же внутренним ключом, что и /v1", async () => {
  const app = server();
  try {
    const anonymous = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(anonymous.statusCode, 401);

    const authorized = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-api-key": API_KEY },
    });
    assert.equal(authorized.statusCode, 200);
    assert.match(authorized.headers["content-type"] as string, /text\/plain/);
    assert.match(authorized.body, /# TYPE eva_turns_active gauge/);
  } finally {
    await app.close();
  }
});

test("инструменты в /metrics: вызовы, поиск, MCP, браузер и субагенты — без имён и адресов", async () => {
  const { recordToolCall, recordToolSearch, recordMcpDiscovery, recordBrowserOperation, recordDelegation, resetToolMetrics } =
    await import("../dist/tools/tool-metrics.js");
  resetToolMetrics();
  recordToolCall("mcp", "bridge", "ok", 120);
  recordToolCall("product", "direct", "error", 30);
  recordToolSearch("hit");
  recordToolSearch("empty");
  recordMcpDiscovery("ok", 250);
  recordBrowserOperation("open", "blocked", 15);
  recordDelegation("web", "completed", 9_000);
  const text = await new MetricsCollector({
    db: withTenantScopes({ query: async (sql: string) => await CANNED(sql) }) as never,
    sessions: () => ({ active: 0, idle: 0 }),
    locks: () => ({ held: 0, queued: 0 }),
    poolStats: () => ({ total: 1, idle: 1, waiting: 0 }),
    version: "0.3.0",
    turnLifecycleEnabled: true,
    delegation: () => ({ active: 2, queued: 1 }),
  }).render();
  assert.match(text, /eva_tool_calls_total\{source="mcp",path="bridge",outcome="ok"\} 1/);
  assert.match(text, /eva_tool_calls_total\{source="product",path="direct",outcome="error"\} 1/);
  assert.match(text, /eva_tool_call_duration_ms_sum\{source="mcp"\} 120/);
  assert.match(text, /eva_tool_search_total\{outcome="empty"\} 1/);
  assert.match(text, /eva_mcp_discovery_total\{outcome="ok"\} 1/);
  assert.match(text, /eva_browser_operations_total\{operation="open",outcome="blocked"\} 1/);
  assert.match(text, /eva_delegation_runs_total\{role="web",outcome="completed"\} 1/);
  assert.match(text, /eva_delegation_subagents\{state="active"\} 2/);
  assert.doesNotMatch(text, /mcp__|https?:\/\//, "ни имён MCP-инструментов, ни адресов");
  resetToolMetrics();
});

test("база знаний в /metrics: вызовы Qdrant и этапы — по операции, без запросов и документов", async () => {
  const { recordQdrantCall, recordKnowledgeStage, resetKnowledgeMetrics } = await import("../dist/knowledge/metrics.js");
  resetKnowledgeMetrics();
  recordQdrantCall("search", 12, false);
  recordQdrantCall("search", 30, true);
  recordQdrantCall("upsert", 200, false);
  recordKnowledgeStage("embedding", 80, false);
  const text = await collector(CANNED).render();
  assert.match(text, /eva_qdrant_latency_ms_sum\{operation="search"\} 42/);
  assert.match(text, /eva_qdrant_latency_ms_count\{operation="search"\} 2/);
  assert.match(text, /eva_qdrant_latency_ms_max\{operation="upsert"\} 200/);
  assert.match(text, /eva_qdrant_errors_total\{operation="search"\} 1/);
  assert.match(text, /eva_qdrant_errors_total\{operation="upsert"\} 0/);
  assert.match(text, /eva_knowledge_stage_latency_ms_count\{stage="embedding"\} 1/);
  assert.match(text, /eva_knowledge_stage_errors_total\{stage="rerank"\} 0/);
  resetKnowledgeMetrics();
});

test("индекс базы знаний в /metrics: состояния, отставание, точки, прогресс, сверки — числами, без документов", async () => {
  const { recordKnowledgeReconcile, resetKnowledgeMetrics, setKnowledgePoints, setKnowledgeRebuildProgress } = await import("../dist/knowledge/metrics.js");
  resetKnowledgeMetrics();
  setKnowledgePoints("private", 2, 1234);
  setKnowledgePoints("global", 2, 56);
  setKnowledgeRebuildProgress(3, 0.25);
  recordKnowledgeReconcile({ foreign: 1, scheduled: 4, orphans: 2, rebuilds: 0, files: 3 });
  const text = await collector(async (sql) => /GROUP BY index_status/u.test(sql)
    ? { rows: [
      { index_status: "ready", total: "10", lag: "0" },
      { index_status: "pending", total: "2", lag: "125.7" },
      { index_status: "failed", total: "1", lag: "0" },
    ] }
    : await CANNED(sql)).render();
  assert.match(text, /eva_knowledge_documents\{state="ready"\} 10/);
  assert.match(text, /eva_knowledge_documents\{state="pending"\} 2/);
  assert.match(text, /eva_knowledge_documents\{state="indexing"\} 0/);
  assert.match(text, /eva_knowledge_documents\{state="failed"\} 1/);
  assert.match(text, /eva_knowledge_indexing_lag_seconds 126/);
  assert.match(text, /eva_knowledge_points\{scope="private",version="v2"\} 1234/);
  assert.match(text, /eva_knowledge_rebuild_progress\{version="v3"\} 0.25/);
  assert.match(text, /eva_knowledge_reconcile_total\{outcome="runs"\} 1/);
  assert.match(text, /eva_knowledge_reconcile_total\{outcome="orphans"\} 2/);
  assert.match(text, /# TYPE eva_knowledge_reconcile_total counter/);
  resetKnowledgeMetrics();
});
