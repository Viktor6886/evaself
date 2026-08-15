/**
 * Раздел синтеза речи в браузере.
 *
 * Раздел появился как read-only сводка с кнопкой, открывавшей чужое
 * модальное окно, — кнопка не работала вовсе, а поля выглядели формой,
 * но не принимали ввод. Здесь сторожится именно это: поля редактируются
 * на самой странице, значения уходят на сервер такими, какими их ввели,
 * и проверка синтеза вызывает свой маршрут.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const VOICES = ["Achernar", "Kore", "Zephyr"];

const CONFIG = {
  id: "tts",
  title: "Синтез речи",
  purpose: "Голосовые ответы Евы",
  editable: true,
  restart_required: null,
  note: "OpenRouter принимает тот же OpenAI-совместимый /audio/speech.",
  last_check: null,
  fields: [
    {
      name: "provider", kind: "select", title: "Провайдер", hint: "", value: "",
      required: false, configured: false,
      options: [
        { value: "openrouter", title: "OpenRouter (Gemini TTS)" },
        { value: "openai", title: "OpenAI TTS" },
      ],
    },
    { name: "base_url", kind: "url", title: "Base URL", hint: "", value: "", required: true, configured: false },
    { name: "api_key", kind: "secret", title: "API Token", hint: "", value: "", required: true, configured: false },
    { name: "model", kind: "text", title: "Модель", hint: "", value: "tts-1", required: false, configured: true },
    {
      name: "voice", kind: "select", title: "Голос", hint: "", value: "", required: false, configured: false,
      options: VOICES.map((name) => ({ value: name, title: name })),
    },
    { name: "language", kind: "text", title: "Язык", hint: "", value: "", required: false, configured: false },
    { name: "voice_prompt", kind: "textarea", title: "Voice Prompt", hint: "", value: "", required: false, configured: false },
  ],
};

describe("раздел синтеза речи", () => {
  let panel;
  after(async () => { await panel?.close(); });

  test("поля редактируются на странице, а значения уходят на сервер", async () => {
    panel = await openPanel({
      routes: {
        "/integrations/tts/config": CONFIG,
        "PUT /integrations/tts/config": { ...CONFIG, applied_live: true },
        "POST /integrations/tts/test": { ok: true, message: "Синтез выполнен", latency_ms: 812, model: "google/gemini-3.1-flash-tts-preview", voice: "Kore" },
      },
    });
    const { page, requests } = panel;

    await page.click('.nav-item[data-page="tts"]');
    await page.waitForSelector("#tts-form select[name=provider]");

    // Раздел строит форму сам, а не показывает текст вместо полей.
    assert.equal(await page.locator("#tts-form input[name=model]").inputValue(), "tts-1");
    assert.equal(await page.locator("#tts-form textarea[name=voice_prompt]").count(), 1);
    assert.deepEqual(
      await page.locator("#tts-form select[name=voice] option").allTextContents(),
      ["—", ...VOICES],
    );

    // Ввод действительно принимается: это и был симптом.
    await page.selectOption("#tts-form select[name=provider]", "openrouter");
    await page.fill("#tts-form input[name=base_url]", "https://openrouter.ai/api/v1");
    await page.fill("#tts-form input[name=model]", "google/gemini-3.1-flash-tts-preview");
    await page.selectOption("#tts-form select[name=voice]", "Kore");
    await page.fill("#tts-form input[name=language]", "ru");
    await page.fill("#tts-form textarea[name=voice_prompt]", "Тёплый голос, спокойный темп");
    assert.equal(
      await page.locator("#tts-form input[name=model]").inputValue(),
      "google/gemini-3.1-flash-tts-preview",
    );

    await page.click("#tts-save");
    // Пароль при сохранении не спрашивается — решение владельца, то же
    // самое, что в разделе распознавания речи. Тест сторожит именно это:
    // окно пароля не должно появиться, а значения обязаны уйти сразу.
    await page.waitForFunction(
      () => document.querySelector("#tts-form select[name=provider]") !== null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.evaluate(() => !!document.querySelector("#sudo-dialog[open]")),
      false,
      "появилось окно пароля",
    );

    const saved = requests.find((item) => item.method === "PUT" && item.path === "/integrations/tts/config");
    assert.ok(saved, `запрос сохранения не ушёл: ${JSON.stringify(requests.map((r) => `${r.method} ${r.path}`))}`);
    assert.equal(saved.body.provider, "openrouter");
    assert.equal(saved.body.model, "google/gemini-3.1-flash-tts-preview");
    assert.equal(saved.body.voice, "Kore");
    assert.equal(saved.body.language, "ru");
    assert.equal(saved.body.voice_prompt, "Тёплый голос, спокойный темп");
  });

  test("проверка синтеза вызывает свой маршрут и показывает исход", async () => {
    const { page, requests } = panel;
    await page.click("#tts-test");
    await page.waitForSelector("#tts-test-result.is-ok", { timeout: 10_000 });
    assert.match(await page.locator("#tts-test-result").textContent(), /812 мс/);
    assert.ok(requests.some((item) => item.method === "POST" && item.path === "/integrations/tts/test"));
  });
  test("на телефоне раздел открывается через шторку и остаётся редактируемым", async () => {
    // Панелью пользуются с телефона, а там меню за шторкой и над
    // страницей лежит затемнение. Если оно перестанет пропускать
    // касания, форма визуально останется на месте, но перестанет
    // принимать ввод — симптом, неотличимый от «поля не работают».
    const mobile = await openPanel({
      routes: { "/integrations/tts/config": { ...CONFIG, last_check: { state: "disabled", color: "gray", message: "Интеграция не включена", checked_at: null } } },
      viewport: { width: 390, height: 844 },
    });
    try {
      await mobile.page.click("#menu");
      await mobile.page.click('.nav-item[data-page="tts"]');
      await mobile.page.waitForSelector("#tts-form input[name=base_url]");
      await mobile.page.fill("#tts-form input[name=base_url]", "https://openrouter.ai/api/v1");
      await mobile.page.selectOption("#tts-form select[name=voice]", "Kore");
      assert.equal(
        await mobile.page.locator("#tts-form input[name=base_url]").inputValue(),
        "https://openrouter.ai/api/v1",
      );
      assert.equal(await mobile.page.locator("#tts-save").isDisabled(), false);
    } finally {
      await mobile.close();
    }
  });
});
