import assert from "node:assert/strict";
import { test } from "node:test";

import { documentWidth, openApp } from "./harness.mjs";

const PLUS_SESSION = {
  user: { id: 1, first_name: "Аня", timezone: "Europe/Moscow" },
  plan: "plus",
  quotas: [
    // Одна метрика может одновременно иметь несколько периодов. В UI
    // пользователь видит один, реально ограничивающий его сейчас.
    { metric: "messages", period: "day", limit_value: 200, used: 177, remaining: 23 },
    { metric: "messages", period: "month", limit_value: 1000, used: 768, remaining: 232 },
    { metric: "voice_minutes", period: "day", limit_value: 60, used: 24, remaining: 36 },
    { metric: "web_search", period: "day", limit_value: 100, used: 3, remaining: 97 },
    { metric: "documents", period: "day", limit_value: -1, used: 5, remaining: null },
    { metric: "images", period: "day", limit_value: 20, used: 17, remaining: 3 },

    // Это технические/учётные метрики. Скриншот старого интерфейса как раз
    // превращал каждую такую строку в очередную безымянную «Квота: N».
    { metric: "messages_out", period: "day", limit_value: -1, used: 12, remaining: null },
    { metric: "voice_in", period: "day", limit_value: -1, used: 2, remaining: null },
    { metric: "voice_out", period: "day", limit_value: -1, used: 1, remaining: null },
  ],
  session_token: "test-session",
  session_expires_in: 900,
};

test("подписка показывает понятный тариф и только полезные пользователю лимиты", async () => {
  const app = await openApp({
    viewport: { width: 320, height: 568 },
    routes: {
      "/public/session": PLUS_SESSION,
      "/public/subscription/offers": {
        offers: [{ plan: "max", period: "month", title: "Max · месяц", stars: 499 }],
      },
    },
  });

  try {
    await app.openScreen("profile");
    await app.page.waitForFunction(() => document.querySelector('[data-setting="subscription"] em')?.textContent === "Plus");
    assert.equal((await app.page.textContent('[data-setting="subscription"] em')).trim(), "Plus");

    await app.page.click('[data-setting="subscription"]');
    await app.page.waitForSelector("#sheet[open] .subscription-overview");
    await app.page.waitForFunction(() => document.getElementById("subscription-offers")?.textContent.includes("499"));

    assert.equal((await app.page.textContent("#sheet-title")).trim(), "Подписка");
    assert.match(await app.page.textContent("#sheet-subtitle"), /Тариф и использование/i);
    assert.match(await app.page.textContent(".subscription-plan-card"), /Plus/);

    const sheetText = await app.page.textContent("#sheet-content");
    assert.doesNotMatch(sheetText, /Квота:/i);
    assert.doesNotMatch(sheetText, /messages_out|voice_in|voice_out/i);

    assert.equal(await app.page.locator('[data-quota-metric="messages"]').count(), 1);
    const messages = await app.page.textContent('[data-quota-metric="messages"]');
    assert.match(messages, /Сообщения Еве/i);
    assert.match(messages, /Осталось\s*23/i);
    assert.match(messages, /177 из 200 использовано/i);
    assert.equal(
      await app.page.getAttribute('[data-quota-metric="messages"] [role="progressbar"]', "aria-valuenow"),
      "89",
    );

    assert.match(await app.page.textContent('[data-quota-metric="voice_minutes"]'), /Осталось\s*36 мин/i);
    assert.match(await app.page.textContent('[data-quota-metric="web_search"]'), /Осталось\s*97/i);
    assert.equal(await app.page.locator('[data-quota-metric="documents"]').count(), 0);
    assert.equal(await app.page.locator('[data-quota-metric="images"]').count(), 1);

    const offers = await app.page.textContent("#subscription-offers");
    assert.match(offers, /Max · месяц/i);
    assert.match(offers, /499/);
    assert.ok(
      app.requests.some((request) => request.method === "GET" && request.path === "/public/subscription/offers"),
      "существующий серверный прайс должен остаться источником тарифов",
    );

    const width = await documentWidth(app.page);
    assert.equal(width.document, width.screen, "sheet подписки не должен растягивать страницу на 320px");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("безлимит Max показывается как безлимит, а не как null или техническая квота", async () => {
  const app = await openApp({
    routes: {
      "/public/session": {
        ...PLUS_SESSION,
        plan: "max",
        quotas: [
          { metric: "messages", period: "day", limit_value: -1, used: 400, remaining: null },
          { metric: "voice_minutes", period: "day", limit_value: -1, used: 120, remaining: null },
          { metric: "web_search", period: "day", limit_value: -1, used: 30, remaining: null },
          { metric: "messages_out", period: "day", limit_value: -1, used: 350, remaining: null },
        ],
      },
      "/public/subscription/offers": { offers: [], blocked_reason: "У вас максимальный тариф." },
    },
  });

  try {
    await app.openScreen("profile");
    await app.page.click('[data-setting="subscription"]');
    await app.page.waitForSelector("#sheet[open] .subscription-overview");

    assert.match(await app.page.textContent(".subscription-plan-card"), /Max/);
    assert.equal(await app.page.locator(".subscription-unlimited").count(), 3);
    assert.doesNotMatch(await app.page.textContent("#sheet-content"), /null|undefined|messages_out/i);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});
