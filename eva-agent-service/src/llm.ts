import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn as spawnPty } from "node-pty";

import type { Config } from "./config.js";
import type { Database, LlmProviderRow, ModelMapping } from "./db.js";
import { EvaError, badRequest, notFound } from "./errors.js";
import type { LettaService } from "./letta.js";
import type { Logger } from "./logger.js";

export interface LlmProviderInput {
  name: string;
  protocol?: "openai-compatible";
  base_url: string;
  api_key?: string;
  model: string;
  context_window: number;
  additional_parameters?: Record<string, unknown>;
}

export interface PublicLlmProvider {
  id: string;
  name: string;
  protocol: "openai-compatible";
  base_url: string;
  model: string;
  model_handle: string;
  context_window: number;
  additional_parameters: Record<string, unknown>;
  is_active: boolean;
  api_key_configured: true;
  last_checked_at: string | null;
  last_check_ok: boolean | null;
  last_check_message: string | null;
  last_models: unknown[] | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderProbe {
  ok: boolean;
  models_supported: boolean;
  models: Array<{ id: string; [key: string]: unknown }>;
  message: string;
  status_code: number | null;
}

/**
 * Версионированное AES-256-GCM шифрование ключей. В PostgreSQL хранятся
 * случайный IV, auth tag и ciphertext; исходный API key туда не попадает.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    if (masterKey.length < 32) {
      throw new Error("LLM_CONFIG_ENCRYPTION_KEY должен содержать не менее 32 символов");
    }
    this.key = createHash("sha256").update(masterKey, "utf8").digest();
  }

  encrypt(plaintext: string): string {
    if (!plaintext) throw new Error("API key не может быть пустым");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
  }

  decrypt(payload: string): string {
    const [version, ivRaw, tagRaw, encryptedRaw, extra] = payload.split(":");
    if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw || extra !== undefined) {
      throw new Error("неподдерживаемый формат зашифрованного API key");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivRaw, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function modelHandle(model: string): string {
  const trimmed = model.trim();
  return trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
}

export async function probeOpenAiProvider(
  input: { baseUrl: string; apiKey: string; timeoutMs: number },
  fetcher: typeof fetch = fetch,
): Promise<ProviderProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const modelsUrl = `${input.baseUrl.replace(/\/+$/, "")}/models`;

  try {
    const response = await fetcher(modelsUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      signal: controller.signal,
    });

    if ([404, 405, 501].includes(response.status)) {
      return {
        ok: true,
        models_supported: false,
        models: [],
        message: "Провайдер доступен, но endpoint /models не поддерживается; модель укажите вручную.",
        status_code: response.status,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        models_supported: true,
        models: [],
        message: `Проверка /models завершилась HTTP ${response.status}.`,
        status_code: response.status,
      };
    }

    const raw = await response.json() as { data?: unknown[] };
    const models = Array.isArray(raw.data)
      ? raw.data.flatMap((item) => {
          if (typeof item === "string") return [{ id: item }];
          if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
            return [item as { id: string; [key: string]: unknown }];
          }
          return [];
        })
      : [];

    return {
      ok: true,
      models_supported: true,
      models,
      message: `Подключение работает; получено моделей: ${models.length}.`,
      status_code: response.status,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `Провайдер не ответил за ${input.timeoutMs} мс.`
      : `Не удалось подключиться: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      models_supported: true,
      models: [],
      message,
      status_code: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface LlmManagerOverrides {
  configureProvider?: (provider: LlmProviderRow, apiKey: string) => Promise<void>;
  restartAppServer?: () => Promise<void>;
  probeProvider?: (provider: LlmProviderRow, apiKey: string) => Promise<ProviderProbe>;
}

export class LlmManager {
  private readonly secretBox: SecretBox;
  private readonly configureProvider: (provider: LlmProviderRow, apiKey: string) => Promise<void>;
  private readonly restartAppServer: () => Promise<void>;
  private readonly probeProvider: (provider: LlmProviderRow, apiKey: string) => Promise<ProviderProbe>;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly logger: Logger,
    overrides: LlmManagerOverrides = {},
  ) {
    this.secretBox = new SecretBox(config.llmEncryptionKey);
    this.configureProvider = overrides.configureProvider
      ?? ((provider, apiKey) => this.configureLettaProvider(provider, apiKey));
    this.restartAppServer = overrides.restartAppServer
      ?? (() => this.requestAppServerRestart());
    this.probeProvider = overrides.probeProvider
      ?? ((provider, apiKey) => probeOpenAiProvider({
        baseUrl: provider.base_url,
        apiKey,
        timeoutMs: this.config.llmProbeTimeoutMs,
      }));
  }

  async initializeDefaultModel(): Promise<void> {
    const active = await this.db.getActiveLlmProvider();
    if (active) this.letta.setDefaultModel(modelHandle(active.model));
  }

  async list(): Promise<PublicLlmProvider[]> {
    return (await this.db.listLlmProviders()).map(publicProvider);
  }

  async get(id: string): Promise<LlmProviderRow> {
    const provider = await this.db.getLlmProvider(id);
    if (!provider) throw notFound(`LLM-конфигурация ${id} не найдена`);
    return provider;
  }

  async create(raw: LlmProviderInput): Promise<PublicLlmProvider> {
    const input = validateInput(raw, true);
    const row = await this.db.createLlmProvider({
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.base_url,
      model: input.model,
      contextWindow: input.context_window,
      additionalParameters: input.additional_parameters,
      apiKeyEncrypted: this.secretBox.encrypt(input.api_key),
    });
    return publicProvider(row);
  }

  async update(id: string, raw: Partial<LlmProviderInput>): Promise<PublicLlmProvider> {
    const old = await this.get(id);
    const merged = validateInput({
      name: raw.name ?? old.name,
      protocol: raw.protocol ?? old.protocol,
      base_url: raw.base_url ?? old.base_url,
      api_key: raw.api_key,
      model: raw.model ?? old.model,
      context_window: raw.context_window ?? old.context_window,
      additional_parameters: raw.additional_parameters ?? old.additional_parameters,
    }, false);
    const encrypted = merged.api_key
      ? this.secretBox.encrypt(merged.api_key)
      : old.api_key_encrypted;

    const updated = await this.db.updateLlmProvider({
      id,
      name: merged.name,
      protocol: merged.protocol,
      baseUrl: merged.base_url,
      model: merged.model,
      contextWindow: merged.context_window,
      additionalParameters: merged.additional_parameters,
      apiKeyEncrypted: encrypted,
    });
    if (!updated) throw notFound(`LLM-конфигурация ${id} не найдена`);

    if (!old.is_active) return publicProvider(updated);

    try {
      return await this.activateRow(updated, old);
    } catch (error) {
      await this.db.updateLlmProvider({
        id: old.id,
        name: old.name,
        protocol: old.protocol,
        baseUrl: old.base_url,
        model: old.model,
        contextWindow: old.context_window,
        additionalParameters: old.additional_parameters,
        apiKeyEncrypted: old.api_key_encrypted,
      });
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const provider = await this.get(id);
    if (provider.is_active) throw badRequest("Активную LLM-конфигурацию удалить нельзя");
    if (!await this.db.deleteInactiveLlmProvider(id)) {
      throw notFound(`LLM-конфигурация ${id} не найдена`);
    }
  }

  async test(id: string): Promise<ProviderProbe> {
    const provider = await this.get(id);
    const result = await this.probe(provider);
    await this.db.recordLlmCheck(id, {
      ok: result.ok,
      message: result.message,
      models: result.models_supported ? result.models : null,
    });
    return result;
  }

  async models(id: string): Promise<ProviderProbe> {
    return this.test(id);
  }

  async activate(id: string): Promise<PublicLlmProvider> {
    return this.activateRow(await this.get(id));
  }

  async importEnvironment(): Promise<PublicLlmProvider> {
    if (await this.db.countLlmProviders() > 0) {
      throw badRequest("LLM-конфигурации уже существуют; импорт из .env разрешён только для первой настройки");
    }
    const input: LlmProviderInput = {
      name: process.env.EVA_LLM_PROVIDER_NAME ?? "Основной провайдер",
      protocol: "openai-compatible",
      base_url: process.env.EVA_LLM_BASE_URL ?? "",
      api_key: process.env.EVA_LLM_API_KEY ?? "",
      model: process.env.EVA_LLM_MODEL ?? "",
      context_window: Number.parseInt(process.env.EVA_LLM_CONTEXT_WINDOW ?? "", 10),
      additional_parameters: parseJsonObject(process.env.EVA_LLM_ADDITIONAL_PARAMETERS ?? "{}"),
    };
    const created = await this.create(input);
    return this.activate(created.id);
  }

  private async activateRow(
    candidate: LlmProviderRow,
    rollbackOverride?: LlmProviderRow,
  ): Promise<PublicLlmProvider> {
    const check = await this.probe(candidate);
    await this.db.recordLlmCheck(candidate.id, {
      ok: check.ok,
      message: check.message,
      models: check.models_supported ? check.models : null,
    });
    if (!check.ok) throw badRequest(`Конфигурация не прошла проверку: ${check.message}`);

    const previous = rollbackOverride ?? await this.db.getActiveLlmProvider();
    const mappings = await this.db.listModelMappings();
    const candidateKey = this.secretBox.decrypt(candidate.api_key_encrypted);
    const candidateHandle = modelHandle(candidate.model);

    this.letta.closeAllSessions();
    try {
      await this.configureProvider(candidate, candidateKey);
      await this.restartAppServer();
      await this.letta.applyModelToMappings(
        mappings,
        candidateHandle,
        candidate.context_window,
        modelSettings(candidate.additional_parameters),
      );
      await this.db.setAgentModels(candidateHandle);
      const active = await this.db.activateLlmProvider(candidate.id);
      if (!active) throw new Error("конфигурация исчезла во время переключения");
      this.letta.setDefaultModel(candidateHandle);
      this.logger.info("LLM-конфигурация активирована", {
        providerId: candidate.id,
        model: candidateHandle,
        agents: mappings.length,
      });
      return publicProvider(active);
    } catch (error) {
      this.logger.error("Активация LLM не удалась; восстанавливается предыдущая конфигурация", {
        providerId: candidate.id,
        message: error instanceof Error ? error.message : String(error),
      });
      if (previous) {
        await this.rollback(previous, mappings);
      }
      throw new EvaError(
        `Не удалось переключить LLM; предыдущая конфигурация сохранена: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { code: "llm_switch_failed", statusCode: 502 },
      );
    }
  }

  private async rollback(previous: LlmProviderRow, mappings: ModelMapping[]): Promise<void> {
    try {
      await this.configureProvider(previous, this.secretBox.decrypt(previous.api_key_encrypted));
      await this.restartAppServer();
      const handle = modelHandle(previous.model);
      await this.letta.applyModelToMappings(
        mappings,
        handle,
        previous.context_window,
        modelSettings(previous.additional_parameters),
      );
      await this.db.setAgentModels(handle);
      await this.db.activateLlmProvider(previous.id);
      this.letta.setDefaultModel(handle);
    } catch (rollbackError) {
      this.logger.error("Rollback LLM не удался", {
        providerId: previous.id,
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
  }

  private async probe(provider: LlmProviderRow): Promise<ProviderProbe> {
    return this.probeProvider(provider, this.secretBox.decrypt(provider.api_key_encrypted));
  }

  private async configureLettaProvider(provider: LlmProviderRow, apiKey: string): Promise<void> {
    const timeout = numericParameter(provider.additional_parameters, "request_timeout_ms", 180_000);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    environment.LETTA_LOCAL_BACKEND_DIR = this.config.llmProviderConfigDir;

    await new Promise<void>((resolve, reject) => {
      const terminal = spawnPty(
        this.config.lettaCliPath,
        [
        "--backend",
        "local",
        "connect",
        "openai",
        "--base-url",
        provider.base_url,
        "--timeout",
        `${timeout}ms`,
        ],
        {
          name: "xterm-color",
          cols: 120,
          rows: 30,
          cwd: "/app",
          env: environment,
        },
      );
      let promptBuffer = "";
      let keySent = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminal.kill();
        reject(new Error("Letta CLI не завершил настройку провайдера вовремя"));
      }, Math.max(timeout, 30_000));

      terminal.onData((data) => {
        // Letta CLI скрывает ввод через readline. Отправляем ключ только
        // после появления secret prompt; stdout не сохраняется и не логируется.
        promptBuffer = `${promptBuffer}${data}`.slice(-1024);
        if (!keySent && /API key:/i.test(promptBuffer)) {
          keySent = true;
          terminal.write(`${apiKey}\r`);
        }
      });
      terminal.onExit(({ exitCode }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitCode === 0 && keySent) resolve();
        else reject(new Error(`Letta CLI не сохранил провайдера (код ${exitCode})`));
      });
    });
  }

  private async requestAppServerRestart(): Promise<void> {
    await mkdir(dirname(this.config.llmControlFile), { recursive: true });
    await writeFile(this.config.llmControlFile, `${Date.now()}-${randomUUID()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    // Watcher в App Server замечает marker раз в секунду. После этого ждём
    // именно protocol health через Agent SDK, а не только открытый TCP-порт.
    await delay(1_500);
    let lastError = "App Server не ответил";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      this.letta.resetClient();
      const health = await this.letta.ping();
      if (health.ok) return;
      lastError = health.error;
      await delay(1_000);
    }
    throw new Error(`App Server не восстановился после переконфигурации: ${lastError}`);
  }
}

function validateInput(raw: LlmProviderInput, requireKey: boolean) {
  const name = String(raw.name ?? "").trim();
  const protocol = raw.protocol ?? "openai-compatible";
  const baseUrl = String(raw.base_url ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(raw.api_key ?? "");
  const model = String(raw.model ?? "").trim();
  const contextWindow = Number(raw.context_window);
  const additional = raw.additional_parameters ?? {};

  if (!name) throw badRequest("Название конфигурации обязательно");
  if (protocol !== "openai-compatible") throw badRequest("Поддерживается только protocol=openai-compatible");
  if (!/^https?:\/\//i.test(baseUrl)) throw badRequest("Base URL должен начинаться с http:// или https://");
  if (requireKey && !apiKey) throw badRequest("API Key обязателен");
  if (!model) throw badRequest("Название модели обязательно");
  if (!Number.isInteger(contextWindow) || contextWindow < 1024) {
    throw badRequest("Context window должен быть целым числом не меньше 1024");
  }
  if (!additional || Array.isArray(additional) || typeof additional !== "object") {
    throw badRequest("additional_parameters должен быть JSON-объектом");
  }

  return {
    name,
    protocol,
    base_url: baseUrl,
    api_key: apiKey,
    model,
    context_window: contextWindow,
    additional_parameters: additional,
  } as const;
}

function publicProvider(row: LlmProviderRow): PublicLlmProvider {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    base_url: row.base_url,
    model: row.model,
    model_handle: modelHandle(row.model),
    context_window: row.context_window,
    additional_parameters: row.additional_parameters,
    is_active: row.is_active,
    api_key_configured: true,
    last_checked_at: row.last_checked_at?.toISOString() ?? null,
    last_check_ok: row.last_check_ok,
    last_check_message: row.last_check_message,
    last_models: row.last_models,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function modelSettings(parameters: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = parameters.model_settings;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numericParameter(
  parameters: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = Number(parameters[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw badRequest("EVA_LLM_ADDITIONAL_PARAMETERS содержит некорректный JSON");
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
