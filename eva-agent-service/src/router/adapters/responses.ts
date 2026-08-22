/** OpenAI Responses API adapter. Opaque output items survive tool roundtrips. */
import type { LlmRequest, LlmResponse, LlmToolCall, ProviderAdapter, ProviderProfile } from "../types.js";
import { ProviderError } from "../types.js";
import { classifyHttp, readSse } from "./shared.js";

function inputItems(request: LlmRequest): unknown[] {
  const input: unknown[] = [];
  if (request.system_prompt.trim()) input.push({ role: "system", content: request.system_prompt });
  for (const message of request.messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const carried = message.provider_state?.response_items;
      if (Array.isArray(carried)) input.push(...carried);
      if (message.content.trim()) input.push({ role: "assistant", content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

function buildBody(provider: ProviderProfile, request: LlmRequest, stream: boolean) {
  const body: Record<string, unknown> = {
    ...provider.additional_parameters, ...provider.generation_defaults,
    model: provider.model, input: inputItems(request), stream,
    temperature: request.temperature, max_output_tokens: request.max_tokens,
  };
  if (request.tools.length) body.tools = request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
  if (request.response_format) body.text = { format: { type: "json_object" } };
  return body;
}

async function post(provider: ProviderProfile, request: LlmRequest, stream: boolean, signal: AbortSignal) {
  let response: Response;
  try {
    response = await (provider.fetcher ?? fetch)(`${provider.base_url.replace(/\/+$/u, "")}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.api_key}` },
      body: JSON.stringify(buildBody(provider, request, stream)), signal,
    });
  } catch (error) {
    throw new ProviderError(`нет соединения: ${error instanceof Error ? error.message : String(error)}`, "connection_failed", { retryable: true });
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let detail = "";
    try { detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* raw below */ }
    throw classifyHttp(response.status, detail, raw, response.headers.get("retry-after"));
  }
  return response;
}

type OutputItem = Record<string, unknown> & { type?: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ type?: string; text?: string }> };
function parsedOutput(output: OutputItem[]) {
  let content = "";
  const tool_calls: LlmToolCall[] = [];
  const opaque: OutputItem[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content += part.text;
      }
    } else if (item.type === "function_call" && item.name) {
      tool_calls.push({ id: item.call_id ?? `call_${tool_calls.length}`, name: item.name, arguments: item.arguments ?? "{}" });
    } else if (item.type !== "message") opaque.push(item);
  }
  return { content, tool_calls, opaque };
}
function finish(status?: string, incomplete?: string): LlmResponse["finish_reason"] {
  if (status === "incomplete" && incomplete === "max_output_tokens") return "length";
  if (status === "completed") return "stop";
  return "unknown";
}

export const responsesAdapter: ProviderAdapter = {
  protocol: "openai-responses",
  async complete(provider, request, signal) {
    const response = await post(provider, request, false, signal);
    const body = await response.json() as {
      output?: OutputItem[]; output_text?: string; status?: string; model?: string;
      incomplete_details?: { reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const parsed = parsedOutput(body.output ?? []);
    if (!parsed.content && typeof body.output_text === "string") parsed.content = body.output_text;
    const reason = finish(body.status, body.incomplete_details?.reason);
    if (!parsed.content.trim() && !parsed.tool_calls.length && reason !== "length") throw new ProviderError("пустой ответ модели", "empty_response", { retryable: true });
    return {
      content: parsed.content, tool_calls: parsed.tool_calls,
      finish_reason: parsed.tool_calls.length ? "tool_calls" : reason,
      usage: { tokens_in: body.usage?.input_tokens ?? 0, tokens_out: body.usage?.output_tokens ?? 0 },
      model: body.model ?? provider.model,
      ...(parsed.opaque.length ? { provider_state: { response_items: parsed.opaque } } : {}),
    };
  },
  async *stream(provider, request, signal) {
    const response = await post(provider, request, true, signal);
    if (!response.body) throw new ProviderError("поток не открылся", "empty_response", { retryable: true });
    let content = "";
    const calls = new Map<string, LlmToolCall>();
    const opaque: OutputItem[] = [];
    let final: { status?: string; incomplete_details?: { reason?: string }; model?: string; usage?: { input_tokens?: number; output_tokens?: number } } = {};
    for await (const event of readSse(response.body)) {
      let data: { type?: string; delta?: string; item?: OutputItem; output_index?: number; response?: typeof final };
      try { data = JSON.parse(event) as typeof data; } catch { continue; }
      if (data.type === "response.output_text.delta" && data.delta) { content += data.delta; yield { type: "text", delta: data.delta }; }
      if (data.type === "response.output_item.added" && data.item?.type === "function_call") {
        calls.set(String(data.output_index ?? calls.size), { id: data.item.call_id ?? `call_${calls.size}`, name: data.item.name ?? "", arguments: data.item.arguments ?? "" });
      }
      if (data.type === "response.function_call_arguments.delta" && data.delta) {
        const call = calls.get(String(data.output_index ?? 0));
        if (call) call.arguments += data.delta;
      }
      if (data.type === "response.output_item.done" && data.item) {
        if (data.item.type === "function_call") {
          const call = calls.get(String(data.output_index ?? 0));
          if (call?.name) yield { type: "tool_call", call };
        } else if (data.item.type !== "message") {
          opaque.push(data.item);
          yield { type: "provider_state", state: { response_items: [data.item] } };
        }
      }
      if (data.type === "response.completed" || data.type === "response.incomplete") final = data.response ?? final;
    }
    const tool_calls = [...calls.values()].filter((call) => call.name);
    const reason = finish(final.status, final.incomplete_details?.reason);
    if (!content.trim() && !tool_calls.length && reason !== "length") throw new ProviderError("поток закончился без содержимого", "empty_response", { retryable: true });
    yield { type: "done", response: {
      content, tool_calls, finish_reason: tool_calls.length ? "tool_calls" : reason,
      usage: { tokens_in: final.usage?.input_tokens ?? 0, tokens_out: final.usage?.output_tokens ?? 0 },
      model: final.model ?? provider.model,
      ...(opaque.length ? { provider_state: { response_items: opaque } } : {}),
    } };
  },
};
