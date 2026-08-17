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
