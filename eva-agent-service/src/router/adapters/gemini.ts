/** Native Gemini generateContent adapter. Model selection is configuration-driven. */
import type {
  LlmRequest, LlmResponse, LlmToolCall, ProviderAdapter, ProviderProfile,
} from "../types.js";
import { ProviderError } from "../types.js";
import { classifyHttp, readSse } from "./shared.js";
import { decodeDataUri } from "../content.js";

type GeminiPart = Record<string, unknown> & {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
};

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return {}; }
}

function toolName(request: LlmRequest, id: string, explicit?: string): string {
  if (explicit) return explicit;
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const found = request.messages[index]?.tool_calls?.find((call) => call.id === id);
    if (found) return found.name;
  }
  return "tool";
}

function toContents(request: LlmRequest) {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  const push = (role: "user" | "model", parts: GeminiPart[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of request.messages) {
    if (message.role === "system") {
      push("user", [{ text: message.content }]);
      continue;
    }
    if (message.role === "tool") {
      const name = toolName(request, message.tool_call_id ?? "", message.name);
      push("user", [{ functionResponse: { name, response: safeJson(message.content) } }]);
      continue;
    }
    const parts: GeminiPart[] = [];
    const carried = message.provider_state?.gemini_parts;
    const carriedParts = Array.isArray(carried) ? carried as GeminiPart[] : [];
    if (message.parts) {
      for (const part of message.parts) {
        if (part.type === "text") parts.push({ text: part.text });
        else if (part.type === "image") parts.push({ inlineData: { mimeType: part.media_type, data: part.data } });
        else {
          const decoded = decodeDataUri(part.url);
          parts.push(decoded
            ? { inlineData: { mimeType: decoded.media_type, data: decoded.data } }
            : { fileData: { fileUri: part.url } });
        }
      }
    } else if (message.content.trim()) parts.push({ text: message.content });
    for (const call of message.tool_calls ?? []) {
      const opaque = carriedParts.find((part) => part.functionCall?.name === call.name);
      parts.push({ ...(opaque ?? {}), functionCall: { name: call.name, args: safeJson(call.arguments) } });
    }
    for (const opaque of carriedParts) {
      if (!opaque.functionCall) parts.unshift(opaque);
    }
    push(message.role === "assistant" ? "model" : "user", parts);
  }
  return contents;
}

function buildBody(provider: ProviderProfile, request: LlmRequest) {
  const body: Record<string, unknown> = {
    ...provider.additional_parameters,
    ...provider.generation_defaults,
    contents: toContents(request),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.max_tokens,
      ...(request.response_format ? { responseMimeType: "application/json" } : {}),
      ...(request.response_format?.type === "json_schema"
        ? { responseJsonSchema: request.response_format.json_schema.schema ?? request.response_format.json_schema }
        : {}),
    },
  };
  if (request.system_prompt.trim()) body.systemInstruction = { parts: [{ text: request.system_prompt }] };
  if (request.tools.length) {
    body.tools = [{ functionDeclarations: request.tools.map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    })) }];
  }
  return body;
}

async function post(provider: ProviderProfile, request: LlmRequest, stream: boolean, signal: AbortSignal) {
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${provider.base_url.replace(/\/+$/u, "")}/models/${encodeURIComponent(provider.model)}:${method}`;
  let response: Response;
  try {
    response = await (provider.fetcher ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": provider.api_key },
      body: JSON.stringify(buildBody(provider, request)), signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`нет соединения: ${message}`, "connection_failed", { retryable: true });
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let detail = "";
    try { detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* raw below */ }
    throw classifyHttp(response.status, detail, raw, response.headers.get("retry-after"));
  }
  return response;
}

function finishReason(raw?: string): LlmResponse["finish_reason"] {
  if (raw === "MAX_TOKENS") return "length";
  if (raw === "SAFETY" || raw === "BLOCKLIST" || raw === "PROHIBITED_CONTENT") return "content_filter";
  if (raw === "STOP") return "stop";
  return "unknown";
}

function parseCandidate(candidate: { content?: { parts?: GeminiPart[] }; finishReason?: string }) {
  let content = "";
  const tool_calls: LlmToolCall[] = [];
  const opaque: GeminiPart[] = [];
  for (const part of candidate.content?.parts ?? []) {
    if (typeof part.text === "string" && part.thought !== true) content += part.text;
    if (part.functionCall?.name) {
      tool_calls.push({
        id: `call_${tool_calls.length}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
    if (part.thought === true || part.thoughtSignature !== undefined) opaque.push(part);
  }
  return { content, tool_calls, finish_reason: finishReason(candidate.finishReason), opaque };
}

export const geminiAdapter: ProviderAdapter = {
  protocol: "gemini-compatible",
  async complete(provider, request, signal) {
    const response = await post(provider, request, false, signal);
    const body = await response.json() as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      modelVersion?: string;
    };
    const parsed = parseCandidate(body.candidates?.[0] ?? {});
    if (!parsed.content.trim() && !parsed.tool_calls.length && parsed.finish_reason !== "length") {
      throw new ProviderError("пустой ответ модели", "empty_response", { retryable: true });
    }
    return {
      content: parsed.content, tool_calls: parsed.tool_calls,
      finish_reason: parsed.tool_calls.length ? "tool_calls" : parsed.finish_reason,
      usage: { tokens_in: body.usageMetadata?.promptTokenCount ?? 0, tokens_out: body.usageMetadata?.candidatesTokenCount ?? 0 },
      model: body.modelVersion ?? provider.model,
      ...(parsed.opaque.length ? { provider_state: { gemini_parts: parsed.opaque } } : {}),
    };
  },
  async *stream(provider, request, signal) {
    const response = await post(provider, request, true, signal);
    if (!response.body) throw new ProviderError("поток не открылся", "empty_response", { retryable: true });
    let content = "";
    let reason: LlmResponse["finish_reason"] = "unknown";
    const tool_calls: LlmToolCall[] = [];
    const opaque: GeminiPart[] = [];
    let usage = { tokens_in: 0, tokens_out: 0 };
    for await (const event of readSse(response.body)) {
      let body: { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      try { body = JSON.parse(event) as typeof body; } catch { continue; }
      const parsed = parseCandidate(body.candidates?.[0] ?? {});
      reason = parsed.finish_reason === "unknown" ? reason : parsed.finish_reason;
      usage = { tokens_in: body.usageMetadata?.promptTokenCount ?? usage.tokens_in, tokens_out: body.usageMetadata?.candidatesTokenCount ?? usage.tokens_out };
      if (parsed.content) { content += parsed.content; yield { type: "text", delta: parsed.content }; }
      if (parsed.opaque.length) {
        opaque.push(...parsed.opaque);
        yield { type: "provider_state", state: { gemini_parts: parsed.opaque } };
      }
      for (const call of parsed.tool_calls) {
        const normalized = { ...call, id: `call_${tool_calls.length}` };
        tool_calls.push(normalized);
        yield { type: "tool_call", call: normalized };
      }
    }
    if (!content.trim() && !tool_calls.length && reason !== "length") {
      throw new ProviderError("поток закончился без содержимого", "empty_response", { retryable: true });
    }
    yield { type: "done", response: {
      content, tool_calls, finish_reason: tool_calls.length ? "tool_calls" : reason,
      usage, model: provider.model,
      ...(opaque.length ? { provider_state: { gemini_parts: opaque } } : {}),
    } };
  },
};
