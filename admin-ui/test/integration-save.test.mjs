/**
 * Общая запись настроек интеграции.
 *
 * Один и тот же маршрут обслуживает и речь, и Telegram с поиском, а тем
 * же запросом меняется bot_token. Пароль за настройку больше не
 * спрашивается нигде: он вводится один раз при входе в панель. Здесь
 * сторожится именно это — сохранение уходит на сервер сразу, без
 * промежуточного окна, и уносит введённое значение.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const TELEGRAM = {
  id: "telegram",
  title: "Telegram",
  purpose: "Бот, webhook и Mini App",
  editable: true,
  restart_required: "eva-agent-service",
  note: null,
  last_check: null,
  fields: [
    { name: "api_base_url", kind: "url", title: "Base URL", hint: "", value: "https://api.telegram.org", required: false, configured: true },
    { name: "bot_token", kind: "secret", title: "Bot Token", hint: "", value: null, required: true, configured: true },
    { name: "owner_id", kind: "text", title: "Telegram ID владельца", hint: "", value: "1", required: true, configured: true },
  ],
};

describe("запись настроек интеграции", () => {
  let panel;
  after(async () => { await panel?.close(); });

  test("смена токена Telegram сохраняется без повторного пароля", async () => {
    panel = await openPanel({
      routes: {
        "/services": { services: [] },
        "/integrations": { integrations: [] },
        "/integrations/telegram/config": TELEGRAM,
        "PUT /integrations/telegram/config": TELEGRAM,
      },
    });
    const { page, requests } = panel;

    // Модальное окно живёт внутри раздела сервисов: на неактивной
    // странице оно не отрисовывается вовсе.
    await page.click('.nav-item[data-page="services"]');
    await page.evaluate(() => openIntegration("telegram"));
    await page.waitForSelector("#integration-form input[name=bot_token]");
    await page.fill("#integration-form input[name=bot_token]", "новый-токен");
    await page.click("#integration-save");

    const saved = await panel.waitForRequest(
      (item) => item.method === "PUT" && item.path === "/integrations/telegram/config",
    );
    assert.ok(saved, "сохранение не ушло на сервер");
    assert.equal(saved.body.bot_token, "новый-токен");
    // Ни одного окна между нажатием и запросом: пароль вводится только
    // при входе в панель.
    assert.equal(await panel.confirmTitle(), null, "сохранение настройки открыло окно");
    assert.equal(
      requests.filter((item) => item.path === "/sudo").length,
      0,
      "панель всё ещё просит sudo-грант",
    );
  });
});
