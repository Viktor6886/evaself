import assert from "node:assert/strict";
import { test } from "node:test";

import { EgressPolicy, isBlockedAddress } from "../dist/egress.js";
import { redactSecrets, truncateLines } from "../dist/snapshot.js";
import { loadConfig } from "../dist/config.js";

test("частные, служебные и зарезервированные адреса закрыты, публичные открыты", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe", "2001:db8::1", "ff02::1", "not-an-ip",
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("адрес проверяется по схеме, учётным данным, имени и каждому ответу DNS", async () => {
  const answers = {
    "public.test": [{ address: "93.184.216.34", family: 4 }],
    "rebind.test": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
    "metadata.test": [{ address: "169.254.169.254", family: 4 }],
  };
  const policy = new EgressPolicy({ lookup: async (host) => { if (!answers[host]) throw new Error("NXDOMAIN"); return answers[host]; } });
  assert.deepEqual(await policy.checkUrl("https://public.test/page"), { ok: true, address: "93.184.216.34", family: 4 });
  assert.equal((await policy.checkUrl("https://rebind.test/")).reason, "private_address");
  assert.equal((await policy.checkUrl("http://metadata.test/latest")).reason, "private_address");
  assert.equal((await policy.checkUrl("file:///etc/passwd")).reason, "scheme");
  assert.equal((await policy.checkUrl("javascript:alert(1)")).reason, "scheme");
  assert.equal((await policy.checkUrl("https://user:pw@public.test/")).reason, "credentials");
  assert.equal((await policy.checkUrl("http://localhost:8080/")).reason, "hostname");
  assert.equal((await policy.checkUrl("http://postgres:5432/")).reason, "hostname", "имя контейнера без точки");
  assert.equal((await policy.checkUrl("http://printer.local/")).reason, "hostname");
  assert.equal((await policy.checkUrl("http://[::1]:8070/")).reason, "private_address");
  assert.equal((await policy.checkUrl("http://nx.test/")).reason, "dns_failed");
});

test("секреты на странице маскируются, снимок режется по строкам и листается", () => {
  assert.equal(redactSecrets("key sk-abcdefghijklmnopqrstuvwx1234 end"), "key [секрет скрыт] end");
  assert.match(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"), /\[секрет скрыт\]/);
  const text = Array.from({ length: 100 }, (_, index) => `- item "line ${index}" [ref=e${index}]`).join("\n");
  const first = truncateLines(text, 800);
  assert.equal(first.truncated, true);
  assert.ok(first.text.length <= 800 + 200);
  assert.ok(first.text.split("\n").slice(0, -1).every((line) => line.startsWith("- item")), "строки целые");
  const next = truncateLines(text, 800, first.nextOffset);
  assert.match(next.text, new RegExp(`line ${first.nextOffset}"`));
  assert.equal(truncateLines(text, 100_000).truncated, false);
});

test("в production без секрета сервис не стартует, пределы ограничены сверху", () => {
  assert.throws(() => loadConfig({ EVA_ENV: "production" }), /BROWSER_SERVICE_TOKEN/);
  const config = loadConfig({ EVA_ENV: "test", BROWSER_MAX_SESSIONS: "100000", BROWSER_OPERATION_TIMEOUT_MS: "nope" });
  assert.equal(config.maxSessions, 32);
  assert.equal(config.operationTimeoutMs, 15_000);
});
