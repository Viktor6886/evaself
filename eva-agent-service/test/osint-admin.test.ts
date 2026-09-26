/**
 * OSINT в панели и в тарифе.
 *
 * Переключатели панели действуют без перезапуска и возвращают значение
 * окружения, когда настройку удаляют; выключенный контур закрывает уже
 * поставленное задание, а не выполняет его; метрика `osint` есть в
 * тарифах.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyManagedRuntimeConfig } from "../dist/admin/managed-runtime-config.js";
import { OSINT_SETTINGS, SETTINGS_REGISTRY, ALL_SETTINGS } from "../dist/admin/settings-registry.js";
import { METRICS } from "../dist/admin/tariff-service.js";
import { OsintJobWorker, osintCollectorEnabled } from "../dist/osint/job.js";
import { OSINT_QUOTA_METRIC } from "../dist/osint/service.js";

const FLAGS = {
  osintEnabled: false,
  osintRuRegistriesEnabled: false,
  osintDailyLimit: 3,
  osintCollectorMaigret: true,
  osintCollectorWeb: true,
  osintCollectorInfrastructure: true,
  osintCollectorHarvester: true,
  osintCollectorSpiderfoot: true,
};

test("настройки OSINT — отдельная группа, без перезапуска, в общем применении runtime.*", () => {
  const keys = OSINT_SETTINGS.map((item) => item.key);
  for (const key of [
    "runtime.osint_enabled", "runtime.osint_ru_registries", "runtime.osint_daily_limit",
    "runtime.osint_collector_maigret", "runtime.osint_collector_web", "runtime.osint_collector_infrastructure",
    "runtime.osint_collector_theharvester", "runtime.osint_collector_spiderfoot",
  ]) assert.ok(keys.includes(key), key);
  assert.ok(OSINT_SETTINGS.every((item) => item.group === "osint" && item.requires_restart === false));
  // Отдельный блок: основной список не растёт, панель получает всё.
  assert.ok(OSINT_SETTINGS.every((item) => !SETTINGS_REGISTRY.includes(item) && ALL_SETTINGS.includes(item)));
  const enabled = OSINT_SETTINGS.find((item) => item.key === "runtime.osint_enabled")!;
  assert.equal(enabled.default, false, "контур выключен по умолчанию");
});

test("панель переключает OSINT на лету и возвращает значение окружения при удалении", async () => {
  const config = { ...FLAGS } as Record<string, unknown>;
  let rows: Array<{ key: string; value_json: unknown }> = [
    { key: "runtime.osint_enabled", value_json: true },
    { key: "runtime.osint_collector_spiderfoot", value_json: false },
    { key: "runtime.osint_daily_limit", value_json: 7 },
  ];
  const db = { query: async () => ({ rows }) };
  const changed = await applyManagedRuntimeConfig(config as never, db as never);
  assert.equal(config.osintEnabled, true);
  assert.equal(config.osintCollectorSpiderfoot, false);
  assert.equal(config.osintDailyLimit, 7);
  assert.ok(changed.includes("runtime.osint_enabled"));
  rows = [];
  await applyManagedRuntimeConfig(config as never, db as never);
  assert.equal(config.osintEnabled, false, "без строки — значение окружения");
  assert.equal(config.osintCollectorSpiderfoot, true);
  assert.equal(config.osintDailyLimit, 3);
});

test("флаги источников соответствуют именам сборщиков", () => {
  const flags = { ...FLAGS, osintCollectorWeb: false, osintRuRegistriesEnabled: true };
  assert.equal(osintCollectorEnabled(flags, "web_search"), false);
  assert.equal(osintCollectorEnabled(flags, "egrul"), true);
  assert.equal(osintCollectorEnabled({ ...flags, osintRuRegistriesEnabled: false }, "egrul"), false);
  for (const name of ["maigret", "infrastructure", "theharvester", "spiderfoot"]) {
    assert.equal(osintCollectorEnabled(flags, name), true, name);
    assert.equal(osintCollectorEnabled({
      ...flags, osintCollectorMaigret: false, osintCollectorInfrastructure: false,
      osintCollectorHarvester: false, osintCollectorSpiderfoot: false,
    }, name), false, name);
  }
  assert.equal(osintCollectorEnabled(flags, "future"), true, "новый сборщик не пропадает молча");
});

test("выключенный контур закрывает поставленное задание, а не выполняет его", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => { statements.push({ sql, values }); return { rows: [], rowCount: 1 }; },
    withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work(),
  };
  let collected = false;
  const collector = { name: "web_search", accepts: () => true, reserve: () => 1, collect: async () => { collected = true; return {}; } };
  const worker = new OsintJobWorker(db as never, [collector as never], { enabled: () => false, collectorEnabled: () => true });
  await worker.run({
    envelope: { payloadRef: "11111111-2222-4333-8444-555555555555", userId: 7 },
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    attempt: 1,
    timing: { maxAttempts: 2 },
  } as never);
  assert.equal(collected, false);
  const closing = statements.find((item) => item.sql.includes("UPDATE osint_investigations"));
  assert.ok(closing && closing.values.includes("cancelled") && closing.values.includes("osint_disabled"));
});

test("метрика osint есть в тарифах панели", () => {
  assert.equal(OSINT_QUOTA_METRIC, "osint");
  assert.ok(METRICS.some((item) => item.metric === "osint"));
});
