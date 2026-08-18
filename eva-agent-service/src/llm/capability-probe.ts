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
 */

export type CapabilityName =
  | "completion" | "streaming" | "tool_call" | "tool_result_loop" | "json_object" | "vision";

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

/** Один и тот же безобидный запрос: никаких данных пользователя. */
const PROBE_PROMPT = "Reply with the single word: ready";

type Fetcher = typeof fetch;

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
}

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

export async function probeModelCapabilities(
  input: CapabilityProbeInput,
  fetcher: Fetcher = fetch,
): Promise<CapabilityProbeResult> {
  const url = `${input.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  const checks: CapabilityCheck[] = [];

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
        body: JSON.stringify({ model: input.model, temperature: 0, ...body }),
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
      checks.push(failure("completion", `HTTP ${response.status}`, true));
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
      if (!response.ok || !response.body) {
        checks.push(failure("streaming", `HTTP ${response.status}`, true));
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
  let toolCallId: string | null = null;
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
        checks.push(failure("tool_call", `HTTP ${response.status}`, true));
      } else {
        const body = await response.json() as ChatResponse;
        const call0 = body.choices?.[0]?.message?.tool_calls?.[0];
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
            checks.push(failure(
              "tool_call",
              parsed === null
                ? "аргументы инструмента не разбираются как JSON"
                : "аргументы не соответствуют заданной схеме",
              true,
            ));
          } else {
            toolCallId = call0.id ?? "probe-call-1";
            checks.push({ name: "tool_call", status: "ok", detail: "вызов и аргументы по схеме", blocking: true });
          }
        }
      }
    } catch (error) {
      checks.push(failure("tool_call", reason(error), true));
    }

    // --- 4. Результат инструмента и завершение цикла -----------------
    if (!toolCallId) {
      checks.push(failure("tool_result_loop", "цикл не проверялся: вызова инструмента не было", true));
    } else {
      try {
        const response = await call({
          messages: [
            ...toolMessages,
            {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: toolCallId,
                type: "function",
                function: { name: PROBE_TOOL.function.name, arguments: "{\"value\":\"ok\"}" },
              }],
            },
            { role: "tool", tool_call_id: toolCallId, content: "{\"echo\":\"ok\"}" },
          ],
          tools: [PROBE_TOOL],
          max_tokens: 64,
          stream: false,
        });
        if (!response.ok) {
          checks.push(failure("tool_result_loop", `HTTP ${response.status}`, true));
        } else {
          const body = await response.json() as ChatResponse;
          const message = body.choices?.[0]?.message;
          const text = textOf(message?.content).trim();
          // Модель, которая после результата снова просит инструмент и
          // не отвечает, зациклит ход: цикл не завершён.
          checks.push(text
            ? { name: "tool_result_loop", status: "ok", detail: "результат принят, цикл завершён", blocking: true }
            : failure(
                "tool_result_loop",
                (message?.tool_calls?.length ?? 0) > 0
                  ? "после результата модель снова требует инструмент и не отвечает"
                  : "после результата инструмента модель не ответила",
                true,
              ));
        }
      } catch (error) {
        checks.push(failure("tool_result_loop", reason(error), true));
      }
    }
  }

  // --- 5. Строгий JSON ----------------------------------------------
  if (!input.claims.json) {
    checks.push({ name: "json_object", status: "skipped", detail: "строгий JSON не заявлен", blocking: false });
  } else {
    try {
      const response = await call({
        messages: [{ role: "user", content: "Return the JSON object {\"ok\":true} and nothing else." }],
        response_format: { type: "json_object" },
        max_tokens: 32,
        stream: false,
      });
      if (!response.ok) {
        checks.push(failure("json_object", `HTTP ${response.status}`, true));
      } else {
        const body = await response.json() as ChatResponse;
        const text = textOf(body.choices?.[0]?.message?.content).trim();
        let parsed = true;
        try {
          JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gu, ""));
        } catch {
          parsed = false;
        }
        checks.push(parsed && text
          ? { name: "json_object", status: "ok", detail: "ответ разбирается как JSON", blocking: true }
          : failure("json_object", "ответ не разбирается как JSON", true));
      }
    } catch (error) {
      checks.push(failure("json_object", reason(error), true));
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
        checks.push({ name: "vision", status: "failed", detail: `HTTP ${response.status}`, blocking: false });
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

  const blockers = checks.filter((entry) => entry.status === "failed" && entry.blocking);
  return {
    ok: blockers.length === 0,
    checks,
    message: blockers.length === 0
      ? ""
      : blockers.map((entry) => `${entry.name}: ${entry.detail}`).join("; "),
  };
}
