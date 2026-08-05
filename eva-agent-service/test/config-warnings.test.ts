/**
 * Предупреждения конфигурации.
 *
 * Флаг, который выглядит включённым и ничего не делает, — худшая
 * ступень rollout: оператор считает, что проверяет новое поведение, а
 * проверяет старое. Здесь закреплено, что сервис об этом говорит.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { configWarnings, loadConfig } from "../dist/config.js";

const base = {
  EVA_AGENT_API_KEY: "x".repeat(32),
  DATABASE_URL: "postgresql://localhost/eva",
};

test("включённая агрегация без параллельного диспетчера не молчит", () => {
  const config = loadConfig({
    ...base,
    EVA_TURN_AGGREGATION: "true",
    EVA_PARALLEL_INBOX: "false",
  });
  const warnings = configWarnings(config);
  assert.ok(
    warnings.some((warning) => warning.includes("EVA_TURN_AGGREGATION")),
    `предупреждения нет: ${JSON.stringify(warnings)}`,
  );
});

test("оба флага включены — предупреждения нет", () => {
  const config = loadConfig({
    ...base,
    EVA_TURN_AGGREGATION: "true",
    EVA_PARALLEL_INBOX: "true",
  });
  assert.ok(!configWarnings(config).some((warning) => warning.includes("EVA_TURN_AGGREGATION")));
});

test("оба флага выключены — предупреждения нет", () => {
  const config = loadConfig(base);
  assert.ok(!configWarnings(config).some((warning) => warning.includes("EVA_TURN_AGGREGATION")));
});

test("срок ожидания остановки укладывается в grace period контейнера", () => {
  // Умолчание Docker — 10 секунд. Срок больше него наступил бы уже
  // после SIGKILL, то есть исправление не работало бы на поставляемой
  // конфигурации.
  assert.ok(
    loadConfig(base).shutdownDrainMs < 10_000,
    "умолчание EVA_SHUTDOWN_DRAIN_MS не укладывается в grace period",
  );
});
