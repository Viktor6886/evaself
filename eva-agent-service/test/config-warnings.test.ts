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

test("восстановление без жизненного цикла не молчит", () => {
  const config = loadConfig({
    ...base,
    EVA_TURN_RECOVERY: "true",
    EVA_TURN_LIFECYCLE: "false",
  });
  const warnings = configWarnings(config);
  assert.ok(
    warnings.some((warning) => warning.includes("EVA_TURN_RECOVERY")),
    `предупреждения нет: ${JSON.stringify(warnings)}`,
  );
});

test("параллельная доставка без durable outbox не молчит", () => {
  const config = loadConfig({
    ...base,
    EVA_PARALLEL_OUTBOX: "true",
    EVA_OUTBOX_ENABLED: "false",
  });
  assert.ok(
    configWarnings(config).some((warning) => warning.includes("EVA_PARALLEL_OUTBOX")),
  );
});

test("пустой legacy sticker catalog не ломает assets, невалидный виден оператору", () => {
  const emptyWarnings = configWarnings(loadConfig(base));
  assert.equal(emptyWarnings.some((warning) => warning.includes("sticker_unavailable")), false);

  const invalidJson = loadConfig({
    ...base, EVA_TELEGRAM_STICKER_CATALOG_JSON: "{broken",
  });
  assert.equal(invalidJson.telegramStickerCatalogParseError, true);
  assert.ok(configWarnings(invalidJson).some((warning) => warning.includes("невалидный JSON")));

  const invalidEntry = loadConfig({
    ...base, EVA_TELEGRAM_STICKER_CATALOG_JSON: JSON.stringify({ custom: "not-a-file-id" }),
  });
  assert.ok(configWarnings(invalidEntry).some((warning) => warning.includes("custom")));
});

test("восстановление с жизненным циклом предупреждения не даёт", () => {
  const config = loadConfig({
    ...base,
    EVA_TURN_RECOVERY: "true",
    EVA_TURN_LIFECYCLE: "true",
  });
  assert.ok(
    !configWarnings(config).some((warning) => warning.includes("EVA_TURN_RECOVERY")),
    "предупреждение выдано при обоих включённых флагах",
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

test("пороги окончания подписки нормализуются и имеют безопасное умолчание", () => {
  const configured = loadConfig({
    ...base,
    EVA_SUBSCRIPTION_WARNING_DAYS: "1, 3, 3, 45, мусор",
    EVA_QUOTA_EXHAUSTION_NOTIFICATIONS: "false",
  });
  assert.deepEqual(configured.subscriptionExpiryWarningDays, [3, 1]);
  assert.equal(configured.quotaExhaustionNotificationsEnabled, false);

  const fallback = loadConfig({ ...base, EVA_SUBSCRIPTION_WARNING_DAYS: "0, 31" });
  assert.deepEqual(fallback.subscriptionExpiryWarningDays, [3, 1]);
});

test("значения по умолчанию из .env.example не противоречат друг другу", async (context) => {
  // Включённый флаг, который ничего не делает без соседнего, — худшая
  // ступень rollout, и на новой установке её не должно быть с самого
  // начала: `.env.example` — это и есть конфигурация первого запуска.
  const { readFileSync } = await import("node:fs");
  const { access } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const examplePath = join(
    dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.example",
  );
  try {
    await access(examplePath);
  } catch {
    // В образ сервиса копируются только `src` и `test`, файла установки
    // там нет. Проверка выполняется на полном дереве — в job
    // `eva-agent-service (TypeScript)` и локально.
    context.skip("service-only image excludes the repository-level .env.example");
    return;
  }
  const example = readFileSync(examplePath, "utf8");
  const env: Record<string, string> = { ...base };
  for (const line of example.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }
  // Ключи установки в примере пусты; проверяются сочетания флагов, а не
  // заполненность секретов.
  env.EVA_AGENT_API_KEY = base.EVA_AGENT_API_KEY;
  env.DATABASE_URL = base.DATABASE_URL;
  const warnings = configWarnings(loadConfig(env)).filter(
    (warning) => /EVA_[A-Z_]+ включ|включён, а/.test(warning),
  );
  assert.deepEqual(warnings, []);
});

/**
 * Ключ шифрования конфигураций провайдеров и ключ доступа к API — разные
 * назначения. Подстановка второго вместо первого осталась только ради
 * установок, обновившихся с версии без отдельного ключа: там этим
 * значением уже зашифрованы строки. Молча она происходить не должна.
 */
test("подстановка ключа API вместо ключа шифрования названа устаревшей", () => {
  const legacy = loadConfig({ ...base });
  assert.equal(legacy.llmEncryptionKey, base.EVA_AGENT_API_KEY);
  assert.equal(legacy.llmEncryptionKeyIsLegacyFallback, true);
  assert.ok(
    configWarnings(legacy).some((warning) =>
      warning.includes("LLM_CONFIG_ENCRYPTION_KEY") && warning.includes("устаревший")),
    JSON.stringify(configWarnings(legacy)),
  );

  const proper = loadConfig({ ...base, LLM_CONFIG_ENCRYPTION_KEY: "k".repeat(32) });
  assert.equal(proper.llmEncryptionKeyIsLegacyFallback, false);
  assert.ok(
    !configWarnings(proper).some((warning) => warning.includes("LLM_CONFIG_ENCRYPTION_KEY")),
    JSON.stringify(configWarnings(proper)),
  );

  // Ни одного ключа нет вовсе: шифровать нечем, и это ошибка настройки.
  const missing = loadConfig({ DATABASE_URL: base.DATABASE_URL });
  assert.equal(missing.llmEncryptionKey, "");
  assert.ok(
    configWarnings(missing).some((warning) => warning.includes("шифровать нечем")),
    JSON.stringify(configWarnings(missing)),
  );
});
