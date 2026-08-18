/**
 * Совместима ли модель с тем, как её будет вызывать Letta.
 *
 * Рабочий `/models` доказывает только, что провайдер отвечает по HTTP.
 * Разговор Евы — это агентный цикл: поток, вызов инструмента с
 * аргументами по заданной схеме, возврат результата инструмента и
 * завершение цикла осмысленным ответом. Модель, у которой в конфигурации
 * стоит `supports_tools = true`, а на деле инструмент не вызывается,
 * ломается не на активации, а в первом же разговоре человека — и
 * выглядит это как «Ева молчит», а не как «модель не умеет tools».
 *
 * Поэтому здесь несколько крошечных технических запросов к самому
 * провайдеру. Проверяется только заявленное: не заявлено — не
 * проверяется. Никаких данных пользователя, `temperature: 0`, десятки
 * токенов на весь набор. Это не второй когнитивный слой: ни одно
 * решение о разговоре здесь не принимается, а результат — «умеет» или
 * «не умеет» с причиной.
 *
 * Проба обязана обращаться к модели так же, как это делает продакшн:
 * с теми же `additional_parameters` и с сохранением служебных полей
 * ответа. Проверка в чужой конфигурации отвечает на другой вопрос, и
 * её «не умеет» ничего не значит.
 */

export type CapabilityName =
  | "completion" | "streaming" | "tool_call" | "tool_result_loop"
  | "json_object" | "json_schema" | "vision";

export interface CapabilityCheck {
  name: CapabilityName;
  status: "ok" | "failed" | "skipped";
  detail: string;
  /** Провал этой проверки запрещает делать модель основной. */
  blocking: boolean;
}

export interface CapabilityProbeResult {
  ok: boolean;
  checks: CapabilityCheck[];
  /** Короткая причина отказа для человека. Пусто, когда всё сошлось. */
  message: string;
  /**
   * Возможности, которых у модели нет, но разговор без них состоится.
   * Молчать о них нельзя: продуктовые маршруты на них рассчитывают.
   */
  warnings: string;
}

export interface CapabilityClaims {
  tools: boolean;
  json: boolean;
  streaming: boolean;
  vision: boolean;
}

export interface CapabilityProbeInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  claims: CapabilityClaims;
  /**
   * `additional_parameters` провайдера — те же, что роутер подставляет в
   * каждый настоящий запрос (`src/router/adapters/openai.ts`). У
   * reasoning-моделей от них зависит сама форма ответа.
   */
  additionalParameters?: Record<string, unknown> | null;
}

/** Инструмент пробы. Имя намеренно своё, чтобы не пересечься с продуктовыми. */
const PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "evaself_capability_probe",
    description: "Technical probe. Call it once with value \"ok\".",
    parameters: {
      type: "object",
      properties: { value: { type: "string", enum: ["ok"] } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};

/** Схема для Structured Outputs: та же дешевизна, что и у остальных проб. */
const PROBE_JSON_SCHEMA = {
  name: "evaself_capability_probe",
  strict: true,
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

/** Один и тот же безобидный запрос: никаких данных пользователя. */
const PROBE_PROMPT = "Reply with the single word: ready";

/**
 * Поля запроса, которыми распоряжается сама проба. Настройка провайдера
 * их не переопределяет: иначе проба перестанет быть дешёвой,
 * детерминированной и проверяющей именно то, что заявлено.
 */
const PROBE_CONTROLLED = new Set([
  "model", "messages", "tools", "tool_choice", "stream", "stream_options",
  "temperature", "max_tokens", "max_completion_tokens", "n", "response_format",
]);

/**
 * Метаданные маршрутизации и учёта. Провайдеру они говорят, *куда* и *от
 * чьего имени* идёт запрос, а не *как* считать ответ, и в технической
 * пробе им делать нечего.
 */
const ROUTING_KEYS = new Set([
  "provider", "route", "models", "transforms", "user", "metadata",
  "headers", "extra_headers", "extra_body", "usage",
]);

/** Ключ, похожий на учётные данные, в пробу не попадает никогда. */
const SECRET_KEY = /key|token|secret|password|credential|authorization|bearer|cookie/iu;

/**
 * Что из настроек провайдера уходит в пробу: всё, что влияет на вывод
 * модели (`reasoning`, `reasoning_effort`, `chat_template_kwargs`,
 * `top_p`, `verbosity` и прочее, что у провайдера означает режим
 * размышления), — и ничего из того, что относится к доступу и маршруту.
 */
export function probeInferenceParameters(
  source: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (PROBE_CONTROLLED.has(key) || ROUTING_KEYS.has(key)) continue;
    if (SECRET_KEY.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

type Fetcher = typeof fetch;

type ToolCallEntry = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

/**
 * Сообщение модели — открытая запись, а не фиксированный набор полей:
 * `reasoning`, `reasoning_details`, `refusal`, `annotations` у разных
 * провайдеров свои, и проба их не разбирает, а пересылает обратно.
 */
type AssistantMessage = Record<string, unknown> & {
  content?: unknown;
  tool_calls?: ToolCallEntry[];
};

interface ChatResponse {
  choices?: Array<{ message?: AssistantMessage; finish_reason?: string }>;
}

/**
 * Имена служебных полей размышления. Именно имена: содержимое reasoning
 * не читается, не логируется и не сохраняется — оно только уходит
 * обратно тому же провайдеру.
 */
const REASONING_FIELDS = ["reasoning", "reasoning_details", "reasoning_content", "thinking"];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : String((part as { text?: unknown }).text ?? "")))
      .join("");
  }
  return "";
}

function failure(name: CapabilityName, detail: string, blocking: boolean): CapabilityCheck {
  return { name, status: "failed", detail, blocking };
}

/**
 * Отказ провайдера словами провайдера. Один «HTTP 400» не отличает
 * неизвестную модель от непринятого параметра, а разбираться с этим
 * человеку.
 */
async function httpDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (!raw.trim()) return `HTTP ${response.status}`;
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
    const inner = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (typeof inner === "string" && inner.trim()) text = inner;
  } catch {
    // Провайдер ответил не JSON — берём тело как есть.
  }
  return `HTTP ${response.status}: ${text.replace(/\s+/gu, " ").trim().slice(0, 200)}`;
}

/**
 * Ответ модели возвращается провайдеру ровно таким, каким пришёл.
 *
 * У reasoning-моделей вместе с вызовом инструмента приходит
 * `reasoning_details` — непрозрачный блок, который тот же провайдер
 * требует вернуть без изменений вместе с результатом инструмента. Проба,
 * собиравшая assistant-сообщение заново из одних `tool_calls`, этот блок
 * теряла: модель после результата отвечала пустотой, и цикл выглядел
 * незавершённым, хотя дело было в форме запроса, а не в модели.
 *
 * Дописывается ровно одно поле — идентификатор вызова, и только если
 * провайдер его не прислал: без него результат не связать с вызовом.
 */
function echoedAssistant(message: AssistantMessage, toolCallId: string): AssistantMessage {
  const calls = message.tool_calls ?? [];
  const echoed: AssistantMessage = { role: "assistant", ...message };
  if (calls[0]?.id === toolCallId) return echoed;
  return {
    ...echoed,
    tool_calls: calls.map((call, index) => (index === 0 ? { ...call, id: toolCallId } : call)),
  };
}

/** Тот же вызов без служебных полей — для провайдеров, которые их не принимают. */
function minimalAssistant(message: AssistantMessage, toolCallId: string): Record<string, unknown> {
  const call = message.tool_calls?.[0];
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    tool_calls: [{
      id: toolCallId,
      type: "function",
      function: {
        name: call?.function?.name ?? PROBE_TOOL.function.name,
        // Аргументы берутся у модели, а не придумываются пробой: иначе
        // провайдеру уходит вызов, которого модель не делала.
        arguments: call?.function?.arguments ?? "{}",
      },
    }],
  };
}

export async function probeModelCapabilities(
  input: CapabilityProbeInput,
  fetcher: Fetcher = fetch,
): Promise<CapabilityProbeResult> {
  const url = `${input.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  const checks: CapabilityCheck[] = [];
  const inference = probeInferenceParameters(input.additionalParameters);

  const call = async (body: Record<string, unknown>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      return await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: body.stream === true ? "text/event-stream" : "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        // Порядок как в роутере: настройка провайдера идёт первой, поля
        // самой пробы её перекрывают.
        body: JSON.stringify({ ...inference, model: input.model, temperature: 0, ...body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const reason = (error: unknown): string => error instanceof Error && error.name === "AbortError"
    ? `нет ответа за ${input.timeoutMs} мс`
    : error instanceof Error ? error.message : String(error);

  // --- 1. Обычный ответ ---------------------------------------------
  try {
    const response = await call({
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: 32,
      stream: false,
    });
    if (!response.ok) {
      checks.push(failure("completion", await httpDetail(response), true));
    } else {
      const body = await response.json() as ChatResponse;
      const text = textOf(body.choices?.[0]?.message?.content).trim();
      checks.push(text
        ? { name: "completion", status: "ok", detail: `ответ получен (${text.length} знаков)`, blocking: true }
        : failure("completion", "модель вернула пустой ответ", true));
    }
  } catch (error) {
    checks.push(failure("completion", reason(error), true));
  }

  // --- 2. Поток -----------------------------------------------------
  if (!input.claims.streaming) {
    checks.push({ name: "streaming", status: "skipped", detail: "поток не заявлен", blocking: false });
  } else {
    try {
      const response = await call({
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: 32,
        stream: true,
      });
      if (!response.ok) {
        checks.push(failure("streaming", await httpDetail(response), true));
      } else if (!response.body) {
        checks.push(failure("streaming", "провайдер ответил без тела потока", true));
      } else {
        const raw = await response.text();
        // Поток обязан приходить событиями SSE, а не одним телом JSON:
        // ровно это Letta и разбирает.
        const events = raw.split(/\n\n/u).filter((chunk) => chunk.startsWith("data:"));
        const deltas = events.filter((chunk) => !chunk.includes("[DONE]"));
        checks.push(deltas.length > 0
          ? { name: "streaming", status: "ok", detail: `событий потока: ${deltas.length}`, blocking: true }
          : failure("streaming", "ответ пришёл не событиями SSE", true));
      }
    } catch (error) {
      checks.push(failure("streaming", reason(error), true));
    }
  }

  // --- 3. Вызов инструмента и аргументы по схеме --------------------
  let toolCall: { id: string; message: AssistantMessage } | null = null;
  if (!input.claims.tools) {
    checks.push({ name: "tool_call", status: "skipped", detail: "инструменты не заявлены", blocking: false });
    checks.push({ name: "tool_result_loop", status: "skipped", detail: "инструменты не заявлены", blocking: false });
  } else {
    const toolMessages = [{
      role: "user",
      content: "Call the tool evaself_capability_probe with value \"ok\". Do not answer with text.",
    }];
    try {
      // Сначала с принуждением: так проверяется механика вызова, а не
      // склонность модели им пользоваться. Провайдер, который не знает
      // tool_choice, отвечает 4xx — тогда пробуем без него.
      let response = await call({
        messages: toolMessages,
        tools: [PROBE_TOOL],
        tool_choice: { type: "function", function: { name: PROBE_TOOL.function.name } },
        max_tokens: 64,
        stream: false,
      });
      if (response.status >= 400 && response.status < 500) {
        response = await call({ messages: toolMessages, tools: [PROBE_TOOL], max_tokens: 64, stream: false });
      }
      if (!response.ok) {
        checks.push(failure("tool_call", await httpDetail(response), true));
      } else {
        const body = await response.json() as ChatResponse;
        const message = body.choices?.[0]?.message;
        const call0 = message?.tool_calls?.[0];
        if (!call0?.function?.name) {
          checks.push(failure("tool_call", "модель не вызвала инструмент и ответила текстом", true));
        } else if (call0.function.name !== PROBE_TOOL.function.name) {
          checks.push(failure("tool_call", `вызван неизвестный инструмент ${call0.function.name}`, true));
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(call0.function.arguments ?? "");
          } catch {
            parsed = null;
          }
          const value = (parsed as { value?: unknown } | null)?.value;
          if (value !== "ok") {
            // Аргументы инструмента проверяются строго и остаются
            // блокирующими: на них держится весь агентный ход.
            checks.push(failure(
              "tool_call",
              parsed === null
                ? "аргументы инструмента не разбираются как JSON"
                : "аргументы не соответствуют заданной схеме",
              true,
            ));
          } else {
            toolCall = { id: call0.id ?? "probe-call-1", message: message ?? {} };
            checks.push({ name: "tool_call", status: "ok", detail: "вызов и аргументы по схеме", blocking: true });
          }
        }
      }
    } catch (error) {
      checks.push(failure("tool_call", reason(error), true));
    }

    // --- 4. Результат инструмента и завершение цикла -----------------
    if (!toolCall) {
      checks.push(failure("tool_result_loop", "цикл не проверялся: вызова инструмента не было", true));
    } else {
      const accepted = toolCall;
      try {
        const loop = (assistant: unknown): Record<string, unknown> => ({
          messages: [
            ...toolMessages,
            assistant,
            { role: "tool", tool_call_id: accepted.id, content: "{\"echo\":\"ok\"}" },
          ],
          tools: [PROBE_TOOL],
          max_tokens: 64,
          stream: false,
        });
        const echoedFields = REASONING_FIELDS.filter((field) => field in accepted.message);
        let response = await call(loop(echoedAssistant(accepted.message, accepted.id)));
        let trimmed = false;
        if (response.status >= 400 && response.status < 500) {
          // Строгий провайдер может не принять поля собственного ответа.
          // Тогда цикл проверяется в минимальной форме — но проверяется,
          // а не объявляется сломанным.
          trimmed = true;
          response = await call(loop(minimalAssistant(accepted.message, accepted.id)));
        }
        if (!response.ok) {
          checks.push(failure("tool_result_loop", await httpDetail(response), true));
        } else {
          const body = await response.json() as ChatResponse;
          const message = body.choices?.[0]?.message;
          const text = textOf(message?.content).trim();
          const echoedNote = trimmed
            ? " (без служебных полей: провайдер их не принял)"
            : echoedFields.length > 0
              ? ` (провайдеру возвращены поля: ${echoedFields.join(", ")})`
              : "";
          // Модель, которая после результата снова просит инструмент и
          // не отвечает, зациклит ход: цикл не завершён.
          checks.push(text
            ? {
                name: "tool_result_loop",
                status: "ok",
                detail: `результат принят, цикл завершён${echoedNote}`,
                blocking: true,
              }
            : failure(
                "tool_result_loop",
                ((message?.tool_calls?.length ?? 0) > 0
                  ? "после результата модель снова требует инструмент и не отвечает"
                  : "после результата инструмента модель не ответила") + echoedNote,
                true,
              ));
        }
      } catch (error) {
        checks.push(failure("tool_result_loop", reason(error), true));
      }
    }
  }

  // --- 5. Строгий JSON ----------------------------------------------
  //
  // Агентный ход Letta идёт инструментами: строгую форму ответа задаёт
  // схема инструмента, а не `response_format`. Строгий JSON нужен
  // продуктовым маршрутам (`eva/json`, исследование), и его отсутствие
  // делает модель непригодной для них — но не для разговора. Раньше эта
  // проверка была блокирующей и снимала с активации модель, у которой с
  // агентным ходом всё в порядке.
  //
  // Способов два, и провайдеры поддерживают их независимо: свободный
  // `json_object` и Structured Outputs со схемой. Поэтому проверяются
  // оба и классифицируются раздельно.
  if (!input.claims.json) {
    checks.push({ name: "json_object", status: "skipped", detail: "строгий JSON не заявлен", blocking: false });
    checks.push({ name: "json_schema", status: "skipped", detail: "строгий JSON не заявлен", blocking: false });
  } else {
    const parses = (raw: string): unknown | undefined => {
      try {
        return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gu, "")) as unknown;
      } catch {
        return undefined;
      }
    };

    try {
      const response = await call({
        messages: [{ role: "user", content: "Return the JSON object {\"ok\":true} and nothing else." }],
        response_format: { type: "json_object" },
        max_tokens: 32,
        stream: false,
      });
      if (!response.ok) {
        checks.push(failure(
          "json_object",
          `${await httpDetail(response)} — маршруты строгого JSON недоступны, разговор не затронут`,
          false,
        ));
      } else {
        const body = await response.json() as ChatResponse;
        const text = textOf(body.choices?.[0]?.message?.content).trim();
        checks.push(text && parses(text) !== undefined
          ? { name: "json_object", status: "ok", detail: "ответ разбирается как JSON", blocking: false }
          : failure(
              "json_object",
              "ответ не разбирается как JSON — маршруты строгого JSON недоступны, разговор не затронут",
              false,
            ));
      }
    } catch (error) {
      checks.push(failure("json_object", reason(error), false));
    }

    try {
      const response = await call({
        messages: [{ role: "user", content: "Return an object with field ok set to true." }],
        response_format: { type: "json_schema", json_schema: PROBE_JSON_SCHEMA },
        max_tokens: 32,
        stream: false,
      });
      if (!response.ok) {
        checks.push(failure(
          "json_schema",
          `${await httpDetail(response)} — Structured Outputs не поддержаны`,
          false,
        ));
      } else {
        const body = await response.json() as ChatResponse;
        const text = textOf(body.choices?.[0]?.message?.content).trim();
        const parsed = parses(text) as { ok?: unknown } | undefined;
        checks.push(typeof parsed?.ok === "boolean"
          ? { name: "json_schema", status: "ok", detail: "ответ соответствует переданной схеме", blocking: false }
          : failure("json_schema", "ответ не соответствует переданной схеме", false));
      }
    } catch (error) {
      checks.push(failure("json_schema", reason(error), false));
    }
  }

  // --- 6. Изображения ------------------------------------------------
  // Отдельная проба и намеренно не блокирующая: разговаривать модель
  // умеет и без зрения, а маршрут изображений всё равно выбирает
  // провайдера по `supports_vision`.
  if (!input.claims.vision) {
    checks.push({ name: "vision", status: "skipped", detail: "изображения не заявлены", blocking: false });
  } else {
    try {
      const response = await call({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Reply with the single word: ready" },
            {
              type: "image_url",
              image_url: {
                // Прозрачный PNG 1×1: дешевле изображения не бывает.
                url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            },
          ],
        }],
        max_tokens: 32,
        stream: false,
      });
      if (!response.ok) {
        checks.push({ name: "vision", status: "failed", detail: await httpDetail(response), blocking: false });
      } else {
        const body = await response.json() as ChatResponse;
        const text = textOf(body.choices?.[0]?.message?.content).trim();
        checks.push(text
          ? { name: "vision", status: "ok", detail: "изображение принято", blocking: false }
          : { name: "vision", status: "failed", detail: "пустой ответ на изображение", blocking: false });
      }
    } catch (error) {
      checks.push({ name: "vision", status: "failed", detail: reason(error), blocking: false });
    }
  }

  const failed = checks.filter((entry) => entry.status === "failed");
  const blockers = failed.filter((entry) => entry.blocking);
  const line = (entry: CapabilityCheck): string => `${entry.name}: ${entry.detail}`;
  return {
    ok: blockers.length === 0,
    checks,
    message: blockers.map(line).join("; "),
    warnings: failed.filter((entry) => !entry.blocking).map(line).join("; "),
  };
}
