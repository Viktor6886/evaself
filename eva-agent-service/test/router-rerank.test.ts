/**
 * Reranker через LLM Router: три формата ответа провайдеров, коды отказа
 * без текста ответа (в нём эхо кандидатов — текст документов человека),
 * маршрут `/rerank` и клиент с метрикой этапа.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeMetrics, resetKnowledgeMetrics } from "../dist/knowledge/metrics.js";
import { LlmRouterClient, LlmRouterError } from "../dist/router/client.js";
import { parseRerankScores, RerankError, RouterReranker } from "../dist/router/rerank.js";
import { createRouterServer } from "../dist/router/server.js";

const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `provider-${id}`,
  protocol: "openai-compatible",
  base_url: `https://${id}.example/v1/`,
  model: "chat-model",
  api_key: `key-${id}`,
  request_timeout_ms: 5_000,
  generation_defaults: {},
  additional_parameters: {},
  ...extra,
});

function reranker(respond: (body: any) => Response | Error, providers = [provider("jina")], timeoutMs?: number) {
  const sent: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url, body, headers: init.headers as Record<string, string> });
    const result = respond(body);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { sent, reranker: new RouterReranker({ providers: async () => providers as never }, { fetch: fetcher, ...(timeoutMs ? { timeoutMs } : {}) }) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("оценки из ответа Jina/Cohere, Voyage и TEI — по индексам кандидатов", () => {
  assert.deepEqual(parseRerankScores({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }, 2), [0.2, 0.9]);
  assert.deepEqual(parseRerankScores({ data: [{ index: 0, relevance_score: 0.4 }] }, 2), [0.4, null]);
  assert.deepEqual(parseRerankScores([{ index: 1, score: 3.5 }, { index: 0, score: -1 }], 2), [-1, 3.5]);
  for (const bad of [{}, { results: [{ index: 5, relevance_score: 1 }] }, { results: [{ index: 0, relevance_score: "x" }] }, { results: [null] }]) {
    assert.throws(() => parseRerankScores(bad, 2), (error: unknown) => error instanceof RerankError && error.code === "rerank_invalid");
  }
});

test("запрос уходит провайдеру реестра по id: /rerank, модель, запрос и кандидаты", async () => {
  const { sent, reranker: subject } = reranker(() => json({ results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.1 }] }));
  const scores = await subject.rerank({ providerId: "jina", model: "jina-reranker-v2" }, "штраф", ["первый", "второй"]);
  assert.deepEqual(scores, [0.7, 0.1]);
  assert.equal(sent[0]!.url, "https://jina.example/v1/rerank");
  assert.deepEqual(sent[0]!.body, { model: "jina-reranker-v2", query: "штраф", documents: ["первый", "второй"] });
  assert.match(String(sent[0]!.headers.authorization ?? sent[0]!.headers.Authorization), /key-jina/);
  assert.deepEqual(await subject.rerank({ providerId: "jina", model: "m" }, "q", []), []);
  assert.equal(sent.length, 1, "пустой список кандидатов не должен уходить провайдеру");
});

test("отказ — код без текста ответа; неизвестный и не OpenAI-совместимый провайдер — свои коды", async () => {
  const echo = "СЕКРЕТНЫЙ ТЕКСТ ДОКУМЕНТА";
  for (const [status, code] of [[401, "rerank_auth"], [404, "rerank_not_found"], [429, "rerank_rate_limited"], [503, "rerank_unavailable"], [400, "rerank_bad_request"]] as const) {
    const { reranker: subject } = reranker(() => json({ error: echo }, status));
    await assert.rejects(subject.rerank({ providerId: "jina", model: "m" }, "q", ["a"]), (error: unknown) => {
      assert.ok(error instanceof RerankError);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(echo), "текст ответа провайдера попал в сообщение");
      return true;
    });
  }
  const garbage = reranker(() => new Response(`<html>${echo}</html>`, { status: 200 }));
  await assert.rejects(garbage.reranker.rerank({ providerId: "jina", model: "m" }, "q", ["a"]), (error: unknown) =>
    error instanceof RerankError && error.code === "rerank_invalid" && !error.message.includes(echo));
  const network = reranker(() => new Error(`connect ECONNREFUSED ${echo}`));
  await assert.rejects(network.reranker.rerank({ providerId: "jina", model: "m" }, "q", ["a"]), (error: unknown) =>
    error instanceof RerankError && error.code === "rerank_unavailable" && !error.message.includes(echo));
  const missing = reranker(() => json({}));
  await assert.rejects(missing.reranker.rerank({ providerId: "nope", model: "m" }, "q", ["a"]), /не найден/);
  const anthropic = reranker(() => json({}), [provider("a", { protocol: "anthropic-compatible" })]);
  await assert.rejects(anthropic.reranker.rerank({ providerId: "a", model: "m" }, "q", ["a"]), (error: unknown) =>
    error instanceof RerankError && error.code === "rerank_protocol_unsupported");
});

test("провайдер, который не ответил вовремя, — rerank_timeout", async () => {
  const fetcher = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  const subject = new RouterReranker({ providers: async () => [provider("jina")] as never }, { fetch: fetcher, timeoutMs: 20 });
  await assert.rejects(subject.rerank({ providerId: "jina", model: "m" }, "q", ["a"]), (error: unknown) =>
    error instanceof RerankError && error.code === "rerank_timeout");
});

function routerApp(rerank?: RouterReranker) {
  return createRouterServer({
    apiKey: "router-key",
    logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
    store: { providers: async () => [], breakers: async () => new Map(), routes: async () => new Map(), chains: async () => new Map() } as never,
    router: {} as never,
    ...(rerank ? { reranker: rerank } : {}),
  });
}

test("маршрут /rerank: ключ, проверка входа, оценки по порядку; отказ провайдера — 502 с кодом", async () => {
  const headers = { authorization: "Bearer router-key" };
  const { reranker: subject } = reranker(() => json({ results: [{ index: 1, relevance_score: 0.8 }] }));
  const app = routerApp(subject);
  const payload = { provider_id: "jina", model: "m", query: "штраф", documents: ["a", "b"] };

  assert.equal((await app.inject({ method: "POST", url: "/rerank", payload })).statusCode, 401);
  const good = await app.inject({ method: "POST", url: "/rerank", headers, payload });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().results, [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 0.8 }]);

  for (const bad of [
    { ...payload, documents: [] },
    { ...payload, documents: new Array(65).fill("a") },
    { ...payload, documents: ["x".repeat(8_001)] },
    { ...payload, documents: [1] },
    { ...payload, query: "  " },
    { ...payload, provider_id: undefined },
  ]) {
    assert.equal((await app.inject({ method: "POST", url: "/rerank", headers, payload: bad })).statusCode, 400);
  }

  const failing = routerApp(reranker(() => json({ error: "эхо" }, 429)).reranker);
  const refused = await failing.inject({ method: "POST", url: "/rerank", headers, payload });
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json().error.type, "rerank_rate_limited");
  assert.ok(!refused.body.includes("эхо"));

  assert.equal((await routerApp().inject({ method: "POST", url: "/rerank", headers, payload })).statusCode, 503);
});

test("клиент роутера: оценки по кандидатам, отказ — код роутера; задержка и отказы в метрике rerank", async () => {
  resetKnowledgeMetrics();
  const calls: Array<{ url: string; body: any }> = [];
  let reply: Response = json({ results: [{ index: 0, relevance_score: 0.3 }, { index: 1, relevance_score: null }] });
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return reply;
  }) as typeof fetch;
  const client = new LlmRouterClient("http://llm-router:8073/", "key", fetcher);
  const request = { providerId: "jina", model: "m", query: "q", documents: ["a", "b"] };

  assert.deepEqual(await client.rerank(request), [0.3, null]);
  assert.equal(calls[0]!.url, "http://llm-router:8073/rerank");
  assert.deepEqual(calls[0]!.body, { provider_id: "jina", model: "m", query: "q", documents: ["a", "b"] });

  reply = json({ error: { type: "rerank_auth", message: "эхо" } }, 502);
  await assert.rejects(client.rerank(request), (error: unknown) => error instanceof LlmRouterError && error.code === "rerank_auth");
  reply = json({ results: [{ index: 7, relevance_score: 1 }] });
  await assert.rejects(client.rerank(request), /rerank_invalid/);

  const stage = knowledgeMetrics().stages.find((row) => row.name === "rerank")!;
  assert.equal(stage.count, 3);
  assert.equal(stage.errors, 2);
  assert.deepEqual(await client.rerank({ ...request, documents: [] }), []);
  assert.equal(calls.length, 3, "пустой список не должен уходить в роутер");
});
