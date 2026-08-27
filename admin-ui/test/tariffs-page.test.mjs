/**
 * Вкладка «Тарифы».
 *
 * Проверяется то, что не видно в коде: что матрица действительно
 * заполняется присланными значениями, что пустой лимит уходит как
 * безлимит, а не как пропуск, и что читающая роль не получает ни одной
 * кнопки сохранения.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel, PHONE } from "./harness.mjs";

const TARIFFS = {
  plans: ["free", "plus", "max"],
  limit_periods: ["day", "week", "month"],
  price_periods: ["week", "month", "quarter"],
  metrics: [
    { metric: "messages", title: "Сообщения человека" },
    { metric: "messages_out", title: "Ответы Евы" },
    { metric: "voice_out", title: "Озвученные ответы" },
  ],
  limits: [
    { plan: "plus", metric: "messages", period: "day", limit_value: 200, free_value: 10 },
    { plan: "plus", metric: "messages", period: "month", limit_value: 4000, free_value: 0 },
    { plan: "max", metric: "messages", period: "day", limit_value: -1, free_value: 0 },
  ],
  prices: [
    { plan: "plus", period: "week", stars: 150, enabled: true, updated_at: "2026-08-27T10:00:00Z" },
    { plan: "max", period: "quarter", stars: 3000, enabled: true, updated_at: "2026-08-27T10:00:00Z" },
  ],
  usage: [
    { metric: "messages", period: "day", used: 842, users: 17 },
    { metric: "messages", period: "month", used: 19203, users: 41 },
  ],
  subscribers: [{ plan: "plus", people: 12 }, { plan: "max", people: 3 }],
};

const ROUTES = {
  "/tariffs": TARIFFS,
  // Запись тоже перехватывается: тест проверяет, что уходит наружу, а не
  // как это ляжет в базу.
  "PUT /tariffs/limits": { ok: true },
  "PUT /tariffs/prices": { ok: true },
};

describe("вкладка тарифов", () => {
  let panel;
  after(async () => await panel?.close());

  test("матрица заполнена присланными значениями, а не умолчаниями", async () => {
    panel = await openPanel({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("tariffs"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#tariff-limits [data-limit-plan]").length > 0);

    const cell = (plan, metric, period) => panel.page.$eval(
      `[data-limit-plan="${plan}"][data-limit-metric="${metric}"][data-limit-period="${period}"]`,
      (node) => node.value);
    assert.equal(await cell("plus", "messages", "day"), "200");
    assert.equal(await cell("plus", "messages", "month"), "4000");
    // Безлимит показывается как -1, а не как пустота: пустое поле
    // означает «лимита нет вовсе», и путать это нельзя.
    assert.equal(await cell("max", "messages", "day"), "-1");
    // Незаданный лимит — пустая клетка с подсказкой ∞.
    assert.equal(await cell("plus", "messages_out", "day"), "");

    const free = await panel.page.$eval(
      '[data-free-plan="plus"][data-free-metric="messages"]', (node) => node.value);
    assert.equal(free, "10");

    const price = await panel.page.$eval(
      '[data-price-plan="plus"][data-price-period="week"]', (node) => node.value);
    assert.equal(price, "150");
    // Бесплатный тариф не продаётся — карточки цены у него нет.
    assert.equal(await panel.page.$$eval('[data-price-plan="free"]', (n) => n.length), 0);

    const usage = await panel.page.textContent("#tariff-usage");
    assert.match(usage, /842/);
    assert.match(usage, /19203/);
  });

  test("пустой лимит сохраняется как безлимит, а не пропускается", async () => {
    const before = panel.requests.length;
    await panel.page.click('[data-save-limits="plus"]');
    // Сохранение идёт по клетке за запросом; ждём, пока пройдут все.
    await panel.page.waitForFunction(
      (from) => window.__lastTariffSave === true || document.querySelector(".toast"),
      {}, before).catch(() => {});
    await panel.page.waitForTimeout(600);

    const saved = panel.requests
      .slice(before)
      .filter((item) => item.path === "/tariffs/limits" && item.method === "PUT");
    assert.ok(saved.length > 0, "ни одного сохранения не ушло");
    const empty = saved.find(
      (item) => item.body.metric === "messages_out" && item.body.period === "day");
    assert.ok(empty, "пустая клетка не отправлена");
    assert.equal(empty.body.limit_value, -1, "пустое поле обязано снимать лимит");
    // Пробные заданы на сутки: в недельную строку они не дублируются.
    const week = saved.find(
      (item) => item.body.metric === "messages" && item.body.period === "week");
    assert.equal(week.body.free_value, 0);
  });

  test("читающая роль не получает ни одной кнопки сохранения", async () => {
    const viewer = await openPanel({ routes: ROUTES, role: "viewer", viewport: PHONE });
    try {
      await viewer.page.evaluate(() => openPage("tariffs"));
      await viewer.page.waitForFunction(
        () => document.querySelectorAll("#tariff-limits [data-limit-plan]").length > 0);
      const saves = await viewer.page.$$eval(
        "[data-save-limits], [data-save-prices]", (nodes) => nodes.length);
      assert.equal(saves, 0);
      const editable = await viewer.page.$$eval(
        "#page-tariffs input:not([disabled])", (nodes) => nodes.length);
      assert.equal(editable, 0, "поля читающей роли обязаны быть заблокированы");
    } finally {
      await viewer.close();
    }
  });
});
