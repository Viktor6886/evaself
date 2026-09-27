/**
 * Декларативные манифесты OpenAI-совместимых провайдеров.
 *
 * Большинство провайдеров говорят на одном API `/chat/completions` и
 * отличаются мелочами: адресом, заголовком ключа, необязательными
 * заголовками атрибуции, названием поля бюджета ответа. Отдельный
 * адаптер на каждый — лишний код; манифест описывает эти мелочи
 * данными, и новый совместимый провайдер подключается записью в список
 * или полем `additional_parameters.openai_compat` из панели — без нового
 * файла адаптера.
 *
 * LLM Router при этом не заменяется: манифест читает тот же адаптер
 * `openai-compatible`, а failover, capability probe, ротация ключей,
 * breaker, лимиты и зрение работают как прежде. Манифест не объявляет
 * возможности модели — их по-прежнему доказывает probe; `hints` лишь
 * подсказывают форму панели.
 *
 * Идея реестра провайдеров — из Hermes Agent (agent/provider_registry.py,
 * MIT, Nous Research); реализация своя и без загрузки провайдеров из
 * плагинов: список живёт в коде.
 */

export type BudgetField = "max_tokens" | "max_completion_tokens";

export interface ProviderManifest {
  id: string;
  title: string;
  protocol: "openai-compatible";
  baseUrl: string;
  /** Хосты, по которым провайдер узнаётся без явного `provider_manifest`. */
  hosts: readonly string[];
  /** Заголовок ключа. По умолчанию `Authorization: Bearer <key>`. */
  auth?: { header: string; scheme: "Bearer" | null };
  /** Постоянные несекретные заголовки (атрибуция и т. п.). */
  headers?: Readonly<Record<string, string>>;
  budgetField?: BudgetField;
  /** Развёрнут у себя: ключ может быть формальным, адрес — внутренним. */
  selfHosted?: boolean;
  hints?: { tools?: boolean; vision?: boolean; json?: boolean; streaming?: boolean };
  docs?: string;
}

export const PROVIDER_MANIFESTS: readonly ProviderManifest[] = Object.freeze([
  { id: "openai", title: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", hosts: ["api.openai.com"], hints: { tools: true, vision: true, json: true, streaming: true }, docs: "https://platform.openai.com/docs/api-reference/chat" },
  { id: "openrouter", title: "OpenRouter", protocol: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", hosts: ["openrouter.ai"], headers: { "X-Title": "Evaself" }, hints: { tools: true, streaming: true }, docs: "https://openrouter.ai/docs" },
  { id: "deepseek", title: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", hosts: ["api.deepseek.com"], hints: { tools: true, json: true, streaming: true }, docs: "https://api-docs.deepseek.com" },
  { id: "groq", title: "Groq", protocol: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", hosts: ["api.groq.com"], hints: { tools: true, json: true, streaming: true }, docs: "https://console.groq.com/docs/openai" },
  { id: "mistral", title: "Mistral AI", protocol: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", hosts: ["api.mistral.ai"], hints: { tools: true, json: true, streaming: true }, docs: "https://docs.mistral.ai/api" },
  { id: "together", title: "Together AI", protocol: "openai-compatible", baseUrl: "https://api.together.xyz/v1", hosts: ["api.together.xyz"], hints: { tools: true, streaming: true }, docs: "https://docs.together.ai" },
  { id: "fireworks", title: "Fireworks AI", protocol: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", hosts: ["api.fireworks.ai"], hints: { tools: true, streaming: true }, docs: "https://docs.fireworks.ai" },
  { id: "xai", title: "xAI", protocol: "openai-compatible", baseUrl: "https://api.x.ai/v1", hosts: ["api.x.ai"], hints: { tools: true, vision: true, streaming: true }, docs: "https://docs.x.ai" },
  { id: "cerebras", title: "Cerebras", protocol: "openai-compatible", baseUrl: "https://api.cerebras.ai/v1", hosts: ["api.cerebras.ai"], hints: { tools: true, streaming: true }, docs: "https://inference-docs.cerebras.ai" },
  { id: "moonshot", title: "Moonshot (Kimi)", protocol: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", hosts: ["api.moonshot.ai", "api.moonshot.cn"], hints: { tools: true, streaming: true }, docs: "https://platform.moonshot.ai/docs" },
  { id: "dashscope", title: "Alibaba Qwen (DashScope)", protocol: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", hosts: ["dashscope-intl.aliyuncs.com", "dashscope.aliyuncs.com"], hints: { tools: true, streaming: true }, docs: "https://www.alibabacloud.com/help/en/model-studio" },
  { id: "nebius", title: "Nebius AI Studio", protocol: "openai-compatible", baseUrl: "https://api.studio.nebius.com/v1", hosts: ["api.studio.nebius.com"], hints: { tools: true, streaming: true }, docs: "https://docs.nebius.com/studio" },
  { id: "ollama", title: "Ollama (свой сервер)", protocol: "openai-compatible", baseUrl: "http://ollama:11434/v1", hosts: [], selfHosted: true, hints: { streaming: true }, docs: "https://github.com/ollama/ollama/blob/main/docs/openai.md" },
  { id: "vllm", title: "vLLM (свой сервер)", protocol: "openai-compatible", baseUrl: "http://vllm:8000/v1", hosts: [], selfHosted: true, hints: { tools: true, streaming: true }, docs: "https://docs.vllm.ai" },
  { id: "lmstudio", title: "LM Studio (свой сервер)", protocol: "openai-compatible", baseUrl: "http://lmstudio:1234/v1", hosts: [], selfHosted: true, hints: { streaming: true }, docs: "https://lmstudio.ai/docs" },
]);

export interface ResolvedOpenAiCompat {
  manifestId: string | null;
  authHeader: string;
  authScheme: "Bearer" | null;
  headers: Record<string, string>;
  budgetField: BudgetField | null;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/**
 * Заголовки, которые задаёт сам роутер или транспорт. Переопределить их
 * настройкой нельзя: `content-type` сломал бы тело, `host` — адресацию,
 * а секрет в постоянном заголовке хранился бы открытым текстом.
 */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "accept", "connection", "transfer-encoding",
  "cookie", "proxy-authorization", "authorization", "x-api-key", "api-key",
]);
const SECRET_HEADER = /(?:api[_-]?key|token|password|secret|authorization|credential|cookie)/i;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function manifestById(id: unknown): ProviderManifest | null {
  return typeof id === "string" ? PROVIDER_MANIFESTS.find((manifest) => manifest.id === id) ?? null : null;
}

export function manifestForBaseUrl(baseUrl: string): ProviderManifest | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return PROVIDER_MANIFESTS.find((manifest) => manifest.hosts.includes(host)) ?? null;
}

/**
 * Проверка переопределений `openai_compat` при сохранении провайдера.
 * `null` — всё в порядке, иначе — что поправить.
 */
export function validateOpenAiCompat(parameters: Record<string, unknown>): string | null {
  if (parameters.provider_manifest !== undefined && !manifestById(parameters.provider_manifest)) {
    return `provider_manifest: неизвестный манифест «${String(parameters.provider_manifest)}»`;
  }
  if (parameters.openai_compat === undefined) return null;
  const compat = parameters.openai_compat;
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) return "openai_compat должен быть объектом";
  const value = compat as Record<string, unknown>;
  const known = new Set(["auth_header", "auth_scheme", "headers", "budget_field"]);
  for (const key of Object.keys(value)) if (!known.has(key)) return `openai_compat.${key}: неизвестное поле`;
  if (value.auth_header !== undefined && (typeof value.auth_header !== "string" || !HEADER_NAME.test(value.auth_header)
    || ["host", "content-type", "content-length", "cookie"].includes(value.auth_header.toLowerCase()))) {
    return "openai_compat.auth_header: имя заголовка латиницей, цифрами и дефисом";
  }
  if (value.auth_scheme !== undefined && value.auth_scheme !== "Bearer" && value.auth_scheme !== "none") {
    return "openai_compat.auth_scheme: Bearer или none";
  }
  if (value.budget_field !== undefined && value.budget_field !== "max_tokens" && value.budget_field !== "max_completion_tokens") {
    return "openai_compat.budget_field: max_tokens или max_completion_tokens";
  }
  if (value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)) return "openai_compat.headers: объект";
    const headers = value.headers as Record<string, unknown>;
    if (Object.keys(headers).length > 10) return "openai_compat.headers: не больше десяти заголовков";
    for (const [name, item] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || SECRET_HEADER.test(name)) {
        return `openai_compat.headers.${name}: заголовок нельзя задать настройкой`;
      }
      if (typeof item !== "string" || item.length > 256 || /[\r\n]/.test(item)) {
        return `openai_compat.headers.${name}: строка до 256 знаков без перевода строки`;
      }
    }
  }
  return null;
}

/**
 * Манифест провайдера с его переопределениями.
 *
 * Порядок: явный `provider_manifest` → узнанный по хосту → общий
 * OpenAI-совместимый. Поверх — `openai_compat` провайдера. Запрещённые
 * заголовки отбрасываются и здесь: запись в базе могла появиться в обход
 * проверки панели.
 */
export function resolveOpenAiCompat(baseUrl: string, parameters: Record<string, unknown>): ResolvedOpenAiCompat {
  const manifest = manifestById(parameters.provider_manifest) ?? manifestForBaseUrl(baseUrl);
  const compat = objectValue(parameters.openai_compat);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...(manifest?.headers ?? {}), ...objectValue(compat.headers) })) {
    if (typeof value !== "string" || !HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())
      || SECRET_HEADER.test(name) || /[\r\n]/.test(value)) continue;
    headers[name] = value.slice(0, 256);
  }
  const authHeader = typeof compat.auth_header === "string" && HEADER_NAME.test(compat.auth_header)
    ? compat.auth_header
    : manifest?.auth?.header ?? "authorization";
  const authScheme = compat.auth_scheme === "none" ? null
    : compat.auth_scheme === "Bearer" ? "Bearer"
    : manifest?.auth ? manifest.auth.scheme : "Bearer";
  const budgetField = compat.budget_field === "max_tokens" || compat.budget_field === "max_completion_tokens"
    ? compat.budget_field
    : manifest?.budgetField ?? null;
  return { manifestId: manifest?.id ?? null, authHeader, authScheme, headers, budgetField };
}

/** Заголовки запроса: ключ по схеме манифеста и постоянные заголовки. */
export function openAiCompatHeaders(resolved: ResolvedOpenAiCompat, apiKey: string): Record<string, string> {
  return {
    ...resolved.headers,
    [resolved.authHeader.toLowerCase()]: resolved.authScheme ? `${resolved.authScheme} ${apiKey}` : apiKey,
  };
}

/** Что показывает панель: манифесты без внутренних подробностей. */
export function publicManifests(): Array<{
  id: string; title: string; protocol: string; base_url: string; self_hosted: boolean;
  hints: ProviderManifest["hints"]; docs: string | null;
}> {
  return PROVIDER_MANIFESTS.map((manifest) => ({
    id: manifest.id, title: manifest.title, protocol: manifest.protocol, base_url: manifest.baseUrl,
    self_hosted: manifest.selfHosted === true, hints: manifest.hints ?? {}, docs: manifest.docs ?? null,
  }));
}
