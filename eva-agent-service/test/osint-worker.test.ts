/**
 * Клиент osint-worker и перевод его ответов в домен OSINT.
 *
 * Главное здесь: ответ воркера не становится решением о тождестве сам по
 * себе. Признаки nomenklatura проходят через resolver, находка одного
 * сборщика остаётся одним подтверждением, а «аккаунта нет» у второго —
 * противоречием, которое видно, а не поводом молча выбросить находку.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OsintWorkerClient, type WorkerComparison, type WorkerScanResult } from "../dist/osint/worker-client.js";
import { comparisonToFeatures, mergeProfileObservations } from "../dist/osint/worker-mapping.js";
import { decideMatch } from "../dist/osint/resolver.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | Error>, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("клиент предъявляет ключ и переводит скан в типы", async () => {
  const calls: Call[] = [];
  const client = new OsintWorkerClient({
    baseUrl: "http://osint-worker:8095/",
    token: "secret",
    fetcher: fakeFetch([json(200, {
      collector: "maigret",
      username: "alice",
      status: "degraded",
      checked: 3,
      found: [{
        site: "GitHub",
        url: "https://github.com/alice",
        tags: ["coding"],
        http_status: 200,
        ids: { fullname: "Alice" },
        discovered_usernames: ["alice_dev"],
        discovered_links: ["https://alice.example"],
      }, { site: "", url: "" }],
      degraded: { captcha: 1, bogus: 5 },
    })], calls),
  });
  const scan = await client.scanUsername("alice", { topSites: 50 });
  assert.equal(calls[0]!.url, "http://osint-worker:8095/v1/username/scan");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["X-Osint-Key"], "secret");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { username: "alice", top_sites: 50 });
  assert.equal(scan.status, "degraded");
  assert.deepEqual(scan.degraded, { captcha: 1 });
  assert.equal(scan.found.length, 1);
  assert.deepEqual(scan.found[0]!.discoveredUsernames, ["alice_dev"]);
});

test("скан не повторяется, а чтение повторяется один раз", async () => {
  const scanCalls: Call[] = [];
  const scanClient = new OsintWorkerClient({
    baseUrl: "http://w",
    token: "t",
    fetcher: fakeFetch([new TypeError("fetch failed"), json(200, {})], scanCalls),
  });
  await assert.rejects(scanClient.scanUsername("alice"), { code: "osint_worker_unavailable", retryable: true });
  assert.equal(scanCalls.length, 1);

  const compareCalls: Call[] = [];
  const compareClient = new OsintWorkerClient({
    baseUrl: "http://w",
    token: "t",
    fetcher: fakeFetch([json(503, {}), json(200, { algorithm: "logic-v2", score: 0.9, features: [] })], compareCalls),
  });
  const result = await compareClient.compare(
    { schema: "Person", properties: { name: ["A"] } },
    { schema: "Person", properties: { name: ["B"] } },
  );
  assert.equal(compareCalls.length, 2);
  assert.equal(result.algorithm, "logic-v2");
});

test("ошибки воркера становятся кодами, без персональных данных в тексте", async () => {
  const cases: Array<[Response, string]> = [
    [json(401, { error: { code: "unauthorized" } }), "osint_worker_unauthorized"],
    [json(400, { error: { code: "invalid_username" } }), "osint_worker_rejected"],
    [json(504, { error: { code: "scan_deadline" } }), "osint_worker_deadline"],
  ];
  for (const [response, code] of cases) {
    const client = new OsintWorkerClient({ baseUrl: "http://w", token: "t", fetcher: fakeFetch([response]) });
    await assert.rejects(client.scanUsername("alice.secret"), (error: Error & { code: string }) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /alice/);
      return true;
    });
  }
});

test("без токена клиент не ходит в воркер", async () => {
  const calls: Call[] = [];
  const client = new OsintWorkerClient({ baseUrl: "http://w", token: " ", fetcher: fakeFetch([], calls) });
  await assert.rejects(client.verifyProfiles("alice", ["github.com"]), { code: "osint_worker_not_configured" });
  assert.equal(calls.length, 0);
});

test("проверки с неизвестным статусом или источником отбрасываются", async () => {
  const client = new OsintWorkerClient({
    baseUrl: "http://w",
    token: "t",
    fetcher: fakeFetch([json(200, {
      results: [
        { source: "whatsmyname", site: "GitHub", profile_url: "https://github.com/alice", status: "found", reason: null },
        { source: "holehe", site: "x", profile_url: "https://x", status: "found" },
        { source: "sherlock", site: "y", profile_url: "https://y", status: "maybe" },
      ],
    })]),
  });
  const results = await client.verifyProfiles("alice", ["github.com", "github.com"]);
  assert.deepEqual(results.map((r) => r.source), ["whatsmyname"]);
});

const comparison = (features: Array<[string, number]>): WorkerComparison => ({
  algorithm: "logic-v2",
  score: 0.9,
  features: features.map(([name, score]) => ({ name, score, detail: null })),
});

test("признаки nomenklatura переводятся по порогам, итог выносит resolver", () => {
  const features = comparisonToFeatures(comparison([
    ["name_match", 0.97],
    ["inn_code_match", 1],
    ["ogrn_code_match", 0],
    ["identifier_match", 1],
    ["dob_year_disjoint", 0],
  ]), ["ev-1"]);
  assert.deepEqual(features.map((f) => f.kind).sort(), ["name_exact", "same_tax_id"]);
  assert.equal(decideMatch(features).status === "rejected", false);

  const partial = comparisonToFeatures(comparison([["name_match", 0.8]]), ["ev-1"]);
  assert.deepEqual(partial.map((f) => f.kind), ["name_partial"]);
  assert.deepEqual(comparisonToFeatures(comparison([["name_match", 0.5]]), ["ev-1"]), []);
});

test("тёзки с разными датами рождения не склеиваются", () => {
  const features = comparisonToFeatures(comparison([
    ["name_match", 1],
    ["dob_year_disjoint", 1],
    ["dob_day_disjoint", 1],
  ]), ["ev-1"]);
  assert.deepEqual(features.map((f) => f.kind).sort(), ["different_birth_date", "name_exact"]);
  const decision = decideMatch(features);
  assert.notEqual(decision.status, "confirmed");
  assert.notEqual(decision.status, "probable");
});

test("без доказательства сравнение признаков не даёт", () => {
  assert.deepEqual(comparisonToFeatures(comparison([["inn_code_match", 1]]), []), []);
});

const scan: WorkerScanResult = {
  collector: "maigret",
  username: "alice",
  status: "ok",
  checked: 3,
  degraded: {},
  found: [
    {
      site: "GitHub",
      url: "https://github.com/alice",
      tags: ["coding"],
      httpStatus: 200,
      ids: {},
      discoveredUsernames: ["alice", "alice_dev", "alice_dev"],
      discoveredLinks: ["https://www.github.com/alice", "https://alice.example/"],
    },
    {
      site: "Forum",
      url: "https://forum.example/u/alice",
      tags: [],
      httpStatus: 200,
      ids: {},
      discoveredUsernames: [],
      discoveredLinks: [],
    },
  ],
};

test("находка Maigret сводится с независимыми проверками", () => {
  const observations = mergeProfileObservations(scan, [
    { source: "whatsmyname", site: "GitHub", profileUrl: "https://github.com/alice", status: "found", reason: null },
    { source: "sherlock", site: "GitHub", profileUrl: "https://www.github.com/alice", status: "found", reason: null },
    { source: "sherlock", site: "Forum", profileUrl: "https://forum.example/u/alice", status: "not_found", reason: null },
    { source: "whatsmyname", site: "Forum", profileUrl: "https://forum.example/u/alice", status: "degraded", reason: "captcha" },
    // Проверка без находки Maigret профилем не становится.
    { source: "whatsmyname", site: "Other", profileUrl: "https://other.example/alice", status: "found", reason: null },
  ]);
  assert.deepEqual(observations.profiles.map((p) => p.host), ["forum.example", "github.com"]);
  const [forum, github] = observations.profiles;
  assert.deepEqual(github!.confirmedBy, ["maigret", "whatsmyname", "sherlock"]);
  assert.deepEqual(forum!.confirmedBy, ["maigret"]);
  assert.deepEqual(forum!.contradictedBy, ["sherlock"]);
  assert.deepEqual(forum!.unverifiedBy, ["whatsmyname"]);
});

test("новые идентификаторы дедуплицируются, искомое имя и известные профили не повторяются", () => {
  const { discovered } = mergeProfileObservations(scan);
  const pairs = discovered.map((identifier) => `${identifier.type}:${identifier.normalized}`);
  assert.equal(pairs.filter((pair) => pair === "username:alice_dev").length, 1);
  assert.equal(pairs.some((pair) => pair === "username:alice"), false);
  assert.equal(pairs.some((pair) => pair.includes("github.com/alice")), false);
  assert.equal(pairs.some((pair) => pair.includes("alice.example")), true);
});
