import assert from "node:assert/strict";
import test from "node:test";

import {
  ResearchOrchestrator,
  canonicalizeUrl,
  relevanceScore,
} from "../dist/research/orchestrator.js";
import { parseFacts, parseQueries, FACTS_INSTRUCTION } from "../dist/research/schema.js";
import { structuredStrict } from "../dist/knowledge/structured-output.js";

const LIMITS = {
  maxQueries: 3,
  maxSources: 4,
  maxPagesPerDomain: 2,
  timeoutMs: 5_000,
  tokenBudget: 100_000,
  maxPageBytes: 100_000,
  maxConcurrency: 2,
};

function orchestrator(overrides: Record<string, unknown> = {}, limits = LIMITS) {
  const saved: unknown[] = [];
  const dependencies = {
    plan: async (query: string) => [query, `${query} 2`, `${query} 3`],
    search: async () => [{ url: "https://a.test/1", title: "one" }],
    read: async (url: string) => ({ url, content: "Факт: в Перми +18.", title: "Пермь" }),
    extract: async () => [{ claim: "в Перми +18", evidence: "Факт: в Перми +18." }],
    save: async (report: unknown) => { saved.push(report); },
    ...overrides,
  };
  return {
    saved,
    run: async () => await new ResearchOrchestrator(dependencies as never, limits).run({
      userId: 1,
      conversationId: "c",
      query: "погода в Перми",
      signal: new AbortController().signal,
    }),
  };
}

test("адрес канонизируется: метки рассылки и хвостовой слэш не создают дублей", () => {
  assert.equal(
    canonicalizeUrl("https://WWW.Example.org/news/?utm_source=mail&b=2&a=1#top"),
    "https://example.org/news?a=1&b=2",
  );
  assert.equal(canonicalizeUrl("https://example.org/news/"), "https://example.org/news");
  assert.equal(canonicalizeUrl("file:///etc/passwd"), null);
  assert.equal(canonicalizeUrl("не адрес"), null);
});

test("конкретный город не подменяется соседним", () => {
  const perm = { url: "https://pogoda.test/perm", title: "Погода в Перми сегодня" };
  const kazan = { url: "https://pogoda.test/kazan", title: "Погода в Казани сегодня" };
  assert.ok(
    relevanceScore("погода в Перми", perm) > relevanceScore("погода в Перми", kazan),
    "чужой город получил тот же счёт, что и запрошенный",
  );
});

test("дубли отбрасываются до лимита источников, а не после", async () => {
  // Раньше выдача сначала обрезалась по maxSources, а дубли снимались
  // потом: до чтения доходило вдвое меньше страниц, чем просили.
  const read: string[] = [];
  const probe = orchestrator({
    search: async () => [
      { url: "https://a.test/page?utm_source=x", title: "Пермь" },
      { url: "https://a.test/page", title: "Пермь" },
      { url: "https://b.test/page", title: "Пермь" },
      { url: "https://c.test/page", title: "Пермь" },
    ],
    read: async (url: string) => {
      read.push(url);
      return { url, content: "Факт: в Перми +18.", title: "Пермь" };
    },
  });
  const report = await probe.run();

  assert.deepEqual(read, [
    "https://a.test/page",
    "https://b.test/page",
    "https://c.test/page",
  ]);
  assert.equal(report.sources.length, 3);
});

test("один отказ поиска и одна нечитаемая страница не отменяют разбор", async () => {
  let searchCall = 0;
  const probe = orchestrator({
    search: async () => {
      searchCall += 1;
      if (searchCall === 1) throw new Error("searx_search_failed");
      return [
        { url: `https://a.test/${searchCall}`, title: "Пермь" },
        { url: `https://b.test/${searchCall}`, title: "Пермь" },
      ];
    },
    read: async (url: string) => {
      if (url.includes("b.test")) throw new Error("crawl4ai_read_failed: HTTP 403");
      return { url, content: "Факт: в Перми +18.", title: "Пермь" };
    },
  });

  const report = await probe.run();

  assert.ok(report.sources.length > 0, "разбор остался без источников из-за одного отказа");
  assert.equal(report.issues.searchFailed, 1);
  assert.ok(report.issues.readFailed > 0);
  assert.ok(report.claims.length > 0);
});

test("сорванная схема извлечения не превращается в успешные ноль фактов", async () => {
  const probe = orchestrator({
    extract: async () => { throw new Error("research_schema_invalid"); },
  });

  await assert.rejects(probe.run(), /research_extraction_failed/);
  assert.deepEqual(probe.saved, [], "отчёт без фактов всё-таки сохранён");
});

test("страница без фактов — это законный пустой разбор", async () => {
  const probe = orchestrator({ extract: async () => [] });
  const report = await probe.run();
  assert.deepEqual(report.claims, []);
  assert.equal(report.issues.extractFailed, 0);
  assert.equal(report.confidence, 0);
});

test("ни одной прочитанной страницы — это отказ, а не пустой отчёт", async () => {
  const probe = orchestrator({
    read: async () => { throw new Error("crawl4ai_read_failed"); },
  });
  await assert.rejects(probe.run(), /research_no_sources/);
});

test("схема запроса и схема разбора — одна и та же", async () => {
  // Парсер ждёт объект с полем facts, и ровно его просит инструкция:
  // при response_format=json_object массив верхнего уровня невозможен.
  assert.match(FACTS_INSTRUCTION, /\{"facts": \[/);
  assert.deepEqual(
    parseFacts('{"facts":[{"claim":"а","evidence":"б","contradiction":"в"}]}'),
    [{ claim: "а", evidence: "б", contradiction: "в" }],
  );
  assert.throws(() => parseFacts('[{"claim":"а","evidence":"б"}]'), /research_schema_invalid/);
  assert.throws(() => parseFacts('{"facts":[{"claim":"а"}]}'), /research_schema_invalid/);

  assert.deepEqual(parseQueries('{"queries":["a","b","c"]}', 3), ["a", "b", "c"]);
  assert.throws(() => parseQueries('{"queries":["a"]}', 3), /research_query_plan_invalid/);
});

test("строгий разбор отказывает вслух, а не деградирует молча", async () => {
  let attempts = 0;
  await assert.rejects(
    () => structuredStrict({
      complete: async () => { attempts += 1; return "{}"; },
      parse: parseFacts,
    }, { code: "research_schema_invalid" }),
    /research_schema_invalid/,
  );
  assert.equal(attempts, 2, "попытка починки схемы не выполнялась");
});
