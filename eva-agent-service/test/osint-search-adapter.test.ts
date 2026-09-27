import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSearchCollector, mentionQuote } from "../dist/osint/collectors.js";
import { OutboundGateway } from "../dist/admin/outbound-gateway.js";
import { SearxCrawlAdapters } from "../dist/research/adapters.js";

function adapter(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const instance = new SearxCrawlAdapters("http://searxng:8080/base", "http://crawl4ai:11235", {
    gateway: {
      request: async (url, init = {}) => {
        calls.push({ url, init });
        return { status: 200, ok: true, headers: new Headers(), body: new Uint8Array(), json: <T>() => body as T };
      },
    },
  });
  return { instance, calls };
}

test("OSINT использует JSON, путь установки и автоопределение языка обычного поиска", async () => {
  const { instance, calls } = adapter({
    results: [{ url: "https://example.org/page", title: "Иван Петров", content: "Публичная статья" }],
    unresponsive_engines: [["google", "CAPTCHA"], "bing: timeout"],
  });
  const page = await instance.searchWithDiagnostics("Иван Петров", new AbortController().signal);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/base/search");
  assert.equal(url.searchParams.get("q"), "Иван Петров");
  assert.equal(url.searchParams.get("language"), null);
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(new Headers(calls[0]!.init.headers).get("accept"), "application/json");
  assert.equal(page.results[0]!.snippet, "Публичная статья");
  assert.deepEqual(page.unresponsiveEngines, ["google: CAPTCHA", "bing: timeout"]);
  assert.deepEqual(await instance.search("Иван Петров", new AbortController().signal), page.results);
});

test("ответ SearXNG неправильной формы не выглядит успешной пустой выдачей", async () => {
  for (const body of [null, {}, { results: "not an array" }]) {
    await assert.rejects(adapter(body).instance.search("test", new AbortController().signal), /searx_invalid_response/);
  }
});

test("шлюз сохраняет отмену исследования вместе со своим таймаутом", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | null | undefined;
  const gateway = new OutboundGateway({
    allowlist: ["searxng"],
    fetcher: (async (_url, init) => {
      seen = init?.signal;
      controller.abort();
      seen?.throwIfAborted();
      throw new Error("abort was ignored");
    }) as typeof fetch,
  });
  await assert.rejects(gateway.request("http://searxng:8080/search", { signal: controller.signal }), { name: "AbortError" });
  assert.ok(seen);
});

const signal = () => new AbortController().signal;

test("форматирование телефона, ё/е и пробелы не теряют дословное доказательство", () => {
  for (const [text, variant] of [
    ["Контакт +7 (912) 345–67–89", "+79123456789"],
    ["Семён\u00a0Петров", "Семен Петров"],
    ["Иван\nПетров", "Иван Петров"],
  ]) {
    const evidence = mentionQuote(text!, [variant!]);
    assert.ok(evidence?.kind === "quote" && text!.includes(evidence.quote));
  }
  assert.equal(mentionQuote("Телефон 1791234567890", ["79123456789"]), null);
  assert.equal(mentionQuote("aliceother@example.com", ["alice"]), null);
  assert.equal(mentionQuote("Иван Петровский", ["Иван Петров"]), null);
});

test("пустота из-за отказавших движков помечается деградацией; находки сохраняются", async () => {
  for (const found of [false, true]) {
    const access = {
      search: async () => { throw new Error("use diagnostics"); },
      searchWithDiagnostics: async () => ({
        results: found ? [{ url: "https://example.org/page", title: "Иван Петров" }] : [],
        unresponsiveEngines: ["google: CAPTCHA"],
      }),
      read: async () => { throw new Error("must not read"); },
    };
    const output = await new WebSearchCollector(access, { queriesPerIdentifier: 1, pagesPerIdentifier: 1, maxPageBytes: 1000 })
      .collect({ target: { identifierId: "i", type: "name", normalized: "иван петров", depth: 0 }, signal: signal(), remainingRequests: 1 });
    assert.equal(output.status, "degraded");
    assert.equal(output.sources.length, found ? 1 : 0);
    assert.equal(output.externalRequests, 1);
  }
});

