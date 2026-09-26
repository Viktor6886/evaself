/**
 * Сборщики инфраструктуры и их место в оркестраторе.
 *
 * Проверяется смысловое ограничение расширения: сотни поддоменов из
 * журналов сертификатов запоминаются, но в очередь не встают; адреса и AS
 * встают, но не больше предела. Домен у одного пользователя — одна
 * сущность, сколько бы источников о нём ни сообщили.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HarvesterCollector,
  InfrastructureCollector,
  MAX_EXPANDED_PER_KIND,
  SpiderfootCollector,
  isPublicIp,
} from "../dist/osint/infra-collectors.js";
import { HarvesterClient, SpiderfootClient } from "../dist/osint/service-clients.js";
import { OsintWorkerClient, parseInfra } from "../dist/osint/worker-client.js";
import type { CollectorOutput, Finding } from "../dist/osint/collectors.js";

const signal = () => new AbortController().signal;
const target = (type: string, normalized: string) => ({ identifierId: "i", type, normalized, depth: 0 }) as never;

const infra = (collector: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  collector, status: "ok" as const, requests: 1, sourceUrl: `https://${collector}.example/x`, degradedReason: null, data, ...extra,
});

const findings = (output: CollectorOutput): Finding[] => output.sources.flatMap((item) => item.findings);
const discovered = (output: CollectorOutput) =>
  findings(output).filter((finding): finding is Extract<Finding, { kind: "discovered" }> => finding.kind === "discovered");

const worker = {
  dns: async () => infra("dns", { records: { A: ["93.184.216.34", "10.0.0.1"], MX: ["10 mail.example.com."] } }),
  rdap: async (kind: string) => kind === "domain"
    ? infra("rdap", {
      found: true, registrar: "Example Registrar", registrant_organizations: ["Example Holdings"],
      nameservers: ["a.iana-servers.net"], events: { registration: "1995-08-14T04:00:00Z" }, status: ["active"],
    })
    : kind === "ip"
      ? infra("rdap", { found: true, name: "EXAMPLE-NET", country: "US", cidrs: ["93.184.216.0/24"], organizations: ["Edgecast"] })
      : infra("rdap", { found: true, name: "EDGECAST", country: "US", organizations: [] }),
  ripestat: async (kind: string) => kind === "ip"
    ? infra("ripestat", { found: true, announced: true, asns: [{ asn: 15133, holder: "EDGECAST" }] })
    : infra("ripestat", { found: true, holder: "EDGECAST", announced: true }),
  certificates: async () => infra("ct", {
    certificates: 400,
    names: Array.from({ length: 120 }, (_, index) => `h${index}.example.com`),
    first_seen: "2015-01-01", last_seen: "2026-01-01",
  }),
};

test("домен: сущность из реестров, адреса в очередь, поддомены только запоминаются", async () => {
  const output = await new InfrastructureCollector(worker as never)
    .collect({ target: target("domain", "example.com"), signal: signal(), remainingRequests: 100 });
  assert.equal(output.status, "succeeded");
  assert.equal(output.externalRequests, 3);
  const entities = findings(output).filter((finding) => finding.kind === "entity");
  assert.ok(entities.every((finding) => finding.kind === "entity" && finding.schema === "eva:Domain"
    && finding.identifier.normalized === "example.com"));
  const properties = entities.flatMap((finding) => finding.kind === "entity" ? finding.properties : []);
  assert.ok(properties.some((item) => item.property === "registrar" && item.value === "Example Registrar"));
  const found = discovered(output);
  // Частный адрес из DNS в расширение не идёт.
  const ips = found.filter((item) => item.identifier.type === "ip");
  assert.deepEqual(ips.map((item) => [item.identifier.normalized, item.expand]), [["93.184.216.34", true]]);
  const hosts = found.filter((item) => item.identifier.type === "domain");
  assert.equal(hosts.length, 50);
  assert.ok(hosts.every((item) => item.expand === false && item.owner === "example.com"));
  assert.ok(found.some((item) => item.identifier.type === "organization" && item.expand === true));
});

test("частные и служебные диапазоны не считаются публичными", () => {
  for (const address of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicIp(address), false, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:10::6814:179a"]) assert.equal(isPublicIp(address), true, address);
});

test("адрес: сеть, страна и AS из реестров; AS идёт дальше", async () => {
  const output = await new InfrastructureCollector(worker as never)
    .collect({ target: target("ip", "93.184.216.34"), signal: signal(), remainingRequests: 100 });
  const entity = findings(output).find((finding) => finding.kind === "entity");
  assert.equal(entity?.kind === "entity" && entity.schema, "eva:IPAddress");
  const asn = discovered(output).find((item) => item.identifier.type === "asn");
  assert.equal(asn?.expand, true);
  const cidr = discovered(output).find((item) => item.identifier.type === "cidr");
  assert.equal(cidr?.expand, false);
});

test("недоступный реестр — деградация, остальные источники сохраняются", async () => {
  const degraded = {
    ...worker,
    certificates: async () => ({ ...infra("ct", {}), status: "degraded" as const, degradedReason: "rate_limited" as const, sourceUrl: null }),
  };
  const output = await new InfrastructureCollector(degraded as never)
    .collect({ target: target("domain", "example.com"), signal: signal(), remainingRequests: 100 });
  assert.equal(output.status, "degraded");
  assert.equal(output.degradedReason, "rate_limited");
  assert.ok(findings(output).some((finding) => finding.kind === "entity"));
});

test("theHarvester: почта и адреса в очередь с пределом, хосты только запоминаются", async () => {
  const output = await new HarvesterCollector({
    harvest: async () => ({
      status: "ok", requests: 7, sources: ["crtsh"],
      hosts: ["www.example.com", "api.example.com"],
      ips: Array.from({ length: 30 }, (_, index) => `93.184.216.${index + 1}`),
      emails: ["info@example.com", "info@example.com"], asns: ["AS15133"],
    }),
  } as never).collect({ target: target("domain", "example.com"), signal: signal(), remainingRequests: 100 });
  const found = discovered(output);
  assert.equal(found.filter((item) => item.identifier.type === "ip" && item.expand).length, MAX_EXPANDED_PER_KIND);
  assert.deepEqual(found.filter((item) => item.identifier.type === "email").map((item) => item.identifier.normalized), ["info@example.com"]);
  assert.ok(found.filter((item) => item.identifier.type === "domain").every((item) => item.expand === false));
  assert.equal(output.externalRequests, 7);
});

test("SpiderFoot: репутация — свойство сущности, сети не расширяются", async () => {
  const output = await new SpiderfootCollector({
    scan: async () => ({
      status: "degraded", modules: 28, hosts: ["mail.example.com"], domains: [], ips: ["93.184.216.34"],
      asns: ["15133"], netblocks: ["93.184.216.0/24"], organizations: ["Example Inc"], lei: [],
      dns: [], reputation: [{ type: "Blacklisted IP Address", data: "blocklist.de [93.184.216.34]", module: "sfp_blocklistde" }],
    }),
  } as never).collect({ target: target("domain", "example.com"), signal: signal(), remainingRequests: 100 });
  assert.equal(output.status, "degraded");
  const entity = findings(output).find((finding) => finding.kind === "entity");
  assert.ok(entity?.kind === "entity" && entity.properties.some((item) => item.property === "reputation"));
  assert.equal(discovered(output).find((item) => item.identifier.type === "cidr")?.expand, false);
});

test("сборщики не запускаются без бюджета", async () => {
  let called = false;
  const harvester = new HarvesterCollector({ harvest: async () => { called = true; return {} as never; } } as never);
  const output = await harvester.collect({ target: target("domain", "example.com"), signal: signal(), remainingRequests: 3 });
  assert.equal(output.status, "skipped");
  assert.equal(called, false);
});

test("клиенты сервисов: путь, ключ и разбор ответа", async () => {
  const calls: Array<{ url: string; body: unknown; key: string | undefined }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)["X-Osint-Key"] });
    const payload = url.endsWith("/v1/infra/rdap")
      ? { collector: "rdap", status: "degraded", requests: 2, source_url: null, degraded_reason: "captcha", data: {} }
      : url.endsWith("/v1/domain/harvest")
        ? { status: "ok", requests: 7, sources: ["crtsh"], hosts: ["a.example.com"], ips: [], emails: [], asns: [] }
        : { status: "ok", modules: 28, hosts: [], domains: [], ips: [], asns: [], netblocks: [], organizations: [], lei: [], dns: [], reputation: [{ type: "t", data: "d", module: "m" }, { data: "" }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  const rdap = await new OsintWorkerClient({ baseUrl: "http://w/", token: "k", fetcher }).rdap("domain", "example.com");
  assert.equal(rdap.degradedReason, "captcha");
  const harvest = await new HarvesterClient({ baseUrl: "http://h", token: "k", fetcher }).harvest("example.com");
  assert.deepEqual(harvest.hosts, ["a.example.com"]);
  const scan = await new SpiderfootClient({ baseUrl: "http://s", token: "k", fetcher }).scan("domain", "example.com");
  assert.equal(scan.reputation.length, 1);
  assert.deepEqual(calls.map((call) => call.url), ["http://w/v1/infra/rdap", "http://h/v1/domain/harvest", "http://s/v1/scan"]);
  assert.ok(calls.every((call) => call.key === "k"));
  assert.equal(parseInfra({ degraded_reason: "bogus" }).degradedReason, null);
});
