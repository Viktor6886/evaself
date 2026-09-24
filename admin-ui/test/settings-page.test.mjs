/**
 * Системные настройки в браузере.
 *
 * Параметр с готовыми вариантами показывается списком: ручной ввод
 * позволил бы сохранить значение, которого сервис не знает. Версия для
 * If-Match берётся из тела ответа — заголовок ETag прокси ослабляет при
 * сжатии.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const setting = (overrides) => ({
  group: "runtime",
  required: true,
  requires_restart: false,
  description: "",
  affects: ["telegram-runtime"],
  recommended: "Проверка",
  configured: false,
  version: 0,
  updated_at: null,
  ...overrides,
});

const settingsPayload = (mode) => ({
  etag: "\"cfg-7\"",
  version: 7,
  missing_required: 0,
  profiles: [],
  settings: [
    setting({
      key: "runtime.telegram_stream_mode",
      env: "EVA_TELEGRAM_STREAM_MODE",
      title: "Как Ева печатает ответ",
      type: "select",
      default: "edit",
      value: mode,
      presets: [
        { value: "edit", title: "Правкой сообщения (как раньше)" },
        { value: "draft", title: "Черновиком (draft)" },
      ],
    }),
  ],
});

describe("системные настройки", () => {
  const panels = [];
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  test("режим печати выбирается списком и сохраняется выбранным значением", async () => {
    let mode = "edit";
    const panel = await openPanel({
      routes: {
        "/settings": () => settingsPayload(mode),
        "PUT /settings": () => {
          mode = "draft";
          return settingsPayload(mode);
        },
      },
    });
    panels.push(panel);
    const { page } = panel;
    await page.evaluate(() => openPage("settings"));

    const select = 'select[data-key="runtime.telegram_stream_mode"]';
    await page.waitForSelector(select);
    assert.equal(await page.inputValue(select), "edit");
    const options = await page.$$eval(`${select} option`, (nodes) =>
      nodes.map((node) => [node.value, node.textContent]));
    assert.deepEqual(options, [
      ["edit", "Правкой сообщения (как раньше)"],
      ["draft", "Черновиком (draft)"],
    ]);
    // Второго списка «готовых значений» рядом нет: варианты уже в поле.
    assert.equal(await page.locator('[data-preset-for="runtime.telegram_stream_mode"]').count(), 0);

    await page.selectOption(select, "draft");
    await page.click("#save-settings");
    const saved = await panel.waitForRequest(
      (item) => item.method === "PUT" && item.path === "/settings",
    );
    assert.ok(saved, "сохранение не ушло на сервер");
    assert.equal(saved.body.settings["runtime.telegram_stream_mode"], "draft");
  });
});
