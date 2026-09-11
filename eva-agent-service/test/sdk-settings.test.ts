import assert from "node:assert/strict";
import { test } from "node:test";

import { EvaError } from "../dist/errors.js";
import { SdkSettingsManager, validateSettings } from "../dist/sdk-settings.js";

test("SDK settings validate all persisted runtime limits", () => {
  const settings = validateSettings({
    agent_name_prefix: "eva-test",
    default_tags: ["evaself", "test", "test"],
    permission_mode: "standard",
    skill_sources: ["bundled", "agent"],
    dreaming: { trigger: "step-count", stepCount: 20 },
    model_settings: { temperature: 0.4 },
    default_context_window: 65536,
    session_pool_size: 10,
    session_idle_ms: 120000,
    turn_timeout_ms: 180000,
    app_server_request_timeout_ms: 90000,
  });

  assert.equal(settings.agent_name_prefix, "eva-test");
  assert.deepEqual(settings.default_tags, ["evaself", "test"]);
  assert.equal(settings.permission_mode, "standard");
  assert.equal(settings.default_context_window, 65536);
});

test("умолчание режима разрешений безопасное", () => {
  // `unrestricted` разрешает любой вызов не спрашивая: подтверждения
  // действий человеком в нём не срабатывают вовсе.
  assert.equal(validateSettings({}).permission_mode, "standard");
});

test("SDK settings reject unsafe enum values and invalid timeouts", () => {
  assert.throws(
    () => validateSettings({ permission_mode: "always-allow" as never }),
    (error: unknown) => error instanceof EvaError && error.code === "bad_request",
  );
  assert.throws(
    () => validateSettings({ turn_timeout_ms: 500 }),
    (error: unknown) => error instanceof EvaError && error.code === "bad_request",
  );
  for (const unsupported of [
    { dreaming: { trigger: "never" } },
    { dreaming: { trigger: "compaction-event", behavior: "always" } },
  ]) {
    assert.throws(
      () => validateSettings(unsupported),
      (error: unknown) => error instanceof EvaError && error.code === "bad_request",
    );
  }
});

test("SDK settings accept the strict permission mode from Agent SDK 0.5.5", () => {
  const settings = validateSettings({ permission_mode: "strict" });
  assert.equal(settings.permission_mode, "strict");
});

test("public SDK settings expose only token presence, never the token", async () => {
  const row = settingsRow();
  const manager = new SdkSettingsManager(
    {
      appServerUrl: "ws://letta-app-server:4500/ws",
      appServerToken: "capability-secret-must-stay-server-side",
    } as never,
    {
      getSdkSettings: async () => row,
    } as never,
    {
      currentPersona: "persona",
    } as never,
  );

  const result = await manager.get();
  const serialized = JSON.stringify(result);
  assert.equal(result.app_server_auth_configured, true);
  assert.equal(result.transport, "websocket");
  assert.ok(!serialized.includes("capability-secret-must-stay-server-side"));
  assert.ok(!serialized.includes("appServerToken"));
});

test("reasoning_effort не сохраняется, если каталог не знает такого уровня", async () => {
  const row = settingsRow();
  let saved = false;
  const manager = new SdkSettingsManager(
    { appServerUrl: "ws://letta-app-server:4500/ws", appServerToken: "" } as never,
    {
      getSdkSettings: async () => row,
      saveSdkSettings: async (input: unknown) => {
        saved = true;
        return input;
      },
    } as never,
    {
      currentPersona: "persona",
      applySdkSettings() {},
      reasoningEffortSupport: async () => ({
        checked: true,
        supported: false,
        model: "lmstudio/eva/chat",
      }),
    } as never,
  );

  await assert.rejects(
    () => manager.update({ reasoning_effort: "medium" }),
    (error: unknown) => error instanceof EvaError && error.code === "bad_request",
  );
  // Настройка, которая остановила бы диалоги, не должна доходить до базы.
  assert.equal(saved, false);
});

test("недоступный каталог моделей не блокирует настройку reasoning_effort", async () => {
  const row = settingsRow();
  const manager = new SdkSettingsManager(
    { appServerUrl: "ws://letta-app-server:4500/ws", appServerToken: "" } as never,
    {
      getSdkSettings: async () => row,
      saveSdkSettings: async (input: Record<string, unknown>) => ({ ...row, ...input }),
    } as never,
    {
      currentPersona: "persona",
      applySdkSettings() {},
      reasoningEffortSupport: async () => ({
        checked: false,
        supported: false,
        model: "lmstudio/eva/chat",
      }),
    } as never,
  );

  // Администратор не должен зависеть от того, поднят ли App Server.
  const result = await manager.update({ reasoning_effort: "medium" });
  assert.equal(result.reasoning_effort, "medium");
});

test("возврат к none не требует каталога моделей", async () => {
  const row = { ...settingsRow(), reasoning_effort: "medium" as const };
  const manager = new SdkSettingsManager(
    { appServerUrl: "ws://letta-app-server:4500/ws", appServerToken: "" } as never,
    {
      getSdkSettings: async () => row,
      saveSdkSettings: async (input: Record<string, unknown>) => ({ ...row, ...input }),
    } as never,
    {
      currentPersona: "persona",
      applySdkSettings() {},
      reasoningEffortSupport: async () => {
        throw new Error("каталог не должен запрашиваться для none");
      },
    } as never,
  );

  // Это же действие чинит диалоги — блокировать его нельзя ничем.
  const result = await manager.update({ reasoning_effort: "none" });
  assert.equal(result.reasoning_effort, "none");
});

/**
 * Рефлексию выключают из панели одним полем.
 *
 * Панель шлёт частичный patch — только `dreaming`. Он обязан сохраниться
 * и доехать до Letta: настройка, которая принята и не применена, ничем
 * не отличается от непринятой. Соседние поля при этом не трогаются:
 * человек менял одно.
 */
test("частичная правка рефлексии сохраняется и доезжает до runtime", async () => {
  const row = { ...settingsRow(), dreaming: { trigger: "compaction-event" } };
  const saved: Array<Record<string, unknown>> = [];
  const applied: Array<Record<string, unknown>> = [];
  const manager = new SdkSettingsManager(
    { appServerUrl: "ws://letta-app-server:4500/ws", appServerToken: "" } as never,
    {
      getSdkSettings: async () => row,
      saveSdkSettings: async (input: Record<string, unknown>) => {
        saved.push(input);
        return { ...row, ...input };
      },
      query: async () => ({ rows: [] }),
    } as never,
    {
      currentPersona: "persona",
      applySdkSettings(settings: Record<string, unknown>) { applied.push(settings); },
    } as never,
  );

  const result = await manager.update({ dreaming: { trigger: "off" } });

  assert.deepEqual(result.dreaming, { trigger: "off" });
  assert.deepEqual(saved.at(-1)?.dreaming, { trigger: "off" });
  assert.deepEqual(applied.at(-1)?.dreaming, { trigger: "off" },
    "настройка сохранена, но до Letta не доехала");
  // Соседние значения остались прежними: правилось одно поле.
  assert.equal(result.turn_timeout_ms, row.turn_timeout_ms);
  assert.equal(result.session_pool_size, row.session_pool_size);
  assert.equal(result.permission_mode, row.permission_mode);
});

/**
 * Окно контекста правится тем же путём. Поле в панели есть давно, но
 * проверки round-trip у него не было: очистка проверялась в браузерном
 * тесте, а сохранение числа — нигде.
 */
test("окно контекста сохраняется и доезжает до runtime", async () => {
  const row = { ...settingsRow(), default_context_window: 64_000 };
  const applied: Array<Record<string, unknown>> = [];
  const manager = new SdkSettingsManager(
    { appServerUrl: "ws://letta-app-server:4500/ws", appServerToken: "" } as never,
    {
      getSdkSettings: async () => row,
      saveSdkSettings: async (input: Record<string, unknown>) => ({ ...row, ...input }),
      query: async () => ({ rows: [] }),
    } as never,
    {
      currentPersona: "persona",
      applySdkSettings(settings: Record<string, unknown>) { applied.push(settings); },
    } as never,
  );

  const result = await manager.update({ default_context_window: 120_000 });

  assert.equal(result.default_context_window, 120_000);
  assert.equal(applied.at(-1)?.default_context_window, 120_000);
});

function settingsRow() {
  const now = new Date("2026-07-28T00:00:00Z");
  return {
    id: 1,
    agent_name_prefix: "eva",
    default_description: "Агент Evaself",
    default_persona: "persona",
    default_human_template: "Имя: {{display_name}}",
    default_tags: ["evaself"],
    permission_mode: "unrestricted" as const,
    memfs_enabled: true,
    system_prompt: null,
    base_tools: null,
    allowed_tools: null,
    disallowed_tools: [],
    skill_sources: ["bundled", "global", "agent", "project"] as const,
    system_info_reminder: false,
    dreaming: { trigger: "off" },
    model_settings: {},
    default_context_window: null,
    conversation_summary: "Новый диалог",
    conversation_description: "",
    conversation_hidden: false,
    create_conversation: true,
    session_pool_size: 25,
    session_idle_ms: 600000,
    turn_timeout_ms: 240000,
    app_server_request_timeout_ms: 180000,
    created_at: now,
    updated_at: now,
  };
}
