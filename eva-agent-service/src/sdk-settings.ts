import type { PermissionMode, ReasoningEffort } from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import type { Database, SdkSettingsRow } from "./db.js";
import { badRequest } from "./errors.js";
import type { LettaService, RuntimeSdkSettings } from "./letta.js";

export interface SdkSettingsInput {
  agent_name_prefix?: string;
  default_description?: string;
  default_persona?: string;
  default_human_template?: string;
  default_tags?: string[];
  permission_mode?: PermissionMode;
  reasoning_effort?: ReasoningEffort;
  memfs_enabled?: boolean;
  base_tools?: string[] | null;
  dreaming?: Record<string, unknown>;
  model_settings?: Record<string, unknown>;
  default_context_window?: number | null;
  conversation_summary?: string;
  conversation_description?: string;
  conversation_hidden?: boolean;
  create_conversation?: boolean;
  session_pool_size?: number;
  session_idle_ms?: number;
  turn_timeout_ms?: number;
  app_server_request_timeout_ms?: number;
}

export interface PublicSdkSettings extends SdkSettingsInput {
  app_server_url: string;
  app_server_auth_configured: boolean;
  backend: "remote";
  transport: "websocket";
  updated_at: string;
}

const PERMISSION_MODES = new Set(["standard", "acceptEdits", "unrestricted", "strict"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const DREAMING_TRIGGERS = new Set(["off", "step-count", "compaction-event"]);

export class SdkSettingsManager {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly letta: LettaService,
  ) {}

  async initialize(): Promise<PublicSdkSettings> {
    const row = await this.db.getSdkSettings();
    if (!row.default_persona.trim()) {
      row.default_persona = this.letta.currentPersona;
      await this.db.saveSdkSettings(row);
    }
    await this.letta.applySdkSettings(runtimeFromRow(row));
    return this.public(row);
  }

  async get(): Promise<PublicSdkSettings> {
    return this.public(await this.db.getSdkSettings());
  }

  async update(input: SdkSettingsInput): Promise<PublicSdkSettings> {
    const current = await this.db.getSdkSettings();
    const merged = validateSettings({ ...rowToInput(current), ...input });
    // Выключение reasoning не проверяется никогда: это же действие
    // восстанавливает диалоги, и оно не должно зависеть от App Server.
    if (
      merged.reasoning_effort !== "none" &&
      merged.reasoning_effort !== current.reasoning_effort
    ) {
      await this.assertReasoningEffortSupported(merged.reasoning_effort);
    }
    const saved = await this.db.saveSdkSettings({ ...current, ...merged });
    await this.letta.applySdkSettings(runtimeFromRow(saved));
    return this.public(saved);
  }

  /**
   * Уровень reasoning принимается, только если каталог App Server знает
   * такую запись для активной модели.
   *
   * Проверка живёт здесь, а не в `validateSettings`: чистая валидация
   * вызывается ещё и при чтении уже сохранённой строки, и запрет там ломал
   * бы старт сервиса на установке, где уровень уже выставлен. Недоступный
   * каталог настройку не блокирует — вывода о поддержке в этом случае
   * просто нет.
   */
  private async assertReasoningEffortSupported(effort: ReasoningEffort): Promise<void> {
    const support = await this.letta.reasoningEffortSupport(effort);
    if (!support.checked || support.supported) return;
    throw badRequest(
      `Модель ${support.model} не предлагает уровень reasoning «${effort}». `
        + "App Server применяет уровень при открытии сессии, поэтому такое "
        + "значение остановило бы диалоги. Допустимо «none».",
    );
  }

  private public(row: SdkSettingsRow): PublicSdkSettings {
    return {
      ...rowToInput(row),
      app_server_url: this.config.appServerUrl,
      app_server_auth_configured: Boolean(this.config.appServerToken),
      backend: "remote",
      transport: "websocket",
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export function validateSettings(input: SdkSettingsInput): Required<SdkSettingsInput> {
  const permission = input.permission_mode ?? "unrestricted";
  if (!PERMISSION_MODES.has(permission)) {
    throw badRequest("permission_mode должен быть standard, acceptEdits, unrestricted или strict");
  }
  const reasoningEffort = input.reasoning_effort ?? "none";
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw badRequest("reasoning_effort должен быть none, minimal, low, medium, high или xhigh");
  }
  const dreaming = plainObject(input.dreaming ?? { trigger: "compaction-event" }, "dreaming");
  const trigger = String(dreaming.trigger ?? "compaction-event");
  if (!DREAMING_TRIGGERS.has(trigger)) throw badRequest("Некорректный dreaming.trigger");
  if (dreaming.behavior !== undefined) {
    throw badRequest(
      "dreaming.behavior пока не поддерживается официальным SDK для self-hosted App Server",
    );
  }
  if (dreaming.stepCount !== undefined) integer(dreaming.stepCount, "dreaming.stepCount", 1, 100000);
  return {
    agent_name_prefix: text(input.agent_name_prefix ?? "eva", "agent_name_prefix", 1, 80),
    default_description: text(input.default_description ?? "", "default_description", 0, 1000),
    default_persona: text(input.default_persona ?? "", "default_persona", 0, 100000),
    default_human_template: text(input.default_human_template ?? "", "default_human_template", 0, 10000),
    default_tags: stringArray(input.default_tags ?? [], "default_tags", 64),
    permission_mode: permission,
    reasoning_effort: reasoningEffort,
    memfs_enabled: boolean(input.memfs_enabled, true),
    base_tools: nullableStringArray(input.base_tools, "base_tools", 128),
    dreaming,
    model_settings: plainObject(input.model_settings ?? {}, "model_settings"),
    default_context_window:
      input.default_context_window == null
        ? null
        : integer(input.default_context_window, "default_context_window", 1024, 10_000_000),
    conversation_summary: text(input.conversation_summary ?? "", "conversation_summary", 0, 1000),
    conversation_description: text(
      input.conversation_description ?? "",
      "conversation_description",
      0,
      5000,
    ),
    conversation_hidden: boolean(input.conversation_hidden, false),
    create_conversation: boolean(input.create_conversation, true),
    session_pool_size: integer(input.session_pool_size ?? 25, "session_pool_size", 1, 500),
    session_idle_ms: integer(input.session_idle_ms ?? 600000, "session_idle_ms", 1000, 86400000),
    turn_timeout_ms: integer(input.turn_timeout_ms ?? 240000, "turn_timeout_ms", 1000, 3600000),
    app_server_request_timeout_ms: integer(
      input.app_server_request_timeout_ms ?? 180000,
      "app_server_request_timeout_ms",
      1000,
      3600000,
    ),
  };
}

function runtimeFromRow(row: SdkSettingsRow): RuntimeSdkSettings {
  const settings = validateSettings(rowToInput(row));
  return {
    ...settings,
    permissionMode: settings.permission_mode,
  };
}

function rowToInput(row: SdkSettingsRow): Required<SdkSettingsInput> {
  return {
    agent_name_prefix: row.agent_name_prefix,
    default_description: row.default_description,
    default_persona: row.default_persona,
    default_human_template: row.default_human_template,
    default_tags: row.default_tags,
    permission_mode: row.permission_mode,
    reasoning_effort: row.reasoning_effort,
    memfs_enabled: row.memfs_enabled,
    base_tools: row.base_tools,
    dreaming: row.dreaming,
    model_settings: row.model_settings,
    default_context_window: row.default_context_window,
    conversation_summary: row.conversation_summary,
    conversation_description: row.conversation_description,
    conversation_hidden: row.conversation_hidden,
    create_conversation: row.create_conversation,
    session_pool_size: row.session_pool_size,
    session_idle_ms: row.session_idle_ms,
    turn_timeout_ms: row.turn_timeout_ms,
    app_server_request_timeout_ms: row.app_server_request_timeout_ms,
  };
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw badRequest(`${field} должен быть строкой`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw badRequest(`${field}: допустимая длина ${min}–${max}`);
  }
  return trimmed;
}


function stringArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw badRequest(`${field} должен быть массивом не более ${maxItems} строк`);
  }
  return [...new Set(value.map((item) => text(item, field, 1, 200)))];
}

function nullableStringArray(value: unknown, field: string, maxItems: number): string[] | null {
  if (value == null) return null;
  return stringArray(value, field, maxItems);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${field} должен быть JSON-объектом`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} должен быть целым числом от ${min} до ${max}`);
  }
  return value;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw badRequest("Ожидалось логическое значение");
  return value;
}
