import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReadiness } from "../dist/letta/readiness.js";

const READY = {
  clientTools: ["get_user_time_context", "save_note"],
  tools: [
    "memory", "memory_apply_patch", "Skill", "Task", "TaskOutput",
    "Read", "Grep", "get_user_time_context", "save_note",
  ],
  memoryDirectory: "/data/letta/.memory/agent-1",
  isOnline: true,
  permissionMode: "standard",
  dreaming: { trigger: "compaction-event" },
  skillSources: ["bundled", "project"],
  model: "openai/gpt-4o-mini",
  observedAt: "2026-08-17T18:00:00.000Z",
};

const EXPECTED = {
  productTools: ["get_user_time_context", "save_note"],
  dreamingTrigger: "compaction-event",
  permissionMode: "standard",
  modelCatalogSize: 3,
};

function statusOf(report: { checks: Array<{ name: string; status: string }> }, name: string): string {
  return report.checks.find((entry) => entry.name === name)?.status ?? "missing";
}

test("готовность подтверждается фактами runtime, а не конфигурацией", () => {
  const report = evaluateReadiness(READY, EXPECTED);
  assert.equal(report.ready, true, JSON.stringify(report.checks));
  for (const name of [
    "native_memory", "native_skills", "native_subagents", "product_tools",
    "memfs", "session", "model", "model_catalog", "permission_mode", "dreaming",
  ]) {
    assert.equal(statusOf(report, name), "ok", name);
  }
  assert.equal(report.observedAt, READY.observedAt);
});

test("отсутствие ключевой возможности делает Еву неготовой", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["native_memory", { tools: READY.tools.filter((name) => !name.startsWith("memory")) }],
    ["native_skills", { tools: READY.tools.filter((name) => name !== "Skill") }],
    ["native_subagents", { tools: READY.tools.filter((name) => !name.startsWith("Task")) }],
    ["product_tools", { tools: READY.tools.filter((name) => name !== "save_note"), clientTools: [] }],
    ["memfs", { memoryDirectory: null }],
    ["session", { isOnline: false }],
    ["model", { model: null }],
    ["runtime_facts", { tools: [] }],
  ];
  for (const [failing, patch] of cases) {
    const report = evaluateReadiness({ ...READY, ...patch } as never, EXPECTED);
    assert.equal(report.ready, false, failing);
    assert.equal(statusOf(report, failing), "failed", failing);
  }
});

test("расплывчатого совпадения по имени инструмента недостаточно", () => {
  // `task|agent|subagent` совпадало бы с продуктовыми именами, и
  // проверка субагентов была бы зелёной всегда.
  const report = evaluateReadiness(
    { ...READY, tools: ["memory", "Skill", "update_task", "get_agent_state", "get_user_time_context", "save_note"] },
    EXPECTED,
  );
  assert.equal(report.ready, false);
  assert.equal(statusOf(report, "native_subagents"), "failed");
});

test("несовпадение режима разрешений и рефлексии с настройкой — отказ", () => {
  const permission = evaluateReadiness({ ...READY, permissionMode: "unrestricted" }, EXPECTED);
  assert.equal(permission.ready, false);
  assert.equal(statusOf(permission, "permission_mode"), "failed");

  const dreaming = evaluateReadiness({ ...READY, dreaming: { trigger: "off" } }, EXPECTED);
  assert.equal(dreaming.ready, false);
  assert.equal(statusOf(dreaming, "dreaming"), "failed");
});

test("ненаблюдаемое называется ненаблюдаемым и готовность не отменяет", () => {
  // Установленная версия SDK не приносит в init ни рефлексию, ни
  // источники навыков. Выдавать это за проверенное нельзя, но и
  // объявлять Еву сломанной из-за молчания транспорта — тоже.
  const report = evaluateReadiness(
    { ...READY, dreaming: null, skillSources: null, permissionMode: null },
    { ...EXPECTED, modelCatalogSize: -1 },
  );
  assert.equal(report.ready, true);
  for (const name of ["dreaming", "skill_sources", "permission_mode", "model_catalog"]) {
    assert.equal(statusOf(report, name), "not_reported", name);
  }
});

test("пустые источники навыков — это отказ, а не молчание", () => {
  const report = evaluateReadiness({ ...READY, skillSources: [] }, EXPECTED);
  assert.equal(report.ready, false);
  assert.equal(statusOf(report, "skill_sources"), "failed");
});

test("недоступный App Server — неготовность", () => {
  const report = evaluateReadiness(READY, { ...EXPECTED, modelCatalogSize: null });
  assert.equal(report.ready, false);
  assert.equal(statusOf(report, "model_catalog"), "failed");
});

test("продуктовый инструмент засчитывается и по списку сессии", () => {
  // Клиентские инструменты выполняются в процессе SDK, и серверный
  // список их не всегда называет. Переданные живой сессии — факт.
  const report = evaluateReadiness(
    { ...READY, tools: ["memory", "Skill", "Task"], clientTools: ["get_user_time_context", "save_note"] },
    EXPECTED,
  );
  assert.equal(statusOf(report, "product_tools"), "ok");
  assert.equal(report.ready, true, JSON.stringify(report.checks));
});

/**
 * Свежесть снимка — часть ответа, а не подразумеваемое условие.
 *
 * Факты снимаются при открытии сессии. После перезапуска App Server
 * прежний снимок описывает уже не тот runtime, и выдавать его за
 * доказательство готовности нельзя: «проверено час назад» и «проверено
 * сейчас» — разные ответы.
 */
test("состояние отличает подтверждённую готовность от неподтверждённой", () => {
  const now = new Date("2026-08-17T18:00:30.000Z");

  const fresh = evaluateReadiness(READY, EXPECTED, { now });
  assert.equal(fresh.state, "ready");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.observedAgeSeconds, 30);

  // Ненаблюдаемая возможность готовность не отменяет, но и за
  // подтверждённую не выдаётся.
  const unreported = evaluateReadiness({ ...READY, dreaming: null }, EXPECTED, { now });
  assert.equal(unreported.ready, true);
  assert.equal(unreported.state, "degraded");
  assert.equal(statusOf(unreported, "dreaming"), "not_reported");

  // Старый снимок: отказа нет, но готовность больше не подтверждена.
  const stale = evaluateReadiness(READY, EXPECTED, {
    now: new Date("2026-08-17T18:20:00.000Z"),
  });
  assert.equal(stale.ready, true);
  assert.equal(stale.state, "degraded");
  assert.equal(stale.stale, true);
  assert.equal(statusOf(stale, "facts_fresh"), "not_reported");

  // Фактов нет вовсе — проверять нечего, и это неготовность.
  const never = evaluateReadiness({ ...READY, observedAt: null }, EXPECTED, { now });
  assert.equal(never.ready, false);
  assert.equal(never.state, "not_ready");
  assert.equal(never.observedAgeSeconds, null);
  assert.equal(statusOf(never, "facts_fresh"), "failed");

  // Отказ ключевой возможности сильнее любого «не подтверждено».
  const broken = evaluateReadiness({ ...READY, memoryDirectory: null, dreaming: null }, EXPECTED, { now });
  assert.equal(broken.state, "not_ready");
});
