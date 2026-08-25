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
import {
  probeModelCapabilities,
  probeVisionCapability,
  summarize,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type ProbeStatus,
} from "./llm/capability-probe.js";

export interface LlmProviderInput {
  name: string;
  protocol?: "openai-compatible" | "openai-responses" | "gemini-compatible" | "anthropic-compatible";
  base_url: string;
  api_key?: string;
  model: string;
  context_window: number;
  additional_parameters?: Record<string, unknown>;
}

export interface PublicLlmProvider {
  id: string;
  name: string;
  protocol: NonNullable<LlmProviderInput["protocol"]>;
  base_url: string;
  model: string;
  model_handle: string;
  context_window: number;
  additional_parameters: Record<string, unknown>;
  is_active: boolean;
  api_key_configured: true;
  last_checked_at: string | null;
  last_check_ok: boolean | null;
  /**
   * Состояние последней пробы. Панель показывает по нему четыре разных
   * положения вместо «прошёл / не прошёл»; `null` — проверки этой версией
   * ещё не было.
   */
  last_check_status: string | null;
  last_check_message: string | null;
  last_models: unknown[] | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderProbe {
  ok: boolean;
  /**
   * Состояние проверки. `ok` оставлен для прежних потребителей и означает
   * «модель пригодна»: и полностью, и с ограничениями.
   */
  status?: ProbeStatus;
  models_supported: boolean;
  models: Array<{ id: string; [key: string]: unknown }>;
  message: string;
  status_code: number | null;
  /**
   * Что модель умеет на самом деле. Отсутствует, когда до проверки
   * возможностей дело не дошло: провайдер не ответил вовсе.
   */
  capabilities?: CapabilityProbeResult;
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

/**
 * Имя модели, которое видит Letta. Это код маршрута роутера, а не модель
 * провайдера: конкретную модель выбирает роутер, и она может смениться
 * посреди дня без ведома App Server.
 */
export const ROUTER_ROUTE_HANDLE = "lmstudio/eva/chat";

export function modelHandle(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("lmstudio/") ? trimmed : `lmstudio/${trimmed}`;
}

/** Provider catalog is only a hint; the image probe remains authoritative. */
export function catalogVisionHint(
  models: Array<{ id: string; [key: string]: unknown }>,
  model: string,
): boolean | null {
  const entry = models.find((candidate) => candidate.id === model);
  if (!entry) return null;
  const architecture = entry.architecture;
  if (!architecture || typeof architecture !== "object") return null;
  const modalities = (architecture as { input_modalities?: unknown }).input_modalities;
  if (!Array.isArray(modalities)) return null;
  return modalities.some((value) => typeof value === "string" && value.toLowerCase() === "image");
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
  probeCapabilities?: (provider: LlmProviderRow, apiKey: string) => Promise<CapabilityProbeResult>;
  probeVision?: (provider: LlmProviderRow, apiKey: string) => Promise<CapabilityProbeResult["checks"][number]>;
}

export class LlmManager {
  private readonly secretBox: SecretBox;
  private readonly configureProvider: (provider: LlmProviderRow, apiKey: string) => Promise<void>;
  private readonly restartAppServer: () => Promise<void>;
  private readonly probeProvider: (provider: LlmProviderRow, apiKey: string) => Promise<ProviderProbe>;
  private readonly probeCapabilities: (
    provider: LlmProviderRow,
    apiKey: string,
  ) => Promise<CapabilityProbeResult>;
  private readonly probeVision: NonNullable<LlmManagerOverrides["probeVision"]>;

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
      ?? ((provider, apiKey) => provider.protocol === "openai-compatible"
        || provider.protocol === "openai-responses"
        ? probeOpenAiProvider({ baseUrl: provider.base_url, apiKey, timeoutMs: this.config.llmProbeTimeoutMs })
        : Promise.resolve({
            ok: true, models_supported: false, models: [],
            message: "Доступность native protocol проверяется фактическим model probe.", status_code: null,
          }));
    this.probeCapabilities = overrides.probeCapabilities
      ?? ((provider, apiKey) => probeModelCapabilities(capabilityInput(provider, apiKey, this.config)));
    this.probeVision = overrides.probeVision
      ?? ((provider, apiKey) => probeVisionCapability(capabilityInput(provider, apiKey, this.config)));
  }

  /**
   * Модель по умолчанию для новых агентов — всегда роутер.
   *
   * Раньше она ставилась только при наличии активного провайдера, иначе
   * оставалось значение EVA_LLM_MODEL из окружения — сырое имя модели
   * вроде "mimo-v2.5-pro". App Server такого имени у провайдера lmstudio
   * не знает, и каждый новый агент падал с «Unknown model … for provider
   * lmstudio». Причём чинилось это только повторной активацией: сама по
   * себе установка из этого состояния не выходила.
   *
   * Роутер — единственный адрес, который App Server знает всегда, а какой
   * провайдер за ним стоит, решает цепочка маршрута. Поэтому указатель
   * ставится безусловно: тогда и работающие агенты (их переводит
   * активация), и вновь создаваемые ходят через одну и ту же точку и
   * получают выбранного провайдера без всякой перенастройки.
   */
  async initializeDefaultModel(): Promise<void> {
    this.letta.setDefaultModel(ROUTER_ROUTE_HANDLE);
    // Existing installations may have a vision-capable provider saved with
    // the old default `supports_vision=false`. Discover it before the first
    // session: otherwise Letta treats eva/chat as text-only and removes the
    // image before the request reaches Router.
    try {
      const active = await this.db.getActiveLlmProvider();
      if (!active) return;
      const apiKey = this.secretBox.decrypt(active.api_key_encrypted);
      const check = await this.probeVision(active, apiKey);
      await this.persistDetectedVision(active, summarize([check]));
    } catch (error) {
      this.logger.warn("Не удалось автоматически проверить зрение активной LLM", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Небольшой запрос вне диалога — описание присланного медиа до хода
   * агента. Раньше он ходил прямо к активному провайдеру; теперь идёт через
   * LLM Router, поэтому получает ту же цепочку резервов и те же бюджеты,
   * что и разговор, и не ломается, когда основной провайдер лежит.
   *
   * API key здесь больше не расшифровывается: ключи провайдеров знает
   * только роутер.
   */
  async complete(messages: unknown[], options: { maxTokens?: number } = {}): Promise<string> {
    if (!this.config.routerApiKey) {
      throw badRequest("EVA_ROUTER_API_KEY не задан — LLM Router недоступен");
    }
    const response = await fetch(
      `${this.config.routerUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.routerApiKey}`,
        },
        body: JSON.stringify({
          // Описание изображения — это работа с картинкой, а не разговор,
          // поэтому отдельный маршрут со своей цепочкой.
          model: "eva/deep",
          messages,
          max_tokens: options.maxTokens ?? 2_000,
          temperature: 0.1,
          metadata: { route: "deep", sensitive: true },
        }),
        signal: AbortSignal.timeout(this.config.appServerRequestTimeoutMs),
      },
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`LLM Router вернул HTTP ${response.status}: ${raw.slice(0, 500)}`);
    }
    let body: {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new Error("LLM Router вернул некорректный JSON");
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (joined) return joined;
    }
    throw new Error("LLM Router не вернул текст");
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
    const identityChanged = old.protocol !== updated.protocol
      || old.base_url !== updated.base_url
      || old.model !== updated.model;
    const candidate = identityChanged
      ? (await this.db.setLlmProviderVisionCapability(updated.id, false) ?? updated)
      : updated;

    if (!old.is_active) return publicProvider(candidate);

    try {
      return await this.activateRow(candidate, old);
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
      await this.db.setLlmProviderVisionCapability(old.id, old.supports_vision === true);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const provider = await this.get(id);
    if (provider.is_active) throw badRequest("Активную LLM-конфигурацию удалить нельзя");
    const database = this.db as typeof this.db & { isLlmSingleProviderSelected?: (providerId: string) => Promise<boolean> };
    if (typeof database.isLlmSingleProviderSelected === "function" && await database.isLlmSingleProviderSelected(id)) {
      throw badRequest("Провайдер выбран для режима одной модели; сначала выберите другой");
    }
    if (!await this.db.deleteInactiveLlmProvider(id)) {
      throw notFound(`LLM-конфигурация ${id} не найдена`);
    }
  }

  async test(id: string): Promise<ProviderProbe> {
    const provider = await this.get(id);
    const result = await this.probe(provider);
    if (result.capabilities) await this.persistDetectedVision(provider, result.capabilities);
    await this.db.recordLlmCheck(id, {
      ok: result.ok,
      message: result.message,
      models: result.models_supported ? result.models : null,
      status: result.status ?? null,
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
    // Подготовка идёт до try, и раньше её падения не оставляли в журнале
    // ничего: ни строки об успехе, ни строки об ошибке. Снаружи это
    // выглядело как активация, которая молча ничего не сделала, и найти
    // причину по логам было невозможно. Теперь каждый шаг подготовки
    // назван, а его провал записан.
    this.logger.info("Активация LLM: проверка конфигурации", {
      providerId: candidate.id,
      name: candidate.name,
    });
    const check = await this.step("проверка конфигурации", candidate, async () =>
      await this.probe(candidate));
    if (check.capabilities) candidate = await this.persistDetectedVision(candidate, check.capabilities);
    await this.db.recordLlmCheck(candidate.id, {
      ok: check.ok,
      message: check.message,
      models: check.models_supported ? check.models : null,
      status: check.status ?? null,
    });
    // Активацию запрещает только настоящая ошибка настройки. Провайдер,
    // который прямо сейчас отвечает лимитом или пятисоткой, о модели не
    // сказал ничего — и отказ настроить его из-за этого был бы ровно той
    // ошибкой, ради которой в роутере есть цепочка резервов и breaker.
    // Такой провайдер включается, а его состояние остаётся видно оператору.
    if (check.status === "config_error" || (check.status === undefined && !check.ok)) {
      this.logger.error("Активация LLM: конфигурация не прошла проверку", {
        providerId: candidate.id,
        message: check.message,
      });
      throw badRequest(`Конфигурация не прошла проверку: ${check.message}`);
    }
    if (check.status === "unavailable") {
      this.logger.warn("Активация LLM: провайдер сейчас недоступен, проверка отложена", {
        providerId: candidate.id,
        message: check.message,
      });
    }

    const previous = rollbackOverride ?? await this.db.getActiveLlmProvider();
    const routerAlreadyConfigured = previous?.is_active === true;
    const previousChatChain = routerAlreadyConfigured
      ? await this.step("снимок chat-chain", candidate, async () =>
          await this.db.getLlmRouteChain("chat"))
      : null;
    // Провайдер остаётся скрыт за стабильным eva/chat, но metadata модели
    // (context/model settings и обнаруженная vision capability) принадлежит
    // текущей конфигурации. Поэтому mappings обновляются при каждой смене,
    // без повторной настройки коннектора и без рестарта App Server.
    const mappings = await this.step("опрос агентов App Server", candidate, async () =>
      await this.letta.listAllModelMappings());
    const candidateKey = this.secretBox.decrypt(candidate.api_key_encrypted);
    const candidateHandle = ROUTER_ROUTE_HANDLE;

    if (!routerAlreadyConfigured) this.letta.closeAllSessions();
    try {
      // После первой настройки Letta знает только стабильный eva/chat.
      // Смена provider/model за этим маршрутом — операция Router/DB и не
      // должна закрывать agent sessions или перезапускать App Server.
      if (!routerAlreadyConfigured) {
        await this.configureProvider(candidate, candidateKey);
        await this.restartAppServer();
      }
      // Сначала переключается реальная chat-chain. Тогда каталог
      // /api/v0/models, который прочитает Letta ниже, уже описывает новую
      // primary model, а не предыдущую конфигурацию под тем же eva/chat.
      const active = await this.db.activateLlmProvider(candidate.id);
      if (!active) throw new Error("конфигурация исчезла во время переключения");
      await this.letta.waitForModel(candidateHandle);
      await this.letta.applyModelToMappings(
        mappings,
        candidateHandle,
        candidate.context_window,
        modelSettings(candidate.additional_parameters),
      );
      await this.db.setAgentModels(candidateHandle);
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
        if (routerAlreadyConfigured) {
          await this.rollbackStableRoute(previous, mappings, previousChatChain ?? []);
        }
        else await this.rollback(previous, mappings);
      }
      throw new EvaError(
        `Не удалось переключить LLM; предыдущая конфигурация сохранена: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { code: "llm_switch_failed", statusCode: 502 },
      );
    }
  }

  /** Roll back a provider behind eva/chat without reconnecting or restarting Letta. */
  private async rollbackStableRoute(
    previous: LlmProviderRow,
    mappings: ModelMapping[],
    chatChain: string[],
  ): Promise<void> {
    try {
      await this.db.activateLlmProvider(previous.id);
      if (chatChain.length > 0) await this.db.replaceLlmRouteChain("chat", chatChain);
      const handle = ROUTER_ROUTE_HANDLE;
      await this.letta.waitForModel(handle);
      await this.letta.applyModelToMappings(
        mappings,
        handle,
        previous.context_window,
        modelSettings(previous.additional_parameters),
      );
      await this.db.setAgentModels(handle);
      this.letta.setDefaultModel(handle);
    } catch (rollbackError) {
      this.logger.error("Rollback metadata LLM не удался", {
        providerId: previous.id,
        message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
  }

  /**
   * Шаг подготовки к активации: называет себя в журнале, если упал.
   *
   * Ошибка возвращается наверх как есть — задача только в том, чтобы по
   * логу было видно, на чём именно всё остановилось.
   */
  private async step<T>(
    what: string,
    provider: LlmProviderRow,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await run();
    } catch (error) {
      this.logger.error(`Активация LLM прервана: ${what}`, {
        providerId: provider.id,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async rollback(previous: LlmProviderRow, mappings: ModelMapping[]): Promise<void> {
    try {
      await this.configureProvider(previous, this.secretBox.decrypt(previous.api_key_encrypted));
      await this.restartAppServer();
      const handle = ROUTER_ROUTE_HANDLE;
      await this.letta.waitForModel(handle);
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

  /**
   * Доступен ли провайдер и совместима ли модель.
   *
   * Две разные вещи, и раньше проверялась только первая: рабочий
   * `/models` считался достаточным основанием сделать модель основной.
   * Модель без вызова инструментов проходила активацию и ломалась в
   * первом же разговоре.
   */
  private async probe(provider: LlmProviderRow): Promise<ProviderProbe> {
    const apiKey = this.secretBox.decrypt(provider.api_key_encrypted);
    const connectivity = await this.probeProvider(provider, apiKey);
    // Модель не спрашиваем, пока провайдер не ответил: смысла нет, а
    // причина отказа была бы менее понятной.
    if (!connectivity.ok) return connectivity;

    const capabilities = await this.probeCapabilities(provider, apiKey);
    const catalogHint = connectivity.models_supported
      ? catalogVisionHint(connectivity.models, provider.model)
      : null;
    const detectedVision = capabilities.checks.find((entry) => entry.name === "vision")?.status === "ok";
    if (catalogHint !== null) {
      this.logger.info("LLM Router: catalog vision hint сопоставлен с фактической пробой", {
        providerId: provider.id,
        model: provider.model,
        catalogVision: catalogHint,
        detectedVision,
      });
    }
    return {
      ...connectivity,
      ok: capabilities.ok,
      status: capabilities.status,
      capabilities,
      message: `${connectivity.message} ${LlmManager.verdict(capabilities)}`.trim(),
    };
  }

  /**
   * Человеческая формулировка итога.
   *
   * Прежний текст знал две крайности: «совместима» и «несовместима». Из-за
   * этого лимит запросов и отсутствие изображений выглядели одинаково —
   * как приговор модели. Теперь состояние названо своим именем, и по тексту
   * видно, что делать: чинить настройку, подождать или просто знать про
   * ограничение.
   */
  private static verdict(capabilities: CapabilityProbeResult): string {
    switch (capabilities.status) {
      case "ok":
        return "Модель работает.";
      case "limited":
        return `Модель работает с ограничениями: ${capabilities.warnings}.`;
      case "unavailable":
        return `Провайдер сейчас недоступен, о модели это ничего не говорит — ${capabilities.message}. Повторите проверку позже.`;
      case "config_error":
      default:
        return `Ошибка конфигурации: ${capabilities.message}.`;
    }
  }

  /**
   * Сохраняет то, что проба выяснила о модели.
   *
   * Роутер отбирает провайдеров по этим полям, поэтому важно, чтобы там
   * стоял факт, а не галочка оператора: заявленный, но неработающий JSON
   * уводил на провайдера строгие маршруты, а незаявленное, но работающее
   * зрение прятало пригодную модель от маршрута изображений.
   *
   * Невыясненное (`null` — провайдер ответил лимитом или упал) не
   * записывается: стереть верное знание хуже, чем не обновить его.
   */
  private async persistDetectedVision(
    provider: LlmProviderRow,
    capabilities: CapabilityProbeResult,
  ): Promise<LlmProviderRow> {
    // Результат мог быть собран без раздела detected: падать на этом
    // нельзя, возможности просто останутся невыясненными.
    const detected = capabilities.detected ?? { vision: null, streaming: null, tools: null, json: null };
    const current: Record<string, boolean | undefined> = {
      vision: provider.supports_vision,
      streaming: provider.supports_streaming,
      tools: provider.supports_tools,
      json: provider.supports_json,
    };
    const changed: Record<string, boolean> = {};
    for (const key of ["vision", "streaming", "tools", "json"] as const) {
      const value = detected[key];
      if (value === null || value === undefined) continue;
      if (value === (current[key] === true)) continue;
      changed[key] = value;
    }
    if (Object.keys(changed).length === 0) return provider;
    const updated = await this.db.setLlmProviderCapabilities(provider.id, changed);
    if (!updated) return provider;
    this.logger.info("LLM Router: возможности модели обновлены по фактической пробе", {
      providerId: provider.id,
      model: provider.model,
      ...changed,
    });
    return updated;
  }

  /**
   * Подключает Letta App Server к LLM Router.
   *
   * Раньше сюда подставлялся base_url и ключ самого провайдера, поэтому
   * смена провайдера означала перенастройку и перезапуск App Server —
   * десятки секунд, за которые текущий диалог обрывался. Теперь App Server
   * знает единственный адрес, роутер, и остаётся на нём навсегда: цепочка
   * резервов и failover происходят за ним и рестарта не требуют.
   *
   * Аргумент apiKey сохранён в сигнатуре, но намеренно не используется:
   * ключи провайдеров знает только роутер, и App Server их больше не видит.
   */
  private async configureLettaProvider(provider: LlmProviderRow, _apiKey: string): Promise<void> {
    if (!this.config.routerApiKey) {
      throw badRequest("EVA_ROUTER_API_KEY не задан — LLM Router не настроен");
    }
    const timeout = numericParameter(provider.additional_parameters, "request_timeout_ms", 180_000);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    environment.LETTA_LOCAL_BACKEND_DIR = this.config.llmProviderConfigDir;
    // The local App Server's documented LM Studio connector is its dynamic
    // OpenAI-compatible endpoint adapter: unlike the built-in OpenAI catalog,
    // it discovers arbitrary model IDs from /models. The secret stays in the
    // child environment and never appears in argv or logs.
    environment.LMSTUDIO_API_KEY = this.config.routerApiKey;

    await new Promise<void>((resolve, reject) => {
      const terminal = spawnPty(
        this.config.lettaCliPath,
        [
        "--backend",
        "local",
        "connect",
        "lmstudio",
        "--base-url",
        this.config.routerUrl,
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
          terminal.write(`${this.config.routerApiKey}\r`);
        }
      });
      terminal.onExit(({ exitCode }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitCode === 0) resolve();
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
  if (!["openai-compatible", "openai-responses", "gemini-compatible", "anthropic-compatible"].includes(protocol)) {
    throw badRequest("Неизвестный LLM protocol");
  }
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
    last_check_status: row.last_check_status ?? null,
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

function capabilityInput(
  provider: LlmProviderRow,
  apiKey: string,
  config: Config,
): CapabilityProbeInput {
  return {
    baseUrl: provider.base_url,
    apiKey,
    model: provider.model,
    timeoutMs: config.llmProbeTimeoutMs,
    protocol: provider.protocol,
    contextWindow: provider.context_window,
    maxOutputTokens: numericParameter(
      provider.additional_parameters,
      "max_output_tokens",
      provider.max_output_tokens ?? Math.min(provider.context_window, 8_192),
    ),
    claims: {
      tools: provider.supports_tools !== false,
      json: provider.supports_json !== false,
      streaming: provider.supports_streaming !== false,
      vision: provider.supports_vision === true,
    },
    // Keep operator inference settings identical to production. The probe
    // itself still owns protocol-critical fields such as messages/tools.
    additionalParameters: provider.additional_parameters,
  };
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
