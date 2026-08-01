/**
 * Внутренний формат LLM Router.
 *
 * Ни один вызывающий не разговаривает с конкретным провайдером: и Letta, и
 * eva-agent-service присылают запрос в этом виде (или в OpenAI-совместимом,
 * который сервер сразу приводит к нему), а адаптер разворачивает его в
 * формат целевого API.
 */

export type RouteCode = string;

export interface LlmToolCall {
  id: string;
  name: string;
  /** Аргументы приходят от модели строкой JSON; здесь она не разбирается. */
  arguments: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Только для role="assistant". */
  tool_calls?: LlmToolCall[];
  /** Только для role="tool" — id вызова, на который это ответ. */
  tool_call_id?: string;
  name?: string;
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema параметров. */
  parameters: Record<string, unknown>;
}

export interface LlmRequestMetadata {
  request_id: string;
  user_id: string | null;
  agent_id: string | null;
  route: RouteCode;
  /** Запрос содержит личные данные пользователя, а не служебные. */
  sensitive: boolean;
}

export interface LlmRequest {
  messages: LlmMessage[];
  system_prompt: string;
  tools: LlmTool[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
  response_format: { type: "json_object" } | null;
  metadata: LlmRequestMetadata;
}

export interface LlmUsage {
  tokens_in: number;
  tokens_out: number;
}

export interface LlmResponse {
  content: string;
  tool_calls: LlmToolCall[];
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "unknown";
  usage: LlmUsage;
  model: string;
}

/** Кусок потокового ответа. */
export type LlmStreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: LlmToolCall }
  | { type: "done"; response: LlmResponse };

/**
 * Причины, по которым запрос уходит следующему провайдеру.
 * Совпадают со словарём CHECK-ограничения llm_requests.switch_reason.
 */
export type SwitchReason =
  | "rate_limited"
  | "server_error"
  | "connection_failed"
  | "timeout"
  | "empty_response"
  | "invalid_response"
  | "model_error"
  | "quota_exhausted"
  | "budget_exceeded"
  | "json_contract_failed"
  | "tool_calls_failed"
  | "latency_exceeded"
  | "breaker_open"
  | "incompatible"
  | "rotation_disabled";

/** Ошибка провайдера, уже классифицированная адаптером. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly reason: SwitchReason,
    readonly options: {
      /** Имеет ли смысл повторить тот же запрос тому же провайдеру. */
      retryable: boolean;
      httpStatus?: number;
      /**
       * Запрос не понравился провайдеру (HTTP 400). Такой запрос нельзя
       * гонять по всей цепочке — сначала нормализация параметров.
       */
      badRequest?: boolean;
    },
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get httpStatus(): number | null {
    return this.options.httpStatus ?? null;
  }

  /** Короткое описание для журнала: без тела запроса и без переписки. */
  summary(): string {
    return this.message.slice(0, 500);
  }
}

/** Профиль провайдера в том виде, в каком его использует роутер. */
export interface ProviderProfile {
  id: string;
  name: string;
  protocol: "openai-compatible" | "anthropic-compatible";
  base_url: string;
  model: string;
  api_key: string;

  connect_timeout_ms: number;
  request_timeout_ms: number;
  max_retries: number;
  max_concurrency: number;
  max_rpm: number | null;
  max_tpm: number | null;

  context_window: number;
  max_output_tokens: number;
  max_latency_ms: number | null;

  supports_tools: boolean;
  supports_json: boolean;
  supports_vision: boolean;
  supports_streaming: boolean;
  quality_tier: number;
  sensitive_data_allowed: boolean;

  price_in_micro: number;
  price_out_micro: number;
  daily_budget_micro: number | null;
  monthly_budget_micro: number | null;

  generation_defaults: Record<string, unknown>;
  additional_parameters: Record<string, unknown>;
}

export interface RouteDefinition {
  code: RouteCode;
  title: string;
  requires_tools: boolean;
  requires_json: boolean;
  requires_vision: boolean;
  requires_streaming: boolean;
  min_context_window: number;
  max_quality_tier: number;
  allows_sensitive: boolean;
  /**
   * Разрешено ли подставлять резервную модель, когда основная не
   * ответила. Выключается там, где подмена заметна: у маршрута chat,
   * которым пользуется Letta, резервная модель отвечает в другом стиле,
   * и владелец вправе предпочесть отказ.
   */
  rotation_enabled: boolean;
}

/** Адаптер конкретного семейства API. */
export interface ProviderAdapter {
  readonly protocol: ProviderProfile["protocol"];
  complete(
    provider: ProviderProfile,
    request: LlmRequest,
    signal: AbortSignal,
  ): Promise<LlmResponse>;
  stream(
    provider: ProviderProfile,
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmStreamChunk>;
}
