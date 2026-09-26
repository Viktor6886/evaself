/**
 * Сквозная проверка: настоящий Chromium, настоящий прокси, локальный сайт.
 *
 * Имена `site.test` и `evil.test` разрешаются в loopback подменённым
 * DNS; политика разрешает только `127.0.0.1`. Так проверяется то же, что
 * в production: запрос к «чужому» адресу не доходит до сервера вовсе.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";

import { EgressPolicy } from "../dist/egress.js";
import { EgressProxy } from "../dist/proxy.js";
import { createServer } from "../dist/server.js";
import { SessionManager } from "../dist/sessions.js";

/** Chromium нужной ревизии, а если его нет — любой установленный headless_shell. */
function executablePath() {
  if (process.env.BROWSER_EXECUTABLE_PATH) return process.env.BROWSER_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright";
  for (const name of existsSync(root) ? readdirSync(root).sort().reverse() : []) {
    for (const candidate of [join(root, name, "chrome-linux", "headless_shell"), join(root, name, "chrome-linux", "chrome")]) {
      if (name.startsWith("chromium") && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const hits = [];
let site;
let port;
let proxy;
let sessions;
let api;
let apiPort;

const PAGE = (body) => `<!doctype html><html><head><title>Тестовая страница</title></head><body>${body}</body></html>`;

before(async () => {
  site = http.createServer((request, response) => {
    hits.push(`${request.method} ${request.url} ${request.headers.host}`);
    const path = new URL(request.url, "http://x").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/") {
      response.end(PAGE(`<h1>Главная</h1><a href="/second">Вторая страница</a>
        <form action="/search" method="get"><input name="q" aria-label="Поиск"><button>Найти</button></form>
        <form action="/submit" method="post"><input name="c" aria-label="Комментарий"><button>Отправить</button></form>
        <input type="password" aria-label="Пароль" value="hunter2-secret">
        <p>Ключ на экране: sk-abcdefghijklmnopqrstuvwxyz123456</p>
        <img src="http://evil.test:${port}/steal.png" alt="">`));
    } else if (path === "/second") {
      response.end(PAGE(`<h2>Вторая</h2><p>${"Абзац текста. ".repeat(20)}</p>`));
    } else if (path === "/search") {
      response.end(PAGE(`<h2>Результаты</h2><p>Искали: ${new URL(request.url, "http://x").searchParams.get("q")}</p>`));
    } else {
      response.statusCode = 404;
      response.end(PAGE("нет"));
    }
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  port = site.address().port;
  const policy = new EgressPolicy({
    lookup: async (host) => (host === "site.test" || host === "evil.test"
      ? [{ address: host === "site.test" ? "127.0.0.1" : "127.0.0.2", family: 4 }]
      : Promise.reject(new Error("NXDOMAIN"))),
    addressAllowed: (address) => address === "127.0.0.1",
  });
  proxy = new EgressProxy(policy);
  const proxyUrl = await proxy.start();
  const config = {
    port: 0, host: "127.0.0.1", token: "test-token-0123456789", production: false,
    maxSessions: 3, maxSessionsPerOwner: 2, sessionIdleMs: 60_000, sessionMaxAgeMs: 600_000,
    operationTimeoutMs: 5_000, navigationTimeoutMs: 10_000, snapshotMaxChars: 4_000, maxTypeChars: 200,
    executablePath: executablePath(),
  };
  sessions = new SessionManager(config, policy, proxyUrl);
  await sessions.start();
  api = createServer(config, sessions, proxy);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiPort = api.address().port;
});

after(async () => {
  await sessions?.stop();
  await proxy?.stop();
  await new Promise((resolve) => api?.close(resolve));
  await new Promise((resolve) => site?.close(resolve));
});

const OWNER = "owner-aaaa1111";

test("открытие даёт снимок доступности со ссылками, пароль и ключ скрыты, чужой ресурс не загружен", async () => {
  const result = await sessions.open("session-0001", OWNER, `http://site.test:${port}/`);
  assert.equal(result.status, 200);
  assert.equal(result.title, "Тестовая страница");
  assert.match(result.snapshot, /heading "Главная" \[level=1\] \[ref=e\d+\]/);
  assert.match(result.snapshot, /link "Вторая страница" \[ref=e\d+\]/);
  assert.doesNotMatch(result.snapshot, /hunter2-secret/);
  assert.match(result.snapshot, /textbox "Пароль" \[ref=e\d+\]: \[скрыто\]/);
  assert.doesNotMatch(result.snapshot, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(result.snapshot, /<\w+/, "не HTML");
  assert.ok(!hits.some((hit) => hit.includes("/steal.png")), "запрос к закрытому адресу не дошёл до сервера");
  assert.ok(result.blockedRequests >= 1);
});

test("нажатие по ссылке, ввод с отправкой GET-формы и возврат назад", async () => {
  let snap = await sessions.snapshot("session-0001", OWNER);
  const link = /link "Вторая страница" \[ref=([a-z0-9]+)\]/.exec(snap.snapshot)[1];
  snap = await sessions.click("session-0001", OWNER, link);
  assert.match(snap.url, /\/second$/);
  snap = await sessions.back("session-0001", OWNER);
  assert.match(snap.url, /\/$/);
  const search = /textbox "Поиск" \[ref=([a-z0-9]+)\]/.exec(snap.snapshot)[1];
  snap = await sessions.type("session-0001", OWNER, search, "котики", true);
  assert.match(snap.url, /\/search\?q=/);
  assert.match(snap.snapshot, /Искали: котики/);
});

test("отправка POST-формы и ввод в поле пароля не проходят", async () => {
  let snap = await sessions.open("session-0001", OWNER, `http://site.test:${port}/`);
  const comment = /textbox "Комментарий" \[ref=([a-z0-9]+)\]/.exec(snap.snapshot)[1];
  const before = snap.blockedRequests;
  snap = await sessions.type("session-0001", OWNER, comment, "спам", true);
  assert.ok(!hits.some((hit) => hit.startsWith("POST")), "POST не дошёл до сайта");
  assert.ok(snap.blockedRequests > before);
  // Отменённая навигация оставляет вкладку на странице ошибки — открываем заново.
  const reopened = await sessions.open("session-0001", OWNER, `http://site.test:${port}/`);
  const password = /textbox "Пароль" \[ref=([a-z0-9]+)\]/.exec(reopened.snapshot)[1];
  await assert.rejects(sessions.type("session-0001", OWNER, password, "x", false), { code: "sensitive_field" });
  await assert.rejects(sessions.click("session-0001", OWNER, "e99999"), { code: "invalid_ref" });
});

test("закрытые адреса отклоняются до открытия, чужой владелец сессии не видит", async () => {
  await assert.rejects(sessions.open("session-0002", OWNER, `http://evil.test:${port}/`), { code: "blocked_url" });
  await assert.rejects(sessions.open("session-0002", OWNER, "http://127.0.0.2/"), { code: "blocked_url" });
  await assert.rejects(sessions.open("session-0002", OWNER, "file:///etc/passwd"), { code: "blocked_url" });
  await assert.rejects(sessions.snapshot("session-0001", "owner-bbbb2222"), { code: "forbidden" });
  await assert.rejects(sessions.snapshot("session-nope", OWNER), { code: "not_found" });
});

test("предел на владельца закрывает его самую давнюю сессию, простой — любую", async () => {
  await sessions.open("session-0003", OWNER, `http://site.test:${port}/second`);
  await sessions.open("session-0004", OWNER, `http://site.test:${port}/second`);
  const mine = sessions.list().filter((session) => session.owner === OWNER).map((session) => session.id).sort();
  assert.deepEqual(mine, ["session-0003", "session-0004"]);
  assert.deepEqual(Object.keys(sessions.list()[0]).sort(), ["ageMs", "blockedRequests", "id", "idleMs", "operations", "owner"], "в списке нет адресов страниц");
  assert.equal(await sessions.close("session-0003", OWNER), true);
});

test("HTTP API: без ключа — 401, здоровье открыто, операции по маршрутам", async () => {
  const base = `http://127.0.0.1:${apiPort}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal((await fetch(`${base}/v1/sessions`)).status, 401);
  const headers = { "x-browser-key": "test-token-0123456789", "content-type": "application/json" };
  const opened = await fetch(`${base}/v1/sessions/session-api1/open`, { method: "POST", headers, body: JSON.stringify({ owner: "owner-api-0001", url: `http://site.test:${port}/second` }) });
  assert.equal(opened.status, 200);
  assert.match((await opened.json()).snapshot, /heading "Вторая"/);
  const blocked = await fetch(`${base}/v1/sessions/session-api1/open`, { method: "POST", headers, body: JSON.stringify({ owner: "owner-api-0001", url: "http://169.254.169.254/latest/meta-data" }) });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, "blocked_url");
  const closed = await fetch(`${base}/v1/sessions/session-api1`, { method: "DELETE", headers, body: JSON.stringify({ owner: "owner-api-0001" }) });
  assert.equal((await closed.json()).closed, true);
});

test("сессия закрывается по простою и по возрасту", async () => {
  let clock = 1_000_000;
  const policy = new EgressPolicy({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], addressAllowed: (address) => address === "127.0.0.1" });
  const local = new EgressProxy(policy);
  const manager = new SessionManager({
    maxSessions: 4, maxSessionsPerOwner: 4, sessionIdleMs: 60_000, sessionMaxAgeMs: 300_000,
    operationTimeoutMs: 5_000, navigationTimeoutMs: 10_000, snapshotMaxChars: 4_000, maxTypeChars: 200,
    executablePath: executablePath(),
  }, policy, await local.start(), () => clock);
  try {
    await manager.open("ttl-idle-01", OWNER, `http://site.test:${port}/second`);
    await manager.open("ttl-busy-01", OWNER, `http://site.test:${port}/second`);
    clock += 50_000;
    await manager.snapshot("ttl-busy-01", OWNER);
    clock += 20_000; // простой первой — 70 с, второй — 20 с
    await manager.sweepNow();
    assert.deepEqual(manager.list().map((session) => session.id), ["ttl-busy-01"]);
    for (let step = 0; step < 6; step += 1) { clock += 50_000; await manager.snapshot("ttl-busy-01", OWNER); }
    await manager.sweepNow(); // возраст больше пяти минут, хотя простоя нет
    assert.deepEqual(manager.list(), []);
    assert.equal(manager.counters.expired, 2);
  } finally {
    await manager.stop();
    await local.stop();
  }
});
