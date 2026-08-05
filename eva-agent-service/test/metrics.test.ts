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

/** Метрики, перечисленные в задании шага 3. */
const REQUIRED = [
  "eva_inbox_pending",
  "eva_inbox_oldest_age_seconds",
  "eva_outbox_pending",
  "eva_outbox_oldest_age_seconds",
  "eva_turns_active",
  "eva_turns_active_total",
  "eva_turn_wait_ms",
  "eva_turn_duration_ms",
  "eva_user_locks",
  "eva_letta_sessions",
  "eva_postgres_pool_connections",
  "eva_event_loop_lag_seconds",
  "eva_inbox_foreign_lock_releases_total",
];

function collector(query: (sql: string) => Promise<{ rows: unknown[] }>): MetricsCollector {
  return new MetricsCollector({
    db: withTenantScopes({ query: async (sql: string) => await query(sql) }) as never,
    sessions: () => ({ active: 2, idle: 3 }),
    locks: () => ({ held: 1, queued: 4 }),
    poolStats: () => ({ total: 10, idle: 7, waiting: 0 }),
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

  for (const name of REQUIRED) {
    assert.ok(body.includes(`# HELP ${name} `), `нет HELP для ${name}`);
    assert.ok(
      body.includes(`# TYPE ${name} gauge`) || body.includes(`# TYPE ${name} counter`),
      `нет TYPE для ${name}`,
    );
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
  for (const name of REQUIRED) {
    assert.ok(body.includes(`# TYPE ${name} `), `метрика ${name} исчезла при сбое базы`);
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
      domains: { root: "", app: "", api: "", nocodb: "", letta: "", status: "" },
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
    payments: {} as never,
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
