/** Capability probe executed through the same canonical request and adapters as production. */
import { adapterForProtocol } from "../router/adapters/index.js";
import type { LlmMessage, LlmRequest, LlmResponse, LlmTool, ProviderProfile } from "../router/types.js";
import { ProviderError } from "../router/types.js";
import { solidPng } from "./vision-check.js";

export type CapabilityName =
  | "completion" | "streaming" | "tool_call" | "tool_result_loop"
  | "json_object" | "json_schema" | "vision";

/**
 * Почему проверка не прошла. Раньше этого различия не было, и любой отказ
 * читался как «модель не умеет»: провайдер, ответивший 429, объявлялся
 * несовместимым с агентным ходом и оставался таким до следующей ручной
 * проверки. Ошибка провайдера уже приходит типизированной — `ProviderError`
 * знает и вид отказа, и повторяемость, — так что причину достаточно не
 * терять по дороге.
 *
 *   `capability` — провайдер ответил, но возможности нет: пустой ответ,
 *                  инструмент не вызван, JSON не разобрался;
 *   `config`     — отказ не пройдёт и со второй попытки: ключ отклонён,
 *                  модели нет, запрос отклонён по существу;
 *   `temporary`  — лимит, ошибка сервера, таймаут. О модели не говорит
 *                  ничего.
 */
export type CapabilityCause = "capability" | "config" | "temporary";

/**
 * Итог по провайдеру целиком.
 *
 *   `ok`           — всё заявленное работает;
 *   `limited`      — разговор с инструментами работает, часть
 *                    необязательных возможностей — нет;
 *   `config_error` — разговор невозможен, и сам собой отказ не пройдёт;
 *   `unavailable`  — проверить не удалось: провайдер сейчас недоступен.
 */
export type ProbeStatus = "ok" | "limited" | "config_error" | "unavailable";

/**
 * Что нужно Еве, чтобы вести ход: ответить, вызвать инструмент и принять
 * его результат. Остальное — streaming, изображения, строгий JSON —
 * расширяет применимость модели и решает, каким маршрутам она подходит,
 * но не делает её негодной.
 */
export const ESSENTIAL_CAPABILITIES: ReadonlySet<CapabilityName> =
  new Set<CapabilityName>(["completion", "tool_call", "tool_result_loop"]);

export interface CapabilityCheck {
  name: CapabilityName;
  status: "ok" | "failed" | "skipped";
  detail: string;
  blocking: boolean;
  cause?: CapabilityCause;
  /**
   * HTTP-код отказа, если он был.
   *
   * По нему отличают «квота этого ключа кончилась» от «сервис занят»:
   * первое лечится следующим ключом пула, второе — нет.
   */
  httpStatus?: number;
}

/** Что модель фактически умеет — по пробе, а не по галочкам оператора. */
export interface DetectedCapabilities {
  streaming: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  tools: boolean | null;
}

export interface CapabilityProbeResult {
  ok: boolean;
  status: ProbeStatus;
  checks: CapabilityCheck[];
  message: string;
  warnings: string;
  detected: DetectedCapabilities;
  /** Отказ упёрся в квоту или ключ, а не в модель и не в занятость сервиса. */
  keyExhausted?: boolean;
}
export interface CapabilityClaims { tools: boolean; json: boolean; streaming: boolean; vision: boolean }
export interface CapabilityProbeInput {
  baseUrl: string; apiKey: string; model: string; timeoutMs: number; claims: CapabilityClaims;
  protocol?: ProviderProfile["protocol"];
  contextWindow?: number;
  maxOutputTokens?: number;
  additionalParameters?: Record<string, unknown> | null;
}

const PROBE_TOOL: LlmTool = {
  name: "evaself_capability_probe",
  description: "Technical probe. Call it once with value \"ok\".",
  parameters: { type: "object", properties: { value: { type: "string", enum: ["ok"] } }, required: ["value"], additionalProperties: false },
};
/**
 * Стартовый допустимый output budget пробы.
 *
 * Раньше здесь стояло 32 токена: «ответь одним словом» — короткий ответ,
 * и большего вроде бы не нужно. Но `max_tokens` ограничивает всё, что
 * модель порождает, включая рассуждение, а рассуждающая модель тратит на
 * него сотни токенов прежде, чем напишет первое слово ответа. В 32
 * токена она не укладывается никогда и возвращает пустой текст — проба
 * читала это как «модель не умеет отвечать» и закрывала ей все маршруты.
 *
 * Работающей модели свободный потолок ничего не стоит: `max_tokens` —
 * предел, а не цель, и на «ready» она потратит те же несколько токенов.
 * Платят за него только те, кому его не хватало.
 */
const PROBE_BUDGET = 1024;
/** Вызов инструмента дороже: к рассуждению добавляются аргументы JSON. */
const PROBE_TOOL_BUDGET = 2048;

const PROBE_PROMPT = "Reply with the single word: ready";
const VISION_PROMPT = "The image is one solid color. Name that color with one word.";
const VISION_WORDS = /(green|зел[её]н|verde|gr[uü]n|vert)/iu;
const VISION_COLOR = [0x2f, 0xa8, 0x4a] as const;
const PROBE_JSON_SCHEMA = {
  name: "evaself_capability_probe", strict: true,
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};
const PROBE_CONTROLLED = new Set([
  "model", "messages", "contents", "input", "tools", "tool_choice", "stream", "stream_options",
  "temperature", "max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens", "n", "response_format",
]);
const ROUTING_KEYS = new Set(["provider", "route", "models", "transforms", "user", "metadata", "headers", "extra_headers", "extra_body", "usage", "model_settings"]);
const KEY_EXHAUSTED_STATUS: ReadonlySet<number> = new Set([401, 402, 403, 429]);
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|credential|authorization|bearer|cookie)/iu;

export function probeInferenceParameters(source: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    // In Chat Completions the configured presence of this field selects
    // the wire name. Its numeric value is still owned by the probe/runtime.
    if (key === "max_completion_tokens") {
      safe[key] = true;
      continue;
    }
    if (PROBE_CONTROLLED.has(key) || ROUTING_KEYS.has(key) || SECRET_KEY.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

const failure = (
  name: CapabilityName,
  detail: string,
  blocking: boolean,
  cause: CapabilityCause = "capability",
): CapabilityCheck => ({ name, status: "failed", detail, blocking, cause });
const skipped = (name: CapabilityName, detail: string): CapabilityCheck => ({ name, status: "skipped", detail, blocking: false });

/**
 * Отчего отказ: от модели, от конфигурации или от текущего состояния
 * провайдера. Виды ошибок уже расставлены `classifyHttp`, здесь они
 * только переводятся на язык пробы.
 *
 * `model_error` намеренно разделён: 400 и 422 на необязательной проверке
 * означают, что провайдер не принимает саму возможность — это свойство
 * модели, а не поломка настройки. Тот же 400 на обычном ответе означает,
 * что запрос собран не так, как ждёт провайдер.
 */
function causeOf(error: unknown, name: CapabilityName): CapabilityCause {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "temporary";
  }
  if (error instanceof ProviderError) {
    if (error.reason === "rate_limited" || error.reason === "server_error") return "temporary";
    if (error.reason === "timeout" || error.reason === "connection_failed") return "temporary";
    if (error.reason === "quota_exhausted") return "config";
    if (error.options.badRequest === true && !ESSENTIAL_CAPABILITIES.has(name)) return "capability";
    // Пустой ответ и оборванный поток — свойство ответа, а не настройки.
    // Двусмысленность (модель не умеет или провайдер перегружен)
    // разрешается ниже, в сводке, по остальным проверкам.
    if (error.reason === "empty_response" || error.reason === "invalid_response") return "capability";
    return "config";
  }
  return "temporary";
}

function errorDetail(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return `нет ответа за ${timeoutMs} мс`;
  if (error instanceof ProviderError) return `${error.httpStatus ? `HTTP ${error.httpStatus}: ` : ""}${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Отказ, пришедший исключением: причина выводится из самой ошибки. */
const thrown = (
  name: CapabilityName,
  error: unknown,
  timeoutMs: number,
  blocking: boolean,
): CapabilityCheck => ({
  ...failure(name, errorDetail(error, timeoutMs), blocking, causeOf(error, name)),
  ...(error instanceof ProviderError && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
});

function canonicalRequest(
  messages: LlmMessage[],
  options: Partial<Pick<LlmRequest, "tools" | "max_tokens" | "stream" | "response_format">> = {},
): LlmRequest {
  return {
    messages, system_prompt: "", tools: options.tools ?? [], temperature: 0,
    max_tokens: options.max_tokens ?? PROBE_BUDGET, stream: options.stream ?? false,
    response_format: options.response_format ?? null,
    metadata: { request_id: "capability-probe", user_id: null, agent_id: null, route: "chat", sensitive: false },
  };
}

/**
 * Ступени допустимого output budget: сама попытка, крупный шаг и потолок.
 *
 * Шагов ровно три, а не семь. Наращивание нужно ровно одному случаю —
 * модель или прокси не уложились в бюджет и вернули пустоту, — и в этом
 * случае разница между 512 и 1024 ничего не решает: либо хватает
 * нескольких тысяч, либо не хватит вовсе. Семь ступеней означали семь
 * запросов на каждую неудачную проверку, то есть минуты ожидания в
 * панели за тот же ответ.
 */
function budgets(initial: number, maximum: number): number[] {
  const first = Math.min(initial, maximum);
  return [...new Set([first, Math.min(maximum, first * 8), maximum])];
}
function parses(raw: string): unknown | undefined {
  try { return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gu, "")) as unknown; } catch { return undefined; }
}

function probeProvider(input: CapabilityProbeInput, fetcher: typeof fetch): ProviderProfile {
  const maximum = Math.max(256, Math.floor(input.maxOutputTokens ?? Math.min(input.contextWindow ?? 8_192, 8_192)));
  return {
    id: "capability-probe", name: "capability-probe", protocol: input.protocol ?? "openai-compatible",
    base_url: input.baseUrl, model: input.model, api_key: input.apiKey,
    connect_timeout_ms: input.timeoutMs, request_timeout_ms: input.timeoutMs, max_retries: 0,
    max_concurrency: 1, max_rpm: null, max_tpm: null, context_window: input.contextWindow ?? 8_192,
    max_output_tokens: maximum, max_latency_ms: null, supports_tools: true, supports_json: true,
    // The probe must be allowed to send the image before that capability is known.
    supports_vision: true, supports_streaming: input.claims.streaming, quality_tier: 1,
    sensitive_data_allowed: false, price_in_micro: 0, price_out_micro: 0,
    daily_budget_micro: null, monthly_budget_micro: null, generation_defaults: {},
    additional_parameters: probeInferenceParameters(input.additionalParameters), fetcher,
  };
}

/** Discover vision through the same canonical request and protocol adapter as production. */
export async function probeVisionCapability(
  input: CapabilityProbeInput,
  fetcher: typeof fetch = fetch,
): Promise<CapabilityCheck> {
  const provider = probeProvider(input, fetcher);
  const adapter = adapterForProtocol(provider.protocol);
  const maximum = provider.max_output_tokens;
  const request = canonicalRequest([{ role: "user", content: VISION_PROMPT, parts: [
    { type: "text", text: VISION_PROMPT },
    { type: "image", media_type: "image/png", data: solidPng(128, 128, VISION_COLOR).toString("base64") },
  ] }], { max_tokens: PROBE_BUDGET });
  // Изображения — необязательная возможность. Раньше её отсутствие при
  // заявленной галочке делало провайдера негодным целиком; теперь оно
  // лишь закрывает модели маршруты, которым изображения нужны.
  const unsupported = (detail: string, cause: CapabilityCause = "capability"): CapabilityCheck =>
    input.claims.vision
      ? failure("vision", detail, false, cause)
      : skipped("vision", `фактическая проба: ${detail}`);

  try {
    let last: LlmResponse | null = null;
    let usedBudget = request.max_tokens;
    for (const budget of budgets(request.max_tokens, maximum)) {
      usedBudget = budget;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try { last = await adapter.complete(provider, { ...request, max_tokens: budget }, controller.signal); }
      finally { clearTimeout(timer); }
      if (last.content.trim()) break;
      if (last.finish_reason !== "length" && !last.provider_state) break;
    }
    const answer = last?.content.trim() ?? "";
    if (!answer) {
      return unsupported(`пустой ответ на изображение; finish_reason=${last?.finish_reason ?? "unknown"}, допустимый output budget=${maximum}`);
    }
    if (!VISION_WORDS.test(answer)) {
      return unsupported(`изображение принято, но цвет не распознан (ответ: ${answer.slice(0, 80)})`);
    }
    return {
      name: "vision", status: "ok",
      detail: `изображение принято и распознано${usedBudget > request.max_tokens ? ` (output budget ${usedBudget})` : ""}`,
      blocking: false,
    };
  } catch (error) {
    return unsupported(errorDetail(error, input.timeoutMs), causeOf(error, "vision"));
  }
}

export async function probeModelCapabilities(input: CapabilityProbeInput, fetcher: typeof fetch = fetch): Promise<CapabilityProbeResult> {
  const checks: CapabilityCheck[] = [];
  const maximum = Math.max(256, Math.floor(input.maxOutputTokens ?? Math.min(input.contextWindow ?? 8_192, 8_192)));
  const provider = probeProvider(input, fetcher);
  const adapter = adapterForProtocol(provider.protocol);
  const complete = async (request: LlmRequest): Promise<{ response: LlmResponse; budget: number }> => {
    let last: LlmResponse | null = null;
    const steps = budgets(request.max_tokens, maximum);
    for (const [index, budget] of steps.entries()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try { last = await adapter.complete(provider, { ...request, max_tokens: budget }, controller.signal); }
      catch (error) {
        // Пустой ответ приходит от адаптера исключением, а не значением:
        // он не отличает тесноту бюджета от сломанного провайдера. Пока
        // ступени не кончились, это теснота — наращиваем и пробуем ещё.
        // Прежде исключение улетало наружу мимо всего цикла, и модель,
        // которой не хватило места на рассуждение, объявлялась
        // несовместимой с первой же попытки.
        if (!(error instanceof ProviderError) || error.reason !== "empty_response") throw error;
        if (index === steps.length - 1) throw error;
        last = null;
        continue;
      }
      finally { clearTimeout(timer); }
      if (last.content.trim() || last.tool_calls.length) return { response: last, budget };
      // Пустой ответ — это и есть повод поднять бюджет, а не повод
      // остановиться. Прежнее условие выходило из цикла, если
      // finish_reason не «length»: наращивание не срабатывало ровно там,
      // ради чего написано. Рассуждающая модель тратит бюджет на
      // рассуждение и отдаёт пустой текст с finish_reason=stop, и часть
      // прокси ведёт себя так же — такой провайдер объявлялся
      // несовместимым, ни разу не получив достаточного бюджета.
    }
    return { response: last ?? { content: "", tool_calls: [], finish_reason: "unknown", usage: { tokens_in: 0, tokens_out: 0 }, model: provider.model }, budget: maximum };
  };
  const note = (budget: number, initial: number) => budget > initial ? ` (понадобился допустимый output budget ${budget} токенов)` : "";

  try {
    const initial = PROBE_BUDGET;
    const result = await complete(canonicalRequest([{ role: "user", content: PROBE_PROMPT }], { max_tokens: initial }));
    checks.push(result.response.content.trim()
      ? { name: "completion", status: "ok", detail: `ответ получен${note(result.budget, initial)}`, blocking: true }
      : failure("completion", `пустой ответ; finish_reason=${result.response.finish_reason}, допустимый output budget=${maximum}`, true));
  } catch (error) { checks.push(thrown("completion", error, input.timeoutMs, true)); }

  if (!input.claims.streaming) checks.push(skipped("streaming", "поток не заявлен"));
  else {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      let events = 0;
      try {
        for await (const chunk of adapter.stream(provider, canonicalRequest([{ role: "user", content: PROBE_PROMPT }], { max_tokens: Math.min(PROBE_BUDGET, maximum), stream: true }), controller.signal)) {
          if (chunk.type !== "done") events += 1;
        }
      } finally { clearTimeout(timer); }
      // Поток — тоже необязательная возможность: без него Ева отвечает
      // целиком, а не по мере генерации. Это ухудшение, а не поломка.
      checks.push(events > 0
        ? { name: "streaming", status: "ok", detail: `дельт потока: ${events}`, blocking: false }
        : failure("streaming", "поток закончился без дельт", false));
    } catch (error) { checks.push(thrown("streaming", error, input.timeoutMs, false)); }
  }

  let toolResponse: LlmResponse | null = null;
  const toolPrompt: LlmMessage = { role: "user", content: "Call evaself_capability_probe with value \"ok\". After its result, reply exactly FINAL_OK." };
  try {
    const initial = PROBE_TOOL_BUDGET;
    const result = await complete(canonicalRequest([toolPrompt], { tools: [PROBE_TOOL], max_tokens: initial }));
    const call = result.response.tool_calls[0];
    let args: unknown;
    try { args = JSON.parse(call?.arguments ?? ""); } catch { args = null; }
    if (!call) checks.push(failure("tool_call", "модель не вызвала инструмент", true));
    else if (call.name !== PROBE_TOOL.name) checks.push(failure("tool_call", `вызван неизвестный инструмент ${call.name}`, true));
    else if ((args as { value?: unknown } | null)?.value !== "ok") checks.push(failure("tool_call", args === null ? "аргументы инструмента не разбираются как JSON" : "аргументы не соответствуют заданной схеме", true));
    else {
      toolResponse = result.response;
      checks.push({ name: "tool_call", status: "ok", detail: `вызов и аргументы по схеме${note(result.budget, initial)}`, blocking: true });
    }
  } catch (error) { checks.push(thrown("tool_call", error, input.timeoutMs, true)); }

  if (!toolResponse) checks.push(failure("tool_result_loop", "цикл не проверялся: вызова инструмента не было", true));
  else {
    const call = toolResponse.tool_calls[0]!;
    try {
      const initial = PROBE_TOOL_BUDGET;
      const result = await complete(canonicalRequest([
        toolPrompt,
        { role: "assistant", content: toolResponse.content, tool_calls: toolResponse.tool_calls, ...(toolResponse.provider_state ? { provider_state: toolResponse.provider_state } : {}) },
        { role: "tool", content: "{\"echo\":\"ok\"}", tool_call_id: call.id, name: call.name },
        { role: "user", content: "The tool result is complete. Reply exactly FINAL_OK now. Do not call tools." },
      ], { tools: [PROBE_TOOL], max_tokens: initial }));
      checks.push(result.response.content.trim()
        ? { name: "tool_result_loop", status: "ok", detail: `результат принят, final answer получен${note(result.budget, initial)}`, blocking: true }
        : failure("tool_result_loop", result.response.tool_calls.length ? "после результата модель снова требует инструмент вместо final answer" : `после результата нет final answer; finish_reason=${result.response.finish_reason}, допустимый output budget=${maximum}`, true));
    } catch (error) { checks.push(thrown("tool_result_loop", error, input.timeoutMs, true)); }
  }

  if (!input.claims.json) {
    checks.push(skipped("json_object", "строгий JSON не заявлен"));
    checks.push(skipped("json_schema", "строгий JSON не заявлен"));
  } else {
    try {
      const result = await complete(canonicalRequest([{ role: "user", content: "Return {\"ok\":true} and nothing else." }], { max_tokens: PROBE_BUDGET, response_format: { type: "json_object" } }));
      checks.push(parses(result.response.content) !== undefined ? { name: "json_object", status: "ok", detail: "ответ разбирается как JSON", blocking: false } : failure("json_object", "ответ не разбирается как JSON — разговор не затронут", false));
    } catch (error) { checks.push(thrown("json_object", error, input.timeoutMs, false)); }
    try {
      const result = await complete(canonicalRequest(
        [{ role: "user", content: "Return an object with ok set to true." }],
        { max_tokens: PROBE_BUDGET, response_format: { type: "json_schema", json_schema: PROBE_JSON_SCHEMA } },
      ));
      const parsed = parses(result.response.content) as { ok?: unknown } | undefined;
      checks.push(typeof parsed?.ok === "boolean"
        ? { name: "json_schema", status: "ok", detail: "ответ соответствует переданной схеме", blocking: false }
        : failure("json_schema", "ответ не соответствует переданной схеме", false));
    } catch (error) { checks.push(thrown("json_schema", error, input.timeoutMs, false)); }
  }

  checks.push(await probeVisionCapability(input, fetcher));

  return summarize(checks);
}

/**
 * Сводит проверки в один итог.
 *
 * Порядок важен: временный отказ на обязательной проверке перекрывает всё
 * остальное. Провайдер, ответивший 429, ничего не сообщил о модели, и
 * записывать ему «несовместима» — значит запомнить неправду до следующей
 * ручной проверки.
 */
export function summarize(checks: CapabilityCheck[]): CapabilityProbeResult {
  const failed = checks.filter((entry) => entry.status === "failed");
  const line = (entry: CapabilityCheck) => `${entry.name}: ${entry.detail}`;
  const essentialFailures = failed.filter((entry) => ESSENTIAL_CAPABILITIES.has(entry.name));
  const optionalFailures = failed.filter((entry) => !ESSENTIAL_CAPABILITIES.has(entry.name));

  // Пустой ответ двусмыслен: он приходит и от модели, которая не умеет
  // отвечать, и от перегруженного провайдера — у бесплатных моделей вторая
  // причина куда чаще, и в панели она соседствует с 429 от того же
  // провайдера. Если хотя бы одна обязательная проверка прошла, модель
  // отвечать явно умеет, и пустоту в соседней проверке честнее списать на
  // состояние провайдера, а не записывать модели несовместимость.
  const essentialPassed = checks.some(
    (entry) => entry.status === "ok" && ESSENTIAL_CAPABILITIES.has(entry.name),
  );
  if (essentialPassed) {
    for (const entry of essentialFailures) {
      if (entry.cause === "capability" && /пустой ответ|без содержимого|поток не открылся/u.test(entry.detail)) {
        entry.cause = "temporary";
      }
    }
  }

  const status: ProbeStatus = essentialFailures.some((entry) => entry.cause === "temporary")
    ? "unavailable"
    : essentialFailures.length > 0
      ? "config_error"
      : optionalFailures.length > 0
        ? "limited"
        : "ok";

  const passed = (name: CapabilityName): boolean =>
    checks.some((entry) => entry.name === name && entry.status === "ok");
  // Записать `false` вправе только сам вердикт модели: она ответила и
  // возможности не показала. Любой другой отказ — лимит, отклонённый
  // ключ, ненайденная модель — говорит о запросе, а не о модели, и
  // оставляет возможность невыясненной.
  //
  // Прежде так трактовался только `temporary`. HTTP 404 «модель не
  // найдена» проходил как вердикт и записывал провайдеру отсутствие
  // инструментов — после чего роутер исключал его из каждого хода с
  // инструментами, то есть из всех. Выйти из этого было нельзя: новая
  // проба у занятого провайдера отвечает лимитом, лимит оставляет
  // значение прежним, а руками возможности не выставляются. Провайдер
  // оставался мёртвым из-за опечатки в имени модели.
  //
  // Причина называется явно, а не через «всё, кроме capability»:
  // проверка без causa — вердикт модели по умолчанию, ровно как в
  // `failure()`, и трактовать её как невыясненную нельзя.
  const UNDETERMINED: ReadonlySet<CapabilityCause> = new Set(["config", "temporary"]);
  const undecided = (...names: CapabilityName[]): boolean =>
    names.some((name) => failed.some(
      (entry) => entry.name === name && entry.cause !== undefined && UNDETERMINED.has(entry.cause),
    ));
  const detected: DetectedCapabilities = {
    streaming: undecided("streaming") ? null : passed("streaming"),
    vision: undecided("vision") ? null : passed("vision"),
    json: undecided("json_object", "json_schema") ? null : passed("json_object") || passed("json_schema"),
    tools: undecided("tool_call", "tool_result_loop") ? null : passed("tool_call") && passed("tool_result_loop"),
  };

  return {
    ok: status === "ok" || status === "limited",
    status,
    checks,
    message: essentialFailures.map(line).join("; "),
    warnings: optionalFailures.map(line).join("; "),
    detected,
    // Квота и отклонённый ключ — свойства ключа: у провайдера с пулом
    // следующий ключ ответит иначе. Занятый сервис (503) к ключу
    // отношения не имеет, и перебирать пул из-за него значит впустую
    // гонять полную пробу десять раз.
    keyExhausted: checks.some(
      (entry) => entry.status === "failed"
        && entry.httpStatus !== undefined
        && KEY_EXHAUSTED_STATUS.has(entry.httpStatus),
    ),
  };
}
