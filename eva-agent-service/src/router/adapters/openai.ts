/**
 * Адаптер OpenAI-совместимого API (/chat/completions).
 *
 * Сюда попадают и сам OpenAI, и LM Studio, и большинство прокси: формат
 * один, различия в мелочах, которые снимает normalize.ts.
 */

import type {
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  ProviderAdapter,
  ProviderProfile,
} from "../types.js";
import { ProviderError } from "../types.js";
import { ReasoningStripper, stripReasoning } from "../normalize.js";
import { classifyHttp, readSse } from "./shared.js";

interface OpenAiChoiceMessage {
  content?: string | null;
  // Reasoning-модели кладут ход мыслей сюда. Объявлено явно, чтобы было
  // видно: поле известно и в content не подмешивается намеренно.
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAiBody {
  choices?: Array<{ message?: OpenAiChoiceMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string; code?: string };
}

function buildBody(provider: ProviderProfile, request: LlmRequest, stream: boolean) {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system_prompt.trim()) {
    messages.push({ role: "system", content: request.system_prompt });
  }
  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      });
      continue;
    }
    const entry: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.tool_calls?.length) {
      entry.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    messages.push(entry);
  }

  const body: Record<string, unknown> = {
    // additional_parameters читались из базы, но в запрос не попадали.
    // Без них оператору нечем отключить размышления у провайдера,
    // который отдаёт их в content: именно сюда кладут
    // chat_template_kwargs.enable_thinking, reasoning.exclude и подобное.
    // Идут первыми — поля ниже задают сам роутер, и переопределять их
    // произвольной настройкой нельзя.
    ...provider.additional_parameters,
    ...provider.generation_defaults,
    model: provider.model,
    messages,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    stream,
  };
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (request.response_format) body.response_format = request.response_format;
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

async function post(
  provider: ProviderProfile,
  request: LlmRequest,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const url = `${provider.base_url.replace(/\/+$/, "")}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify(buildBody(provider, request, stream)),
      signal,
    });
  } catch (error) {
    throw connectionError(error);
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw classifyHttp(
      response.status,
      extractMessage(raw),
      raw,
      response.headers.get("retry-after"),
    );
  }
  return response;
}

function extractMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as OpenAiBody;
    return parsed.error?.message ?? "";
  } catch {
    return "";
  }
}

function connectionError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new ProviderError("превышен таймаут ответа", "timeout", { retryable: true });
  }
  // Недоступный DNS выглядит как обычная сетевая ошибка, но чинить его
  // повтором к тому же хосту бессмысленно — сразу к резерву.
  const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message);
  return new ProviderError(
    dns ? `имя хоста не разрешается: ${message}` : `нет соединения: ${message}`,
    "connection_failed",
    { retryable: !dns },
  );
}

function toolCallsFrom(message: OpenAiChoiceMessage | undefined): LlmToolCall[] {
  return (message?.tool_calls ?? [])
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }))
    .filter((call) => call.name);
}

function finishReason(raw: string | undefined): LlmResponse["finish_reason"] {
  switch (raw) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return raw;
    case "function_call":
      return "tool_calls";
    default:
      return "unknown";
  }
}

export const openAiAdapter: ProviderAdapter = {
  protocol: "openai-compatible",

  async complete(provider, request, signal) {
    const response = await post(provider, request, false, signal);
    const raw = await response.text();
    let body: OpenAiBody;
    try {
      body = JSON.parse(raw) as OpenAiBody;
    } catch {
      throw new ProviderError("ответ не разбирается как JSON", "invalid_response", {
        retryable: true,
      });
    }
    const choice = body.choices?.[0];
    const raw_content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    // Модель, обслуживаемая без reasoning-парсера, присылает <think>…</think>
    // прямо в content. Дальше по течению это уходит в историю conversation
    // и в Telegram — вырезаем на границе.
    const { content } = stripReasoning(raw_content);
    const toolCalls = toolCallsFrom(choice?.message);
    if (!content.trim() && toolCalls.length === 0) {
      // Ответ, состоящий из одного рассуждения, — это не пустой ответ
      // модели, а неверно настроенный провайдер. Различаем в сообщении,
      // иначе оператор будет искать проблему не там.
      throw new ProviderError(
        raw_content.trim()
          ? "модель вернула только рассуждение без ответа: провайдер отдаёт "
            + "ход мыслей в content — отключите thinking или включите "
            + "reasoning-парсер на стороне провайдера"
          : "пустой ответ модели",
        "empty_response",
        { retryable: true },
      );
    }
    return {
      content,
      tool_calls: toolCalls,
      finish_reason: finishReason(choice?.finish_reason),
      usage: {
        tokens_in: body.usage?.prompt_tokens ?? 0,
        tokens_out: body.usage?.completion_tokens ?? 0,
      },
      model: body.model ?? provider.model,
    };
  },

  async *stream(provider, request, signal) {
    const response = await post(provider, request, true, signal);
    if (!response.body) {
      throw new ProviderError("поток не открылся", "empty_response", { retryable: true });
    }

    let text = "";
    // Теги приходят разрезанными между чанками, поэтому очистка потока
    // ведётся с состоянием, а не по каждому дельта-куску отдельно.
    const stripper = new ReasoningStripper();
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage = { tokens_in: 0, tokens_out: 0 };
    let reason: LlmResponse["finish_reason"] = "unknown";
    let model = provider.model;

    for await (const event of readSse(response.body)) {
      if (event === "[DONE]") break;
      let parsed: {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      try {
        parsed = JSON.parse(event);
      } catch {
        continue; // отдельная битая строка потока не рвёт весь ответ
      }
      if (parsed.model) model = parsed.model;
      if (parsed.usage) {
        usage = {
          tokens_in: parsed.usage.prompt_tokens ?? usage.tokens_in,
          tokens_out: parsed.usage.completion_tokens ?? usage.tokens_out,
        };
      }
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) reason = finishReason(choice.finish_reason);

      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        const visible = stripper.push(delta);
        if (visible.length > 0) {
          text += visible;
          yield { type: "text", delta: visible };
        }
      }
      // Аргументы инструмента приходят по кускам и собираются по индексу.
      for (const part of choice?.delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        calls.set(index, {
          id: part.id ?? (current.id || `call_${index}`),
          name: part.function?.name ?? current.name,
          arguments: current.arguments + (part.function?.arguments ?? ""),
        });
      }
    }

    // Хвост, придержанный на случай разрезанного тега.
    const tail = stripper.flush();
    if (tail.length > 0) {
      text += tail;
      yield { type: "text", delta: tail };
    }

    const toolCalls: LlmToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments || "{}" }))
      .filter((call) => call.name);

    if (!text.trim() && toolCalls.length === 0) {
      throw new ProviderError(
        stripper.reasoning()
          ? "поток состоял из одного рассуждения: провайдер отдаёт ход мыслей "
            + "в content — отключите thinking или включите reasoning-парсер"
          : "поток закончился без содержимого",
        "empty_response",
        { retryable: true },
      );
    }
    for (const call of toolCalls) yield { type: "tool_call", call };
    yield {
      type: "done",
      response: {
        content: text,
        tool_calls: toolCalls,
        finish_reason: reason === "unknown" && toolCalls.length ? "tool_calls" : reason,
        usage,
        model,
      },
    };
  },
};
