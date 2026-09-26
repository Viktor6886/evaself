/**
 * Оркестратор OSINT, сборщики и проверки создания исследования.
 *
 * Хранилище здесь — поддельное, в памяти, с теми же уникальными ключами,
 * что у схемы 084: одна строка очереди на идентификатор, один завершённый
 * прогон сборщика на цель. SQL самого хранилища проверяет
 * `scripts/ci/test-osint-repository.mjs` на настоящей базе.
 *
 * Главные проверки — ограничения: бюджет не превышается, по имени нет
 * расширения на профили тёзок, найденный по нику аккаунт не становится
 * аккаунтом человека, а повтор после сбоя не делает работу второй раз.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UsernameProfilesCollector,
  WebSearchCollector,
  mentionQuote,
  type Collector,
  type CollectedSource,
  type CollectorOutput,
  type FrontierItem,
} from "../dist/osint/collectors.js";
import { OsintOrchestrator, accountConfidence, type OsintStore, type RunResult } from "../dist/osint/orchestrator.js";
import { OsintService } from "../dist/osint/service.js";
import { structuredEvidence } from "../dist/osint/evidence.js";
import { DEFAULT_BUDGET } from "../dist/osint/types.js";

type Identifier = { id: string; type: string; normalized: string };

class MemoryStore implements OsintStore {
  status = "queued";
  identifiers = new Map<string, Identifier>();
  frontier = new Map<string, { depth: number; status: string }>();
  runs = new Map<string, { id: string; status: string; requests: number }>();
  sources = new Map<string, CollectedSource>();
  evidence = new Set<string>();
  entities = new Map<string, string>();
  links: Array<{ entityId: string; identifierId: string; confidence: number }> = [];
  claims: Array<{ entityId: string; property: string; value: string; status: string }> = [];
  matches: Array<{ left: string; right: string; status: string }> = [];
  subject = "subject";
  budget = { ...DEFAULT_BUDGET };
  startedAt: number | null = null;
  private seq = 0;

  seed(type: string, normalized: string, depth = 0): string {
    const id = this.identifierId(type, normalized);
    this.frontier.set(id, { depth, status: "pending" });
    return id;
  }
  private identifierId(type: string, normalized: string): string {
    const key = `${type}:${normalized}`;
    if (!this.identifiers.has(key)) this.identifiers.set(key, { id: `id${++this.seq}`, type, normalized });
    return this.identifiers.get(key)!.id;
  }
  async begin() {
    if (!["queued", "processing"].includes(this.status)) return null;
    this.status = "processing";
    this.startedAt ??= Date.now();
    for (const item of this.frontier.values()) if (item.status === "processing") item.status = "pending";
    return { budget: this.budget, subjectEntityId: this.subject, startedAt: this.startedAt };
  }
  async isCancelled() { return this.status !== "processing"; }
  async counters() {
    return {
      externalRequests: [...this.runs.values()].reduce((sum, run) => sum + run.requests, 0),
      identifiers: this.frontier.size,
      entities: this.entities.size + 1,
    };
  }
  async nextFrontier(maxDepth: number): Promise<FrontierItem | null> {
    const pending = [...this.frontier.entries()]
      .filter(([, item]) => item.status === "pending" && item.depth <= maxDepth)
      .sort((left, right) => left[1].depth - right[1].depth);
    const next = pending[0];
    if (!next) return null;
    next[1].status = "processing";
    const identifier = [...this.identifiers.values()].find((item) => item.id === next[0])!;
    return { identifierId: identifier.id, type: identifier.type as FrontierItem["type"], normalized: identifier.normalized, depth: next[1].depth };
  }
  async finishFrontier(id: string, status: "done" | "skipped") { this.frontier.get(id)!.status = status; }
  async startRun(collector: string, identifierId: string) {
    const key = `${collector}:${identifierId}`;
    const existing = this.runs.get(key);
    if (existing && !["running", "failed"].includes(existing.status)) return null;
    const run = { id: `run${++this.seq}`, status: "running", requests: 0 };
    this.runs.set(key, run);
    return run.id;
  }
  async finishRun(runId: string, result: RunResult) {
    const run = [...this.runs.values()].find((item) => item.id === runId)!;
    run.status = result.status;
    run.requests = result.externalRequests;
  }
  async saveSource(collector: string, source: CollectedSource) {
    const key = `${collector}:${source.locator}`;
    this.sources.set(key, source);
    return key;
  }
  async saveEvidence(sourceId: string, evidence: { hash: string }) {
    const key = `${sourceId}:${evidence.hash}`;
    this.evidence.add(key);
    return key;
  }
  async upsertIdentifier(identifier: { type: string; normalized: string }) {
    return this.identifierId(identifier.type, identifier.normalized);
  }
  entitySchemas = new Map<string, string>();
  async upsertEntity(schema: string, caption: string, _identifierId: string, allowCreate: boolean) {
    const key = `${schema}:${caption}`;
    const created = !this.entities.has(key);
    if (created && !allowCreate) return null;
    if (created) {
      this.entities.set(key, `entity${++this.seq}`);
      this.entitySchemas.set(key, schema);
    }
    return { entityId: this.entities.get(key)!, created };
  }
  async linkIdentifier(input: { entityId: string; identifierId: string; confidence: number }) { this.links.push(input); }
  async addClaim(input: { entityId: string; property: string; value: string; status: string }) { this.claims.push(input); }
  async recordMatch(left: string, right: string, decision: { status: string }) {
    this.matches.push({ left, right, status: decision.status });
  }
  async enqueue(identifierId: string, depth: number) {
    if (this.frontier.has(identifierId)) return false;
    this.frontier.set(identifierId, { depth, status: "pending" });
    return true;
  }
  async complete(status: string) {
    if (["queued", "processing"].includes(this.status)) this.status = status;
  }
}

function collector(name: string, types: string[], output: (target: FrontierItem, remaining: number) => CollectorOutput): Collector & { calls: FrontierItem[] } {
  const calls: FrontierItem[] = [];
  return {
    name,
    calls,
    accepts: (type) => types.includes(type),
    reserve: (remaining) => Math.min(remaining, 20),
    collect: async ({ target, remainingRequests }) => {
      calls.push(target);
      return output(target, remainingRequests);
    },
  };
}

const source = (locator: string, findings: CollectedSource["findings"]): CollectedSource => ({
  locator,
  canonicalUrl: locator,
  domain: new URL(locator).hostname,
  tier: "official_profile",
  retrievedAt: "2026-09-26T00:00:00.000Z",
  contentHash: null,
  findings,
});

const account = (url: string, discovered: string[] = []): CollectedSource => {
  const evidence = structuredEvidence({ url });
  return source(url, [
    {
      kind: "account", evidence, site: "Site", url,
      confirmedBy: ["maigret", "whatsmyname"], contradictedBy: [], unverifiedBy: [],
      properties: [{ property: "name", value: "Alice" }],
    },
    ...discovered.map((username) => ({
      kind: "discovered" as const, evidence, owner: url,
      identifier: { type: "username" as const, raw: username, normalized: username },
    })),
  ]);
};

test("расширение идёт по найденным идентификаторам, но не глубже бюджета", async () => {
  const store = new MemoryStore();
  store.budget = { ...DEFAULT_BUDGET, maxDepth: 1 };
  store.seed("username", "alice");
  const profiles = collector("maigret", ["username"], (target) => ({
    status: "succeeded",
    externalRequests: 10,
    sources: [account(`https://site.example/${target.normalized}`, [`${target.normalized}_x`])],
  }));
  const summary = await new OsintOrchestrator(store, [profiles]).run(new AbortController().signal);
  assert.equal(summary.status, "completed");
  assert.equal(summary.stoppedBy, "frontier_empty");
  // alice (глубина 0) → alice_x (глубина 1); alice_x_x на глубине 2 уже не встаёт.
  assert.deepEqual(profiles.calls.map((call) => [call.normalized, call.depth]), [["alice", 0], ["alice_x", 1]]);
  assert.equal(store.frontier.size, 2);
  assert.equal(store.status, "completed");
});

test("найденный по нику аккаунт не становится аккаунтом человека", async () => {
  const store = new MemoryStore();
  store.seed("username", "alice");
  const profiles = collector("maigret", ["username"], () => ({
    status: "succeeded", externalRequests: 5, sources: [account("https://site.example/alice")],
  }));
  await new OsintOrchestrator(store, [profiles]).run(new AbortController().signal);
  // Одного совпадения ника resolver-у мало даже для «возможно»: связь
  // не записывается вовсе, а не записывается ложным «отвергнуто».
  assert.deepEqual(store.matches, []);
  assert.equal(store.entities.size, 1);
  // Свойства профиля — утверждения об аккаунте, а не о субъекте.
  assert.ok(store.claims.every((claim) => claim.entityId !== store.subject));
});

test("бюджет внешних запросов останавливает исследование", async () => {
  const store = new MemoryStore();
  store.budget = { ...DEFAULT_BUDGET, maxExternalRequests: 30, maxDepth: 5 };
  store.seed("username", "a0");
  let n = 0;
  const profiles = collector("maigret", ["username"], (_target, remaining) => {
    assert.ok(remaining > 0, "сборщик не запускается без бюджета");
    n += 1;
    return {
      status: "succeeded",
      externalRequests: Math.min(20, remaining),
      sources: [account(`https://site.example/a${n}`, [`a${n}`])],
    };
  });
  const summary = await new OsintOrchestrator(store, [profiles]).run(new AbortController().signal);
  assert.equal(summary.stoppedBy, "budget_requests");
  assert.ok(summary.externalRequests <= 30);
  assert.equal(profiles.calls.length, 2);
});

test("отказ сборщика — отказ прогона, исследование продолжается", async () => {
  const store = new MemoryStore();
  store.seed("username", "alice");
  const broken: Collector = { name: "broken", accepts: () => true, reserve: (remaining) => Math.min(remaining, 7), collect: async () => { throw new Error("boom"); } };
  const web = collector("web_search", ["username"], () => ({
    status: "degraded", degradedReason: "captcha", externalRequests: 2, sources: [],
  }));
  const summary = await new OsintOrchestrator(store, [broken, web]).run(new AbortController().signal);
  assert.equal(summary.status, "completed");
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.degradedRuns, 1);
  assert.equal(web.calls.length, 1);
  // Упавший прогон списывает свою верхнюю границу, а не ноль.
  assert.equal(summary.externalRequests, 7 + 2);
});

test("повтор после сбоя не запускает завершённые прогоны второй раз", async () => {
  const store = new MemoryStore();
  store.seed("username", "alice");
  store.seed("email", "alice@example.com");
  let crash = true;
  const profiles = collector("maigret", ["username"], () => ({
    status: "succeeded", externalRequests: 5, sources: [account("https://site.example/alice")],
  }));
  const mail: Collector & { calls: number } = {
    name: "web_search",
    calls: 0,
    accepts: (type) => type === "email",
    reserve: () => 1,
    collect: async () => {
      mail.calls += 1;
      if (crash) {
        crash = false;
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return { status: "succeeded", externalRequests: 1, sources: [] };
    },
  };
  const controller = new AbortController();
  const aborting: Collector = {
    ...mail,
    collect: async (context) => {
      const result = mail.collect(context);
      controller.abort();
      return await result;
    },
  };
  await assert.rejects(new OsintOrchestrator(store, [profiles, aborting]).run(controller.signal));
  assert.equal(store.status, "processing");
  // Второй заход: username уже обработан, email возвращается в очередь.
  const summary = await new OsintOrchestrator(store, [profiles, mail]).run(new AbortController().signal);
  assert.equal(summary.status, "completed");
  assert.equal(profiles.calls.length, 1);
  assert.equal(mail.calls, 2);
});

test("повтор задания не получает второй срок: время считается от первого захода", async () => {
  const store = new MemoryStore();
  store.seed("username", "alice");
  store.status = "processing";
  store.startedAt = Date.now() - DEFAULT_BUDGET.maxRuntimeMs - 1;
  const profiles = collector("maigret", ["username"], () => ({ status: "succeeded", externalRequests: 1, sources: [] }));
  const summary = await new OsintOrchestrator(store, [profiles]).run(new AbortController().signal);
  assert.equal(summary.stoppedBy, "budget_runtime");
  assert.equal(profiles.calls.length, 0);
});

test("отменённое исследование не продолжается", async () => {
  const store = new MemoryStore();
  store.seed("username", "alice");
  store.seed("username", "bob");
  const profiles = collector("maigret", ["username"], () => {
    store.status = "cancelled";
    return { status: "succeeded", externalRequests: 1, sources: [] };
  });
  const summary = await new OsintOrchestrator(store, [profiles]).run(new AbortController().signal);
  assert.equal(summary.status, "cancelled");
  assert.equal(profiles.calls.length, 1);
  assert.equal(store.status, "cancelled");
});

test("уверенность в аккаунте растёт с независимыми подтверждениями и падает при противоречии", () => {
  const base = { kind: "account" as const, evidence: structuredEvidence({}), site: "s", url: "https://s.example/a", unverifiedBy: [], properties: [] };
  const one = accountConfidence({ ...base, confirmedBy: ["maigret"], contradictedBy: [] });
  const three = accountConfidence({ ...base, confirmedBy: ["maigret", "whatsmyname", "sherlock"], contradictedBy: [] });
  const contradicted = accountConfidence({ ...base, confirmedBy: ["maigret", "whatsmyname"], contradictedBy: ["sherlock"] });
  assert.ok(one < three);
  assert.ok(three <= 0.9);
  assert.ok(contradicted < one);
});

const signal = () => new AbortController().signal;

test("username-сборщик сводит скан с проверкой и не тратит больше бюджета", async () => {
  const calls: Array<{ topSites?: number }> = [];
  const collectorUnderTest = new UsernameProfilesCollector({
    scanUsername: async (_username: string, options: { topSites?: number }) => {
      calls.push(options);
      return {
        collector: "maigret", username: "alice", status: "ok", checked: 40, degraded: {},
        found: [{
          site: "GitHub", url: "https://github.com/alice", tags: [], httpStatus: 200,
          ids: { fullname: "Alice A." }, discoveredUsernames: ["alice_dev"], discoveredLinks: [],
        }],
      };
    },
    verifyProfiles: async () => [
      { source: "whatsmyname", site: "GitHub", profileUrl: "https://github.com/alice", status: "found", reason: null },
    ],
  } as never, { topSites: 300 });
  const output = await collectorUnderTest.collect({
    target: { identifierId: "i", type: "username", normalized: "alice", depth: 0 },
    signal: signal(),
    remainingRequests: 50,
  });
  assert.equal(calls[0]!.topSites, 50);
  // 40 сайтов скана + 1 проверка; на проверку оставалось 10 — хватило.
  assert.equal(output.externalRequests, 41);
  const accountFinding = output.sources[0]!.findings.find((finding) => finding.kind === "account")!;
  assert.deepEqual((accountFinding as { confirmedBy: string[] }).confirmedBy, ["maigret", "whatsmyname"]);
  assert.deepEqual((accountFinding as { properties: unknown[] }).properties, [{ property: "name", value: "Alice A." }]);
  assert.ok(output.sources[0]!.findings.some((finding) => finding.kind === "discovered"));

  const starved = await collectorUnderTest.collect({
    target: { identifierId: "i", type: "username", normalized: "alice", depth: 0 },
    signal: signal(),
    remainingRequests: 5,
  });
  assert.equal(starved.status, "skipped");
  assert.equal(calls.length, 1);
});

function web(pages: Record<string, string>, results: string[]) {
  const reads: string[] = [];
  return {
    reads,
    search: async () => results.map((url) => ({ url, title: url })),
    read: async (url: string) => {
      reads.push(url);
      if (!(url in pages)) throw new Error("404");
      return { url, content: pages[url]!, title: url };
    },
  };
}

test("проверка профилей не выходит за остаток бюджета по обоим наборам правил", async () => {
  const verifyCalls: Array<{ hosts: string[]; sources: readonly string[] }> = [];
  const hosts = ["a", "b", "c"].map((name) => `https://${name}.example/alice`);
  const underTest = new UsernameProfilesCollector({
    scanUsername: async () => ({
      collector: "maigret", username: "alice", status: "ok", checked: 45, degraded: {},
      found: hosts.map((url) => ({ site: url, url, tags: [], httpStatus: 200, ids: {}, discoveredUsernames: [], discoveredLinks: [] })),
    }),
    verifyProfiles: async (_username: string, list: string[], sources: readonly string[]) => {
      verifyCalls.push({ hosts: list, sources });
      return list.flatMap((host) => sources.map((source) => ({
        source, site: host, profileUrl: `https://${host}/alice`, status: "found", reason: null,
      })));
    },
  } as never, { topSites: 300 });
  const output = await underTest.collect({
    target: { identifierId: "i", type: "username", normalized: "alice", depth: 0 },
    signal: signal(),
    remainingRequests: 50,
  });
  // Остаток после скана — 5 запросов: два хоста по два набора правил.
  assert.equal(verifyCalls[0]!.hosts.length, 2);
  assert.ok(output.externalRequests <= 50);
});

test("веб-поиск берёт в источники только страницы с упоминанием и цитирует их дословно", async () => {
  const access = web({
    "https://news.example/a": "Интервью. Иван Петров рассказал о проекте.",
    "https://other.example/b": "Совсем другая страница",
  }, ["https://news.example/a", "https://other.example/b", "https://gone.example/c"]);
  const output = await new WebSearchCollector(access, { queriesPerIdentifier: 2, pagesPerIdentifier: 3, maxPageBytes: 100_000 })
    .collect({ target: { identifierId: "i", type: "name", normalized: "иван петров", depth: 0 }, signal: signal(), remainingRequests: 100 });
  assert.equal(output.sources.length, 1);
  const finding = output.sources[0]!.findings[0]!;
  assert.equal(finding.kind, "mention");
  assert.ok("Интервью. Иван Петров рассказал о проекте.".includes((finding.evidence as { quote: string }).quote));
  // По имени расширения нет: профиль тёзки — не след человека.
  assert.ok(output.sources.every((item) => item.findings.every((f) => f.kind !== "discovered")));
});

test("профиль, называющий искомую почту, идёт в расширение", async () => {
  const access = web({ "https://github.com/alice": "Contact: alice@example.com" }, ["https://github.com/alice"]);
  const output = await new WebSearchCollector(access, { queriesPerIdentifier: 1, pagesPerIdentifier: 2, maxPageBytes: 100_000 })
    .collect({ target: { identifierId: "i", type: "email", normalized: "alice@example.com", depth: 0 }, signal: signal(), remainingRequests: 100 });
  const discovered = output.sources[0]!.findings.find((finding) => finding.kind === "discovered");
  assert.equal((discovered as { identifier: { type: string } }).identifier.type, "social_account");
});

test("веб-поиск укладывается в оставшийся бюджет", async () => {
  const access = web({}, ["https://a.example/1", "https://a.example/2", "https://a.example/3"]);
  const output = await new WebSearchCollector(access, { queriesPerIdentifier: 3, pagesPerIdentifier: 4, maxPageBytes: 100_000 })
    .collect({ target: { identifierId: "i", type: "username", normalized: "alice", depth: 0 }, signal: signal(), remainingRequests: 3 });
  assert.ok(output.externalRequests <= 3);
});

test("сниппет выдачи с упоминанием — находка без чтения страницы; город из просьбы уточняет запрос", async () => {
  const queries: string[] = [];
  const reads: string[] = [];
  const access = {
    search: async (query: string) => {
      queries.push(query);
      return [
        { url: "https://vk.com/id1", title: "Иван Петров | ВКонтакте", snippet: "Иван Петров, Пермь. Школа № 101." },
        { url: "https://other.example/x", title: "Другое", snippet: "ничего про него" },
      ];
    },
    read: async (url: string) => {
      reads.push(url);
      throw new Error("js_required");
    },
  };
  const output = await new WebSearchCollector(access, { queriesPerIdentifier: 3, pagesPerIdentifier: 2, maxPageBytes: 100_000 })
    .collect({
      target: { identifierId: "i", type: "name", normalized: "иван петров", depth: 0 },
      signal: signal(),
      remainingRequests: 100,
      context: { city: "Пермь" },
    });
  assert.equal(queries[0], '"Иван Петров" Пермь', "город — в первом запросе");
  assert.deepEqual(output.sources.map((item) => item.locator), ["https://vk.com/id1"]);
  const quote = (output.sources[0]!.findings[0]!.evidence as { quote: string }).quote;
  assert.ok(quote.includes("Иван Петров"), "цитата — из самого сниппета");
  assert.ok(!reads.includes("https://vk.com/id1"), "страница с находкой в сниппете не читается повторно");
  // Нечитаемые кандидаты при найденном в выдаче — не деградация.
  assert.equal(output.status, "succeeded");
});

test("цитата — подстрока текста, а не пересказ", () => {
  const text = "x".repeat(500) + " Телефон +7 912 345-67-89 для связи " + "y".repeat(500);
  const evidence = mentionQuote(text, ["+7 912 345-67-89"]);
  assert.ok(evidence && evidence.kind === "quote" && text.includes(evidence.quote));
  assert.equal(mentionQuote(text, ["+7 000 000-00-00"]), null);
});

const validInput = {
  userId: 1,
  query: "Проверь, кто такой alice",
  purpose: "Проверка контрагента перед сделкой",
  subject: "person" as const,
  seeds: [{ type: "username", value: "@Alice" }, { type: "username", value: "alice" }],
  idempotencyKey: "tool-call-12345678",
};

test("исследование не создаётся без цели, с неизвестным типом или без ключа", () => {
  assert.equal(OsintService.validate(validInput).length, 1);
  assert.throws(() => OsintService.validate({ ...validInput, purpose: " " }), { code: "osint_purpose_required" });
  assert.throws(() => OsintService.validate({ ...validInput, seeds: [{ type: "passport", value: "1" }] }), { code: "osint_seed_type_invalid" });
  assert.throws(() => OsintService.validate({ ...validInput, seeds: [] }), { code: "osint_seeds_invalid" });
  assert.throws(() => OsintService.validate({ ...validInput, idempotencyKey: "x" }), { code: "osint_idempotency_key_invalid" });
});

test("выключенный флаг не создаёт исследование и не трогает базу", async () => {
  let touched = false;
  const db = {
    withUserScope: async () => { touched = true; },
    transaction: async () => { touched = true; },
    query: async () => { touched = true; return { rows: [] }; },
  };
  const service = new OsintService(db as never, { record: async () => { touched = true; } } as never, null, { enabled: false, dailyLimit: 3 });
  await assert.rejects(service.create(validInput), { code: "osint_disabled" });
  assert.equal(touched, false);
});

test("сущность из нескольких источников — одна; незапрошенное расширение не встаёт в очередь", async () => {
  const store = new MemoryStore();
  store.seed("domain", "example.com");
  const evidence = structuredEvidence({ n: 1 });
  const domainKey = { type: "domain" as const, raw: "example.com", normalized: "example.com" };
  const infra = collector("infrastructure", ["domain"], () => ({
    status: "succeeded",
    externalRequests: 3,
    sources: ["https://rdap.example/x", "https://crt.example/y"].map((locator, index) => ({
      ...source(locator, [
        { kind: "entity" as const, evidence: structuredEvidence({ index }), schema: "eva:Domain" as const, identifier: domainKey,
          properties: [{ property: "registrar", value: "R" }] },
        { kind: "discovered" as const, evidence, owner: "example.com", expand: false,
          identifier: { type: "domain" as const, raw: `h${index}.example.com`, normalized: `h${index}.example.com` } },
        { kind: "discovered" as const, evidence, owner: "example.com", expand: true,
          identifier: { type: "ip" as const, raw: "93.184.216.34", normalized: "93.184.216.34" } },
      ]),
      tier: "official_registry" as const,
    })),
  }));
  await new OsintOrchestrator(store, [infra]).run(new AbortController().signal);
  assert.equal([...store.entitySchemas.values()].filter((schema) => schema === "eva:Domain").length, 1);
  // Поддомены привязаны к домену, но в очереди только исходный домен и адрес.
  assert.deepEqual([...store.frontier.keys()].map((id) => [...store.identifiers.values()].find((item) => item.id === id)!.normalized).sort(),
    ["93.184.216.34", "example.com"]);
  assert.ok(store.links.filter((link) => link.entityId === store.entities.get("eva:Domain:example.com")).length >= 3);
  assert.ok(store.claims.some((claim) => claim.property === "registrar"));
});

test("бюджет сущностей: новая не заводится, известная дополняется", async () => {
  const store = new MemoryStore();
  store.budget = { ...DEFAULT_BUDGET, maxEntities: 1 };
  store.seed("domain", "example.com");
  const infra = collector("infrastructure", ["domain"], () => ({
    status: "succeeded",
    externalRequests: 1,
    sources: [source("https://rdap.example/x", [
      { kind: "entity", evidence: structuredEvidence({}), schema: "eva:Domain",
        identifier: { type: "domain", raw: "example.com", normalized: "example.com" }, properties: [] },
    ])],
  }));
  await new OsintOrchestrator(store, [infra]).run(new AbortController().signal);
  // Счётчик уже учитывает субъекта: места для новой сущности нет.
  assert.equal(store.entities.size, 0);
});
