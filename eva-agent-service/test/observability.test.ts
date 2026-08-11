/**
 * Наблюдаемость: приватность экспорта, устойчивость к недоступному
 * Langfuse, ограниченный буфер, непрерывность трассы через очередь и
 * кардинальность метрик.
 *
 * Внешних сервисов нет: `fetch` подменяется, база — таблицами в памяти.
 * Проверяется граница приватности и поведение контура, а не Langfuse.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LangfuseObservability,
  RecordingObservability,
} from "../dist/observability/gateway.js";
import { PrivacyProcessor, allowedTelemetryKeys } from "../dist/observability/privacy.js";
import {
  newCorrelationId,
  parseTraceparent,
  traceHeaders,
} from "../dist/observability/tracing.js";
import { MetricsCollector } from "../dist/metrics.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function privacy(secret = "test-secret"): PrivacyProcessor {
  return new PrivacyProcessor({ pseudonymSecret: secret });
}

// ---------------------------------------------------------------------
// Приватность экспорта
// ---------------------------------------------------------------------

test("снимок экспортируемой телеметрии не содержит запрещённых полей", () => {
  const processor = privacy();
  const { attributes, report } = processor.sanitize({
    // Разрешённое: идентификаторы, числа, флаги.
    model: "gpt-4o-mini",
    tokens_input: 120,
    tokens_output: 40,
    cost_micros: 1500,
    provider_switched: true,
    status: "succeeded",
    // Запрещённое: содержание в любом виде.
    prompt: "мне снова тяжело",
    completion: "я рядом",
    memory_block: "persona",
    diary_entry: "вчера был трудный день",
    tool_arguments: JSON.stringify({ note: "текст" }),
    reasoning: "сначала я подумал",
    user_email: "human@example.com",
    api_key: "sk-123",
  });

  assert.deepEqual(Object.keys(attributes).sort(), [
    "cost_micros",
    "model",
    "provider_switched",
    "status",
    "tokens_input",
    "tokens_output",
  ]);
  for (const forbidden of [
    "prompt", "completion", "memory_block", "diary_entry",
    "tool_arguments", "reasoning", "user_email", "api_key",
  ]) {
    assert.ok(report.droppedKeys.includes(forbidden), `${forbidden} обязано быть отброшено`);
  }
  // Ни одно запрещённое имя не значится разрешённым — список закрытый.
  const allowed = allowedTelemetryKeys();
  for (const forbidden of ["prompt", "text", "message", "content", "reasoning"]) {
    assert.ok(!allowed.includes(forbidden));
  }
});

test("разрешённый ключ с текстом внутри тоже не проходит", () => {
  // Ключ `reason` разрешён — но значением обязан быть код, а не фраза.
  const { attributes, report } = privacy().sanitize({
    reason: "человек написал, что ему тяжело",
    error_code: "provider_timeout",
  });
  assert.deepEqual(attributes, { error_code: "provider_timeout" });
  assert.deepEqual(report.unsafeValues, ["reason"]);
});

test("идентификатор пользователя заменяется псевдонимом, а без секрета исчезает", () => {
  const processor = privacy();
  const first = processor.pseudonym(42);
  const second = processor.pseudonym(42);
  const other = processor.pseudonym(43);

  assert.equal(first, second, "псевдоним стабилен: события одного человека связываются");
  assert.notEqual(first, other);
  assert.doesNotMatch(String(first), /42/);
  assert.equal(first?.length, 16);

  // Другой секрет — другой псевдоним: база псевдонимов не переносится
  // между установками.
  assert.notEqual(new PrivacyProcessor({ pseudonymSecret: "other" }).pseudonym(42), first);
  // Без секрета псевдонима нет вовсе: «стабильный идентификатор без
  // защиты» хуже отсутствия идентификатора.
  assert.equal(new PrivacyProcessor({ pseudonymSecret: "" }).pseudonym(42), null);
});

test("шлюз экспортирует наблюдение уже очищенным", () => {
  const gateway = new RecordingObservability(privacy());
  gateway.observe({
    kind: "generation",
    name: "llm.request",
    userId: 42,
    correlationId: "abc123def456",
    durationMs: 812,
    attributes: { model: "gpt-4o-mini", prompt: "секрет", tokens_total: 160 },
  });
  const record = gateway.records[0]!;
  assert.equal(record.attributes.model, "gpt-4o-mini");
  assert.equal(record.attributes.tokens_total, 160);
  assert.equal(record.attributes.duration_ms, 812);
  assert.equal(record.attributes.correlation_id, "abc123def456");
  assert.ok(!("prompt" in record.attributes));
  assert.ok(!("user_id" in record.attributes));
  assert.doesNotMatch(JSON.stringify(record), /42|секрет/);
});

// ---------------------------------------------------------------------
// Устойчивость экспортёра
// ---------------------------------------------------------------------

test("недоступность Langfuse не ломает вызывающего и не растит буфер", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  try {
    const gateway = new LangfuseObservability(
      { baseUrl: "http://langfuse.invalid", publicKey: "pk", secretKey: "sk", bufferLimit: 10 },
      privacy(),
      logger as never,
    );

    // Наблюдение не бросает: путь пользователя от телеметрии не зависит.
    for (let index = 0; index < 50; index += 1) {
      gateway.observe({ kind: "job", name: "maintenance", attributes: { count: index } });
    }
    // Сброс тоже не бросает, хотя сеть лежит.
    await gateway.flush();

    assert.ok(calls > 0, "попытка отправки была");
    assert.ok(gateway.bufferedEvents <= 10, "буфер не растёт сверх предела");
    assert.ok(gateway.droppedEvents >= 40, "лишнее отброшено, а не накоплено");
    await gateway.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("успешная отправка очищает буфер и уносит только метаданные", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  try {
    const gateway = new LangfuseObservability(
      { baseUrl: "http://langfuse.test", publicKey: "pk", secretKey: "sk" },
      privacy(),
      logger as never,
    );
    gateway.observe({
      kind: "generation",
      name: "llm.request",
      userId: 7,
      attributes: { model: "sonnet", tokens_total: 10, prompt: "текст пользователя" },
    });
    await gateway.flush();

    assert.equal(gateway.bufferedEvents, 0);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0]!, /"model":"sonnet"/);
    assert.doesNotMatch(bodies[0]!, /текст пользователя|"prompt"/);
    await gateway.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------
// Непрерывность трассы
// ---------------------------------------------------------------------

test("traceparent разбирается, а мусор не выдаётся за трассу", () => {
  const parsed = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  assert.equal(parsed?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(parsed?.spanId, "00f067aa0ba902b7");
  assert.equal(parsed?.sampled, true);

  for (const broken of [
    null,
    "",
    "не трасса",
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
  ]) {
    assert.equal(parseTraceparent(broken), null, String(broken));
  }
});

test("трасса продолжается через очередь: конверт несёт correlation id", async () => {
  const { buildJobEnvelope } = await import("../dist/jobs/envelope.js");
  const correlationId = newCorrelationId();
  assert.match(correlationId, /^[0-9a-f]{32}$/);

  const envelope = buildJobEnvelope({
    type: "memory_compaction",
    queue: "memory",
    idempotencyKey: "job-1",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    correlationId,
    causationId: "turn-1",
    userId: 42,
    deadlineMs: 60_000,
  } as never);

  // Идентификаторы переживают запись в PostgreSQL и публикацию: они в
  // конверте, а не в стеке вызовов.
  assert.equal(envelope.correlationId, correlationId);
  assert.equal(envelope.causationId, "turn-1");
  const restored = JSON.parse(JSON.stringify(envelope)) as { correlationId: string };
  assert.equal(restored.correlationId, correlationId);

  // Наружу те же идентификаторы уходят заголовками W3C.
  const headers = traceHeaders({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: null,
    correlationId,
  });
  assert.equal(headers["x-correlation-id"], correlationId);
  assert.match(headers.traceparent!, /^00-4bf92f/);
});

// ---------------------------------------------------------------------
// Кардинальность метрик
// ---------------------------------------------------------------------

test("аудит кардинальности: в метках нет значений, растущих с числом людей", async () => {
  const db = withTenantScopes({
    query: async () => ({ rows: [] }),
  } as never) as never;
  const collector = new MetricsCollector({
    db,
    sessions: () => ({ active: 1, idle: 2 }),
    locks: () => ({ held: 1, queued: 0 }),
    poolStats: () => ({ total: 5, idle: 4, waiting: 0 }),
    version: "test",
    turnLifecycleEnabled: true,
    telemetryBuffer: () => ({ buffered: 3, dropped: 1 }),
    retentionPolicies: () => ({ app_logs: 604800 }),
  } as never);

  const body = await collector.render();
  collector.stop();

  // Метки — только из закрытых словарей: состояние, класс, статистика,
  // модель. Идентификаторов и длинных значений быть не должно.
  const pairs = [...body.matchAll(/\{([^}]*)\}/g)].flatMap((match) =>
    match[1]!.split(",").map((pair) => pair.split("=")),
  );
  const allowedLabels = new Set([
    "version", "state", "class", "stat", "kind", "quantile", "mode", "model",
  ]);
  for (const [name, value] of pairs) {
    assert.ok(allowedLabels.has(name!.trim()), `метка ${name} не входит в разрешённый словарь`);
    // Значение метки — из закрытого словаря состояний, а не из данных:
    // длинное или числовое значение означает, что в метку попал
    // идентификатор, и число временных рядов растёт с числом людей.
    assert.match(
      String(value ?? "").replaceAll('"', ""),
      /^[a-z0-9_.-]{1,32}$/i,
      `значение метки ${name} выглядит как данные`,
    );
    assert.doesNotMatch(String(value), /^"?\d{4,}/, `в метке ${name} число, похожее на идентификатор`);
  }
  // Имена метрик не называют ни пользователя, ни conversation.
  const names = [...body.matchAll(/^# TYPE (\S+) /gm)].map((match) => match[1]!);
  for (const name of names) {
    assert.doesNotMatch(name, /user_id|telegram_|conversation|run_id/i, name);
  }

  // Новые семейства шага 09 присутствуют: пропавшая метрика читается как
  // поломка сбора, а не как выключенная возможность.
  for (const name of [
    "eva_jobs_outbox_pending",
    "eva_jobs_stuck",
    "eva_jobs_dead_letters",
    "eva_provider_breaker_state",
    "eva_delivery_latency_ms",
    "eva_telemetry_buffer",
    "eva_retention_policy_seconds",
    "eva_process_memory_bytes",
  ]) {
    assert.match(body, new RegExp(`^# TYPE ${name} `, "m"), name);
  }
});
