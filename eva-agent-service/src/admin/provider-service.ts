import { AdminApiError, adminBadRequest } from "./errors.js";
import { OutboundGateway } from "./outbound-gateway.js";
import { globalSecretRedactor } from "./redactor.js";
import { SecretStore } from "./secret-store.js";
import { findSecretField, sanitizeParameters } from "./provider-safe.js";

interface AgentResponse {
  [key: string]: unknown;
}

export class InternalAgentClient {
  constructor(
    private readonly secrets: SecretStore,
    private readonly baseUrl =
      process.env.EVA_INTERNAL_AGENT_URL ?? "http://eva-agent-service:8070",
  ) {}

  async request(path: string, options: RequestInit = {}): Promise<AgentResponse | null> {
    const key = await this.secrets.get("sec_eva_agent_api_key");
    if (!key) {
      throw new AdminApiError(
        "agent_api_key_missing",
        "Системный ключ Agent Runtime не импортирован",
        503,
      );
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "X-API-Key": key,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(190_000),
    });
    const raw = await response.text();
    let payload: AgentResponse | null = null;
    try {
      payload = raw ? JSON.parse(raw) as AgentResponse : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const sourceMessage = payload?.error && typeof payload.error === "object"
        ? (payload.error as { message?: unknown }).message
        : null;
      const safeMessage = typeof sourceMessage === "string"
        ? String(globalSecretRedactor.redact(sourceMessage))
        : "Agent Runtime отклонил операцию";
      throw new AdminApiError(
        "agent_runtime_error",
        safeMessage,
        response.status >= 400 && response.status < 600 ? response.status : 502,
      );
    }
    return payload;
  }
}

export class ProviderService {
  constructor(
    private readonly agent: InternalAgentClient,
    private readonly gateway: OutboundGateway,
  ) {}

  async list(kind: string) {
    if (kind !== "llm") {
      return { providers: [], kind, runtime_connected: false };
    }
    const payload = await this.agent.request("/v1/llm/providers");
    const providers = Array.isArray(payload?.providers)
      ? payload.providers.map((item) => safeProvider(item))
      : [];
    return { providers, kind: "llm", runtime_connected: true };
  }

  async create(raw: Record<string, unknown>) {
    rejectSecretParameters(raw.additional_parameters);
    await this.gateway.validate(raw.base_url);
    return await this.agent.request("/v1/llm/providers", {
      method: "POST",
      body: JSON.stringify(raw),
    });
  }

  async update(id: string, raw: Record<string, unknown>) {
    this.assertId(id);
    rejectSecretParameters(raw.additional_parameters);
    if (raw.base_url !== undefined) await this.gateway.validate(raw.base_url);
    return await this.agent.request(`/v1/llm/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(raw),
    });
  }

  async remove(id: string) {
    this.assertId(id);
    await this.agent.request(`/v1/llm/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async check(id: string) {
    this.assertId(id);
    return await this.agent.request(`/v1/llm/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
  }

  async models(id: string) {
    this.assertId(id);
    return await this.agent.request(`/v1/llm/providers/${encodeURIComponent(id)}/models`);
  }

  /**
   * Проверка распознавания медиа.
   *
   * Отдельный маршрут, а не `check(id)`: проверяется не провайдер, а
   * тракт целиком — картинка уходит через production Router, и какой
   * провайдер на неё посмотрит, решает цепочка маршрута `vision`.
   */
  async visionCheck() {
    return await this.agent.request("/v1/llm/vision-check", { method: "POST" });
  }

  async activate(id: string) {
    this.assertId(id);
    return await this.agent.request(`/v1/llm/providers/${encodeURIComponent(id)}/activate`, {
      method: "POST",
    });
  }

  private assertId(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminBadRequest("Некорректный provider_id");
  }
}

function rejectSecretParameters(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adminBadRequest("additional_parameters должен быть JSON-объектом");
  }
  const unsafe = findSecretField(value as Record<string, unknown>);
  if (unsafe) {
    throw adminBadRequest(
      `Секретный параметр ${unsafe} нужно сохранять через поле API Key`,
    );
  }
}

function safeProvider(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    "id",
    "name",
    "protocol",
    "base_url",
    "model",
    "model_handle",
    "context_window",
    "is_active",
    "api_key_configured",
    "last_checked_at",
    "last_check_ok",
    // Состояние пробы: панель показывает по нему четыре положения вместо
    // «прошёл / не прошёл». Без него в списке провайдеров лимит запросов
    // выглядел бы так же, как отклонённый ключ.
    "last_check_status",
    "last_check_message",
    "last_models",
    "created_at",
    "updated_at",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.additional_parameters = sanitizeParameters(source.additional_parameters);
  return result;
}
