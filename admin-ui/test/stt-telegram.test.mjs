/**
 * Раздел «Распознавание речи» → «Файлы из Telegram».
 *
 * Вкладка собирает три настройки, у каждой из которых уже есть свой
 * путь записи: флаг разбора аудиофайлов (общие настройки), ключи
 * приложения Telegram (форма интеграции) и переход на свой сервер Bot API
 * (сервис операций). Тесты сторожат именно это — что вкладка пишет туда
 * же, а не заводит своё, — и отрицательные свойства: API Hash не
 * показывается, пустое поле его не стирает, а переезд без подтверждения
 * не начинается.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const SETTINGS = {
  etag: "\"cfg-7\"",
  profiles: [],
  settings: [
    { key: "runtime.audio_file_transcripts", type: "boolean", value: false, group: "runtime", title: "Разбор аудиофайлов" },
  ],
};

const integration = (apiId, hashConfigured) => ({
  id: "telegram",
  fields: [
    { name: "api_id", kind: "text", value: apiId, configured: Boolean(apiId) },
    { name: "api_hash", kind: "secret", value: null, configured: hashConfigured },
  ],
});

const botApi = (mode, server = null) => ({
  mode,
  base_url: mode === "cloud" ? "https://api.telegram.org" : "http://telegram-bot-api:8081",
  cloud_file_limit_mb: 20,
  credentials: { api_id: null, api_hash_configured: false },
  bot_token_configured: true,
  server,
  server_error: null,
});

const BASE = {
  "/stt/provider-schemas": { providers: [] },
  "/stt/configs": { configs: [] },
  "/stt/routes": { routes: [] },
  "GET /settings": SETTINGS,
};

const openTab = async (page) => {
  await page.evaluate(() => openPage("stt"));
  await page.waitForFunction(() => document.querySelector("#page-stt").classList.contains("active"));
  await page.click('[data-stt-tab="telegram"]');
  await page.waitForSelector("#stt-audio-files");
};

describe("вкладка «Файлы из Telegram»", () => {
  const panels = [];
  const open = async (options) => {
    const panel = await openPanel(options);
    panels.push(panel);
    return panel;
  };
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  test("флаг разбора аудиофайлов пишется общей настройкой с версией", async () => {
    const panel = await open({
      routes: {
        ...BASE,
        "/integrations/telegram/config": integration(null, false),
        "/telegram/bot-api": botApi("cloud"),
        "PUT /settings": { ...SETTINGS, etag: "\"cfg-8\"" },
      },
    });
    await openTab(panel.page);
    assert.equal(await panel.page.$eval("#stt-audio-files", (node) => node.value), "false");
    // Другие вкладки спрятаны: вкладка своя, а не поверх конфигураций.
    assert.equal(await panel.page.$eval("#stt-configs", (node) => node.hidden), true);

    await panel.page.selectOption("#stt-audio-files", "true");
    const saved = await panel.waitForRequest((item) => item.method === "PUT" && item.path === "/settings");
    assert.ok(saved, "настройка не сохранилась");
    assert.deepEqual(saved.body, { settings: { "runtime.audio_file_transcripts": true } });
    assert.deepEqual(panel.errors, []);
  });

  test("API Hash не показывается, а пустое поле его не стирает", async () => {
    const panel = await open({
      routes: {
        ...BASE,
        "/integrations/telegram/config": integration("1234567", true),
        "/telegram/bot-api": botApi("cloud"),
        "PUT /integrations/telegram/config": integration("7654321", true),
      },
    });
    await openTab(panel.page);
    assert.equal(await panel.page.$eval('[name="api_id"]', (node) => node.value), "1234567");
    assert.equal(await panel.page.$eval('[name="api_hash"]', (node) => node.value), "");
    assert.match(await panel.page.$eval('[name="api_hash"]', (node) => node.placeholder), /задан/);

    await panel.page.fill('[name="api_id"]', "7654321");
    await panel.page.click("#stt-telegram-save");
    const saved = await panel.waitForRequest(
      (item) => item.method === "PUT" && item.path === "/integrations/telegram/config");
    assert.deepEqual(saved.body, { api_id: "7654321" }, "пустой API Hash ушёл на сервер");
  });

  test("переход недоступен без ключей и не начинается без подтверждения", async () => {
    const withoutKeys = await open({
      routes: { ...BASE, "/integrations/telegram/config": integration("1234567", false), "/telegram/bot-api": botApi("cloud") },
    });
    await openTab(withoutKeys.page);
    assert.equal(await withoutKeys.page.$eval('[data-stt-bot-api="local"]', (node) => node.disabled), true);

    let mode = "cloud";
    const panel = await open({
      routes: {
        ...BASE,
        "/integrations/telegram/config": integration("1234567", true),
        "GET /telegram/bot-api": () => botApi(mode, mode === "local" ? { exists: true, running: true, health: "healthy" } : null),
        "POST /telegram/bot-api/mode": () => {
          mode = "local";
          return { mode: "local", admin_restart_scheduled: true };
        },
      },
    });
    await openTab(panel.page);
    assert.match(await panel.page.$eval("#stt-telegram", (node) => node.textContent), /облачный Bot API — Ева принимает\s+файлы до 20 МБ/);

    await panel.confirmWatch();
    await panel.page.click('[data-stt-bot-api="local"]');
    assert.equal(await panel.confirmTitle(), "Перейти на свой сервер Bot API");
    assert.equal(panel.countTo("/telegram/bot-api/mode"), 0, "переезд начат до подтверждения");

    await panel.confirmAccept();
    const switched = panel.requests.find((item) => item.path === "/telegram/bot-api/mode");
    assert.deepEqual(switched.body, { mode: "local" });
    await panel.page.waitForSelector('[data-stt-bot-api="cloud"]');
    assert.match(await panel.page.$eval("#stt-telegram", (node) => node.textContent), /свой сервер\s+Bot API — файлы до 350 МБ; сервер работает/);
  });

  test("наблюдатель видит состояние, но ничего не меняет", async () => {
    const panel = await open({
      role: "viewer",
      routes: { ...BASE, "/integrations/telegram/config": integration("1234567", true), "/telegram/bot-api": botApi("cloud") },
    });
    await openTab(panel.page);
    for (const selector of ["#stt-audio-files", '[name="api_id"]', "#stt-telegram-save", '[data-stt-bot-api="local"]']) {
      assert.equal(await panel.page.$eval(selector, (node) => node.disabled), true, `${selector} доступен viewer`);
    }
  });
});
