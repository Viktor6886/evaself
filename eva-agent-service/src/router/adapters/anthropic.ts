/**
 * Адаптер Anthropic-совместимого API (/v1/messages).
 *
 * Отличия от OpenAI, которые приходится снимать здесь:
 *   * system prompt — отдельное поле, а не сообщение с role="system";
 *   * роли только user и assistant, роли "tool" нет — результат инструмента
 *     передаётся блоком tool_result внутри сообщения пользователя;
 *   * содержимое сообщения — массив блоков, а не строка;
 *   * подряд идущие сообщения одной роли приходится склеивать;
 *   * ключ в заголовке x-api-key, а не Authorization;
 *   * строгий JSON задаётся не response_format, а инструкцией.
 */

import type {
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  ProviderAdapter,
  ProviderProfile,
} from "../types.js";
import { ProviderError } from "../types.js";
import { classifyHttp, parameterValue, providerParameters, readSse } from "./shared.js";
import { decodeDataUri } from "../content.js";

const API_VERSION = "2023-06-01";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  /** Блоки размышления возвращаются модели как есть, роутер их не читает. */
  | Record<string, unknown>;

interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

/**
 * Разворачивает внутренние сообщения в формат Anthropic. Результаты
 * инструментов становятся tool_result-блоками сообщения пользователя, что
 * сохраняет уже выполненные вызовы при переключении с OpenAI-провайдера
 * (требование 1.8: не перезапускать успешно выполненные инструменты).
 */
function toWireMessages(request: LlmRequest): WireMessage[] {
  const out: WireMessage[] = [];

  const push = (role: WireMessage["role"], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of request.messages) {
    if (message.role === "system") {
      // Системные сообщения в середине диалога Anthropic не принимает —
      // переносим их в реплику пользователя, не теряя содержимое.
      push("user", [{ type: "text", text: message.content }]);
      continue;
    }
    if (message.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: message.content,
      }]);
      continue;
    }
    const blocks: Block[] = [];
    // Блоки размышления идут первыми: Anthropic требует вернуть их
    // раньше остального содержимого того же сообщения.
    const carried = message.provider_state?.thinking_blocks;
    if (Array.isArray(carried)) blocks.push(...(carried as Block[]));
    if (message.parts) {
      for (const part of message.parts) {
        if (part.type === "text") {
          if (part.text.trim()) blocks.push({ type: "text", text: part.text });
        } else if (part.type === "image") {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: part.media_type, data: part.data },
          });
        } else {
          const decoded = decodeDataUri(part.url);
          blocks.push(decoded
            ? { type: "image", source: { type: "base64", ...decoded } }
            : { type: "image", source: { type: "url", url: part.url } });
        }
      }
    } else if (message.content.trim()) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: safeJson(call.arguments),
      });
    }
    push(message.role === "assistant" ? "assistant" : "user", blocks);
  }

  // Диалог обязан начинаться с пользователя.
  if (out.length > 0 && out[0]!.role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(продолжение)" }] });
  }
  return out;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function buildBody(provider: ProviderProfile, request: LlmRequest, stream: boolean) {
  let system = request.system_prompt.trim();
  if (request.response_format) {
    // response_format здесь нет; контракт задаётся словами, а проверяет его
    // роутер — он же переключит провайдера, если JSON не разобрался.
    system = `${system}\n\nОтвечай строго одним объектом JSON без пояснений и без markdown.`.trim();
    if (request.response_format.type === "json_schema") {
      const schema = request.response_format.json_schema.schema
        ?? request.response_format.json_schema;
      system = `${system}\nJSON Schema результата: ${JSON.stringify(schema)}`;
    }
  }

  const parameters = providerParameters(provider, [
      "contents", "generationConfig", "input", "max_completion_tokens", "max_output_tokens",
      "response_format", "system", "systemInstruction", "tools",
    ]);
  const body: Record<string, unknown> = {
    ...parameters,
    model: provider.model,
    max_tokens: request.max_tokens,
    temperature: parameterValue(parameters, "temperature", request.temperature),
    messages: toWireMessages(request),
    stream,
  };
  if (system) body.system = system;
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return body;
}

async function post(
  provider: ProviderProfile,
  request: LlmRequest,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const url = `${provider.base_url.replace(/\/+$/, "")}/messages`;
  let response: Response;
  try {
    response = await (provider.fetcher ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        "x-api-key": provider.api_key,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(buildBody(provider, request, stream)),
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new ProviderError("превышен таймаут ответа", "timeout", { retryable: true });
    }
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message);
    throw new ProviderError(
      dns ? `имя хоста не разрешается: ${message}` : `нет соединения: ${message}`,
      "connection_failed",
      { retryable: !dns },
    );
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let detail = "";
    try {
      detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      detail = "";
    }
    throw classifyHttp(response.status, detail, raw, response.headers.get("retry-after"));
  }
  return response;
}

function stopReason(raw: string | undefined): LlmResponse["finish_reason"] {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "unknown";
  }
}

export const anthropicAdapter: ProviderAdapter = {
  protocol: "anthropic-compatible",

  async complete(provider, request, signal) {
    const response = await post(provider, request, false, signal);
    const raw = await response.text();
    let body: {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new ProviderError("ответ не разбирается как JSON", "invalid_response", {
        retryable: true,
      });
    }

    let text = "";
    const toolCalls: LlmToolCall[] = [];
    // Блоки размышления не читаются и не показываются — они сохраняются,
    // чтобы вернуть их модели вместе с результатом инструмента.
    const thinking: unknown[] = [];
    for (const block of body.content ?? []) {
      if (block.type === "thinking" || block.type === "redacted_thinking") thinking.push(block);
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      if (block.type === "tool_use" && block.name) {
        toolCalls.push({
          id: block.id ?? `call_${toolCalls.length}`,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    if (!text.trim() && toolCalls.length === 0) {
      throw new ProviderError("пустой ответ модели", "empty_response", { retryable: true });
    }
    return {
      content: text,
      tool_calls: toolCalls,
      finish_reason: stopReason(body.stop_reason),
      usage: {
        tokens_in: body.usage?.input_tokens ?? 0,
        tokens_out: body.usage?.output_tokens ?? 0,
      },
      model: body.model ?? provider.model,
      ...(thinking.length > 0 ? { provider_state: { thinking_blocks: thinking } } : {}),
    };
  },

  async *stream(provider, request, signal) {
    const response = await post(provider, request, true, signal);
    if (!response.body) {
      throw new ProviderError("поток не открылся", "empty_response", { retryable: true });
    }

    let text = "";
    let reason: LlmResponse["finish_reason"] = "unknown";
    let model = provider.model;
    const usage = { tokens_in: 0, tokens_out: 0 };
    // Аргументы tool_use приходят кусками input_json_delta.
    const partial = new Map<number, { id: string; name: string; json: string }>();
    const thinking = new Map<number, Record<string, unknown>>();
    const thinkingBlocks: unknown[] = [];
    const toolCalls: LlmToolCall[] = [];

    for await (const event of readSse(response.body)) {
      let parsed: {
        type?: string;
        index?: number;
        delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
        content_block?: Record<string, unknown> & { type?: string; id?: string; name?: string };
        message?: { model?: string; usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      try {
        parsed = JSON.parse(event);
      } catch {
        continue;
      }

      if (parsed.type === "message_start") {
        model = parsed.message?.model ?? model;
        usage.tokens_in = parsed.message?.usage?.input_tokens ?? usage.tokens_in;
      }
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
        partial.set(parsed.index ?? 0, {
          id: parsed.content_block.id ?? `call_${parsed.index ?? 0}`,
          name: parsed.content_block.name ?? "",
          json: "",
        });
      }
      if (parsed.type === "content_block_start"
        && (parsed.content_block?.type === "thinking" || parsed.content_block?.type === "redacted_thinking")) {
        thinking.set(parsed.index ?? 0, { ...parsed.content_block });
      }
      if (parsed.type === "content_block_delta") {
        if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
          text += parsed.delta.text;
          yield { type: "text", delta: parsed.delta.text };
        }
        if (parsed.delta?.type === "input_json_delta") {
          const current = partial.get(parsed.index ?? 0);
          if (current) current.json += parsed.delta.partial_json ?? "";
        }
        const block = thinking.get(parsed.index ?? 0);
        if (block && parsed.delta?.type === "thinking_delta") {
          block.thinking = String(block.thinking ?? "") + (parsed.delta.thinking ?? "");
        }
        if (block && parsed.delta?.type === "signature_delta") {
          block.signature = String(block.signature ?? "") + (parsed.delta.signature ?? "");
        }
      }
      if (parsed.type === "content_block_stop") {
        const current = partial.get(parsed.index ?? 0);
        if (current?.name) {
          const call = { id: current.id, name: current.name, arguments: current.json || "{}" };
          toolCalls.push(call);
          yield { type: "tool_call", call };
        }
        partial.delete(parsed.index ?? 0);
        const opaque = thinking.get(parsed.index ?? 0);
        if (opaque) {
          thinkingBlocks.push(opaque);
          yield { type: "provider_state", state: { thinking_blocks: [opaque] } };
          thinking.delete(parsed.index ?? 0);
        }
      }
      if (parsed.type === "message_delta") {
        if (parsed.delta?.stop_reason) reason = stopReason(parsed.delta.stop_reason);
        usage.tokens_out = parsed.usage?.output_tokens ?? usage.tokens_out;
      }
    }

    if (!text.trim() && toolCalls.length === 0) {
      throw new ProviderError("поток закончился без содержимого", "empty_response", {
        retryable: true,
      });
    }
    yield {
      type: "done",
      response: {
        content: text,
        tool_calls: toolCalls,
        finish_reason: reason === "unknown" && toolCalls.length ? "tool_calls" : reason,
        usage,
        model,
        ...(thinkingBlocks.length ? { provider_state: { thinking_blocks: thinkingBlocks } } : {}),
      },
    };
  },
};
