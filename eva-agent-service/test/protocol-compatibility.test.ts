import assert from "node:assert/strict";
import test from "node:test";

import { anthropicAdapter } from "../dist/router/adapters/anthropic.js";
import { geminiAdapter } from "../dist/router/adapters/gemini.js";
import { openAiAdapter } from "../dist/router/adapters/openai.js";
import { responsesAdapter } from "../dist/router/adapters/responses.js";
import { createRouterServer } from "../dist/router/server.js";

const TOOL = { name: "lookup", description: "lookup", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } };
const request = (messages: unknown[], tools = [TOOL]) => ({
  messages, system_prompt: "You are EVE.", tools, temperature: 0,
  max_tokens: 4_096, stream: false, response_format: null,
  metadata: { request_id: "r1", user_id: null, agent_id: "a1", route: "chat", sensitive: false },
});
const profile = (protocol: string, fetcher: typeof fetch) => ({
  id: "p", name: "p", protocol, base_url: "https://provider.invalid/v1beta", model: "arbitrary-model-id", api_key: "k",
  connect_timeout_ms: 1_000, request_timeout_ms: 1_000, max_retries: 0, max_concurrency: 1,
  max_rpm: null, max_tpm: null, context_window: 32_768, max_output_tokens: 8_192, max_latency_ms: null,
  supports_tools: true, supports_json: true, supports_vision: false, supports_streaming: true,
  quality_tier: 1, sensitive_data_allowed: true, price_in_micro: 0, price_out_micro: 0,
  daily_budget_micro: null, monthly_budget_micro: null, generation_defaults: {}, additional_parameters: {}, fetcher,
});

test("Gemini native functionCall/functionResponse сохраняет thoughtSignature", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const hasResult = contents.some((entry) => entry.parts.some((part) => part.functionResponse));
    return new Response(JSON.stringify(hasResult ? {
      candidates: [{ content: { parts: [{ text: "FINAL_OK" }] }, finishReason: "STOP" }],
    } : {
      candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "opaque-signature" }] }, finishReason: "STOP" }],
    }), { status: 200 });
  };
  const provider = profile("gemini-compatible", fetcher as typeof fetch);
  const first = await geminiAdapter.complete(provider as never, request([{ role: "user", content: "lookup x" }]) as never, AbortSignal.timeout(1_000));
  assert.equal(first.tool_calls[0]?.name, "lookup");
  assert.deepEqual(first.provider_state?.gemini_parts, [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "opaque-signature" }]);
  const second = await geminiAdapter.complete(provider as never, request([
    { role: "user", content: "lookup x" },
    { role: "assistant", content: "", tool_calls: first.tool_calls, provider_state: first.provider_state },
    { role: "tool", content: '{"value":"x"}', tool_call_id: first.tool_calls[0]?.id, name: "lookup" },
  ]) as never, AbortSignal.timeout(1_000));
  assert.equal(second.content, "FINAL_OK");
  assert.match(JSON.stringify(bodies[1]), /opaque-signature/);
  assert.match(JSON.stringify(bodies[1]), /functionResponse/);
});

test("Anthropic tool_use/tool_result возвращает thinking block без изменений", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const thinking = { type: "thinking", thinking: "opaque", signature: "sig" };
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const messages = body.messages as Array<{ content: Array<{ type?: string }> }>;
    const hasResult = messages.some((entry) => entry.content.some((part) => part.type === "tool_result"));
    return new Response(JSON.stringify(hasResult ? {
      content: [{ type: "text", text: "FINAL_OK" }], stop_reason: "end_turn",
    } : {
      content: [thinking, { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }], stop_reason: "tool_use",
    }), { status: 200 });
  };
  const provider = profile("anthropic-compatible", fetcher as typeof fetch);
  const first = await anthropicAdapter.complete(provider as never, request([{ role: "user", content: "lookup x" }]) as never, AbortSignal.timeout(1_000));
  const second = await anthropicAdapter.complete(provider as never, request([
    { role: "user", content: "lookup x" },
    { role: "assistant", content: "", tool_calls: first.tool_calls, provider_state: first.provider_state },
    { role: "tool", content: "x", tool_call_id: "toolu_1", name: "lookup" },
  ]) as never, AbortSignal.timeout(1_000));
  assert.equal(second.content, "FINAL_OK");
  assert.deepEqual(first.provider_state?.thinking_blocks, [thinking]);
  assert.match(JSON.stringify(bodies[1]), /"thinking":"opaque"/);
  assert.match(JSON.stringify(bodies[1]), /tool_result/);
});

test("OpenAI-compatible streaming переносит reasoning state до tool call", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "opaque-", tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { reasoning_content: "state", tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const fetcher = async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
  const provider = profile("openai-compatible", fetcher as typeof fetch);
  const chunks = [];
  for await (const chunk of openAiAdapter.stream(provider as never, { ...request([{ role: "user", content: "lookup" }]), stream: true } as never, AbortSignal.timeout(1_000))) chunks.push(chunk);
  const states = chunks.filter((chunk) => chunk.type === "provider_state");
  const call = chunks.find((chunk) => chunk.type === "tool_call");
  const done = chunks.find((chunk) => chunk.type === "done");
  assert.deepEqual(states.map((chunk) => chunk.state), [{ reasoning_content: "opaque-" }, { reasoning_content: "state" }]);
  assert.equal(call?.call.arguments, '{"q":"x"}');
  assert.equal(done?.response.provider_state?.reasoning_content, "opaque-state");
});

test("OpenAI SSE facade отдаёт opaque state дельтой без изменений", async () => {
  const opaque = [{ type: "reasoning.encrypted", data: "ciphertext", index: 0 }];
  const router = {
    stream: async function* () {
      yield { type: "provider_state", state: { reasoning_details: opaque } };
      yield { type: "tool_call", call: { id: "c1", name: "lookup", arguments: '{"q":"x"}' } };
      yield { type: "done", response: {
        content: "", tool_calls: [{ id: "c1", name: "lookup", arguments: '{"q":"x"}' }],
        finish_reason: "tool_calls", usage: { tokens_in: 1, tokens_out: 1 }, model: "route-model",
        provider_state: { reasoning_details: opaque },
      } };
    },
  };
  const app = createRouterServer({
    router: router as never,
    store: { routes: async () => new Map(), providers: async () => [], breakers: async () => new Map() } as never,
    logger: { debug() {}, info() {}, warn() {}, error() {} }, apiKey: "router-key",
  });
  const response = await app.inject({
    method: "POST", url: "/chat/completions",
    headers: { authorization: "Bearer router-key" },
    payload: { model: "eva/chat", messages: [{ role: "user", content: "lookup" }], tools: [{ type: "function", function: TOOL }], stream: true },
  });
  await app.close();
  assert.equal(response.statusCode, 200);
  const events = response.body.split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events[0].choices[0].delta.reasoning_details, opaque);
  assert.equal(events[1].choices[0].delta.tool_calls[0].function.name, "lookup");
  assert.equal(events[2].choices[0].finish_reason, "tool_calls");
});

test("Responses API переносит encrypted reasoning item через function_call_output", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" };
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const input = body.input as Array<{ type?: string }>;
    const hasResult = input.some((item) => item.type === "function_call_output");
    return new Response(JSON.stringify(hasResult ? {
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "FINAL_OK" }] }],
    } : {
      status: "completed", output: [reasoning, { type: "function_call", call_id: "c1", name: "lookup", arguments: '{"q":"x"}' }],
    }), { status: 200 });
  };
  const provider = profile("openai-responses", fetcher as typeof fetch);
  const first = await responsesAdapter.complete(provider as never, request([{ role: "user", content: "lookup" }]) as never, AbortSignal.timeout(1_000));
  const second = await responsesAdapter.complete(provider as never, request([
    { role: "user", content: "lookup" },
    { role: "assistant", content: "", tool_calls: first.tool_calls, provider_state: first.provider_state },
    { role: "tool", content: "x", tool_call_id: "c1", name: "lookup" },
  ]) as never, AbortSignal.timeout(1_000));
  assert.equal(second.content, "FINAL_OK");
  assert.deepEqual(first.provider_state?.response_items, [reasoning]);
  assert.match(JSON.stringify(bodies[1]), /ciphertext/);
  assert.match(JSON.stringify(bodies[1]), /function_call_output/);
});
