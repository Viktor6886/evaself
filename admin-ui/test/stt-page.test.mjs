/**
 * Раздел распознавания речи в браузере.
 *
 * Проверяется главное свойство раздела: форма строится по схеме,
 * которую отдаёт сервер, и ничего не знает о провайдерах сама. Плюс
 * отрицательные проверки, которые видно только здесь: сохранённый ключ
 * нельзя посмотреть, мутация не уходит до подтверждения sudo, а
 * неподдерживаемый параметр не показывается вовсе.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

/** Урезанные схемы: ровно то, что нужно проверяемым свойствам. */
const SCHEMAS = {
  providers: [
    {
      provider: "deepgram",
      label: "Deepgram",
      summary: "Собственные модели Deepgram.",
      default_base_url: "https://api.deepgram.com/v1/listen",
      default_streaming_base_url: "wss://api.deepgram.com/v1/listen",
      verified_on: "2026-07-31",
      capabilities: {
        batch: true, streaming: true, interim_results: true, endpointing: true,
        word_timestamps: true, segment_timestamps: true, diarization: true,
        language_detection: true, multiple_languages: true, custom_vocabulary: true,
        transcript_normalization: true, confidence: true,
        supported_audio_formats: ["wav"],
      },
      model_presets: [
        { value: "nova-3", label: "nova-3", hint: "Актуальная модель" },
        { value: "nova-2", label: "nova-2" },
      ],
      fields: [
        { name: "language", kind: "text", label: "Язык", section: "model" },
        { name: "punctuate", kind: "boolean", label: "Пунктуация", section: "formatting", default: true },
        {
          name: "diarize", kind: "boolean", label: "Разделять говорящих",
          section: "features", requires_capability: "diarization",
        },
        {
          name: "keyterms", kind: "string_list", label: "Ключевые термины",
          section: "features", requires_capability: "custom_vocabulary",
        },
        {
          name: "interim_results", kind: "boolean", label: "Промежуточные результаты",
          section: "advanced", requires_capability: "interim_results", only_mode: "streaming",
        },
      ],
    },
    {
      provider: "openai",
      label: "OpenAI",
      summary: "Whisper и gpt-4o-transcribe.",
      default_base_url: "https://api.openai.com/v1",
      default_streaming_base_url: "",
      verified_on: "2026-07-31",
      // Ключевое отличие: потока нет, уверенности нет.
      capabilities: {
        batch: true, streaming: false, interim_results: false, endpointing: false,
        word_timestamps: true, segment_timestamps: true, diarization: false,
        language_detection: true, multiple_languages: true, custom_vocabulary: false,
        transcript_normalization: false, confidence: false,
        supported_audio_formats: ["wav"],
      },
      model_presets: [{ value: "whisper-1", label: "whisper-1" }],
      fields: [
        { name: "language", kind: "text", label: "Язык", section: "model" },
        {
          name: "diarize", kind: "boolean", label: "Разделять говорящих",
          section: "features", requires_capability: "diarization",
        },
      ],
    },
  ],
};

const CONFIGS = {
  configs: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Deepgram production",
      provider: "deepgram",
      mode: "batch",
      base_url: "https://api.deepgram.com/v1/listen",
      model: "nova-3",
      public_config: { language: "ru", punctuate: true, keyterms: ["Ева"] },
      status: "healthy",
      config_version: 3,
      archived: false,
      used_by: ["telegram_voice"],
      last_test: { at: "2026-07-31T08:00:00Z", ok: true, latency_ms: 420 },
      secret: { configured: true, updated_at: "2026-07-30T10:00:00Z", fingerprint: "sha256:ab12cd34ef56" },
    },
  ],
};

const ROUTES_PAYLOAD = {
  routes: [
    {
      use_case: "telegram_voice",
      enabled: true,
      timeout_ms: 120000,
      max_audio_seconds: 1800,
      config_version: 4,
      primary_config_id: "11111111-1111-1111-1111-111111111111",
      fallback_config_id: null,
    },
    {
      use_case: "webapp_voice_message",
      enabled: true, timeout_ms: 90000, max_audio_seconds: 600,
      config_version: 1, primary_config_id: null, fallback_config_id: null,
    },
  ],
};

const BASE_ROUTES = {
  "/stt/provider-schemas": SCHEMAS,
  "/stt/configs": CONFIGS,
  "/stt/routes": ROUTES_PAYLOAD,
};

const openStt = async (page) => {
  await page.evaluate(() => openPage("stt"));
  await page.waitForFunction(
    () => document.querySelector("#page-stt").classList.contains("active"));
  await page.waitForFunction(
    () => document.querySelectorAll("#stt-configs .status-card").length > 0);
};

describe("раздел распознавания речи", () => {
  // Упавший тест не должен оставлять браузер открытым: живой процесс
  // chromium держит node --test, и прогон повисает вместо того, чтобы
  // показать падение. Поэтому панели собираются здесь и закрываются все.
  const panels = [];
  const open = async (options) => {
    const panel = await openPanel(options);
    panels.push(panel);
    return panel;
  };
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  test("карточка показывает состояние, но не сам ключ", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);

    const card = await panel.page.$eval("#stt-configs .status-card", (node) => node.textContent);
    assert.match(card, /Deepgram production/);
    assert.match(card, /nova-3/);
    assert.match(card, /Настроен/);
    assert.match(card, /Голосовые в Telegram/);
    // Отпечаток — служебное значение, ему не место на карточке, а
    // самого ключа тут нет и подавно.
    assert.doesNotMatch(card, /sha256:/);

    const section = await panel.page.$eval("#page-stt", (node) => node.innerHTML);
    assert.doesNotMatch(section, /dg-live|sha256:/);
  });

  test("форма строится по схеме сервера, а не по коду панели", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="edit"]');
    await panel.page.waitForSelector("#stt-dialog[open]");

    const fields = await panel.page.$$eval(
      "#stt-form [data-stt-field]", (nodes) => nodes.map((node) => node.dataset.sttField));
    assert.ok(fields.includes("language"), "поле из схемы должно появиться");
    assert.ok(fields.includes("punctuate"));
    assert.ok(fields.includes("keyterms"));

    // Дата сверки с документацией видна администратору: список моделей
    // не вечен, и он должен понимать, насколько свежий перед ним.
    const hint = await panel.page.$eval("#stt-dialog-hint", (node) => node.textContent);
    assert.match(hint, /2026-07-31/);
  });

  test("параметр, который провайдер не поддерживает, не показывается", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.evaluate(() => openSttEditor(null));
    await panel.page.waitForSelector("#stt-dialog[open]");

    // Deepgram умеет диаризацию — поле есть.
    let fields = await panel.page.$$eval(
      "#stt-form [data-stt-field]", (nodes) => nodes.map((node) => node.dataset.sttField));
    assert.ok(fields.includes("diarize"), "Deepgram поддерживает диаризацию");

    await panel.page.selectOption("#stt-provider", "openai");
    await panel.page.waitForFunction(
      () => !document.querySelector('#stt-form [data-stt-field="diarize"]'));

    fields = await panel.page.$$eval(
      "#stt-form [data-stt-field]", (nodes) => nodes.map((node) => node.dataset.sttField));
    assert.ok(!fields.includes("diarize"), "OpenAI диаризацию не умеет — поля быть не должно");

    // Режима streaming у OpenAI тоже нет: предлагать его значило бы
    // обещать то, чего адаптер не делает.
    const modes = await panel.page.$$eval(
      "#stt-mode option", (nodes) => nodes.map((node) => node.value));
    assert.deepEqual(modes, ["batch"]);
  });

  test("параметр только для потока скрыт в пакетном режиме", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.evaluate(() => openSttEditor(null));
    await panel.page.waitForSelector("#stt-dialog[open]");

    let fields = await panel.page.$$eval(
      "#stt-form [data-stt-field]", (nodes) => nodes.map((node) => node.dataset.sttField));
    assert.ok(!fields.includes("interim_results"), "в batch промежуточных результатов быть не может");

    await panel.page.selectOption("#stt-mode", "streaming");
    await panel.page.waitForFunction(
      () => Boolean(document.querySelector('#stt-form [data-stt-field="interim_results"]')));

    // И адрес должен смениться на wss:// — иначе адаптер отвергнет.
    const baseUrl = await panel.page.$eval("#stt-base-url", (node) => node.value);
    assert.match(baseUrl, /^wss:\/\//);
  });

  test("модель допускает ручной ввод", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.evaluate(() => openSttEditor(null));
    await panel.page.waitForSelector("#stt-dialog[open]");

    assert.equal(await panel.page.$eval("#stt-model-custom-wrap", (node) => node.hidden), true);
    await panel.page.selectOption("#stt-model-preset", "__custom__");
    await panel.page.waitForFunction(
      () => document.querySelector("#stt-model-custom-wrap").hidden === false);
    // Неизвестная модель не должна требовать правки frontend-кода.
    await panel.page.fill("#stt-model-custom", "nova-4-experimental");
    const collected = await panel.page.evaluate(() => collectSttForm().model);
    assert.equal(collected, "nova-4-experimental");
  });

  test("поле ключа не раскрывает сохранённое значение", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="edit"]');
    await panel.page.waitForSelector("#stt-dialog[open]");

    const key = await panel.page.$eval("#stt-api-key", (node) => ({
      type: node.type, value: node.value, placeholder: node.placeholder,
    }));
    assert.equal(key.type, "password");
    // Пустое поле означает «оставить прежний», а не «стереть».
    assert.equal(key.value, "");
    assert.match(key.placeholder, /Настроен/);
    // Кнопки «показать сохранённый ключ» не существует — её и не должно быть.
    const reveal = await panel.page.$('[data-stt-action="reveal-secret"]');
    assert.equal(reveal, null);
  });

  test("сохранение не уходит на сервер до подтверждения паролем", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.evaluate(() => openSttEditor(null));
    await panel.page.waitForSelector("#stt-dialog[open]");
    await panel.page.fill("#stt-name", "Новый Deepgram");
    await panel.page.fill("#stt-api-key", "dg-secret-from-form");

    await panel.page.click("#stt-save");
    await panel.page.waitForSelector("#sudo-dialog[open]");

    const mutations = panel.requests.filter(
      (item) => item.method !== "GET" && item.path.startsWith("/stt"));
    assert.deepEqual(mutations, [], "до подтверждения sudo мутаций быть не должно");
    // И ключ из формы никуда не улетел.
    assert.equal(
      panel.requests.some((item) => JSON.stringify(item.body ?? "").includes("dg-secret-from-form")),
      false,
    );
  });

  test("смена маршрута тоже требует подтверждения", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelector("#stt-routes").hidden === false);

    await panel.page.click('[data-stt-action="save-route"]');
    await panel.page.waitForSelector("#sudo-dialog[open]");

    const puts = panel.requests.filter((item) => item.method === "PUT");
    assert.deepEqual(puts, [], "маршрут не должен меняться до подтверждения");
  });

  test("результат проверки не показывает того, чего провайдер не вернул", async () => {
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        // OpenAI не возвращает confidence — поля в ответе просто нет.
        "POST /stt/configs/11111111-1111-1111-1111-111111111111/test": {
          success: true,
          provider: "openai",
          model: "whisper-1",
          latency_ms: 640,
          audio_duration_ms: 3000,
          transcript: "Проверка распознавания",
          language: "ru",
          warnings: [],
        },
      },
    });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="test"]');
    await panel.page.waitForSelector("#stt-test-dialog[open]");
    await panel.page.click("#stt-test-run");
    await panel.page.waitForFunction(
      () => document.querySelector("#stt-test-result").textContent.includes("Успешно"));

    const text = await panel.page.$eval("#stt-test-result", (node) => node.textContent);
    assert.match(text, /Проверка распознавания/);
    assert.match(text, /640 мс/);
    // Выдуманная уверенность хуже отсутствующей: по ней оператор примет
    // решение, думая, что видит измеренное число.
    assert.doesNotMatch(text, /Уверенность/);
  });

  test("провал проверки объясняется, а не молчит", async () => {
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        "POST /stt/configs/11111111-1111-1111-1111-111111111111/test": {
          success: false,
          error: { code: "stt_auth_failed", message: "Deepgram вернул HTTP 401" },
        },
      },
    });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="test"]');
    await panel.page.waitForSelector("#stt-test-dialog[open]");
    await panel.page.click("#stt-test-run");
    await panel.page.waitForFunction(
      () => document.querySelector("#stt-test-result").textContent.includes("Не удалось"));

    const text = await panel.page.$eval("#stt-test-result", (node) => node.textContent);
    assert.match(text, /401/);
    assert.match(text, /stt_auth_failed/);
  });

  test("в маршруте выбираются только рабочие конфигурации", async () => {
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        "/stt/configs": {
          configs: [
            ...CONFIGS.configs,
            {
              id: "22222222-2222-2222-2222-222222222222",
              name: "Без ключа", provider: "openai", mode: "batch",
              base_url: "https://api.openai.com/v1", model: "whisper-1",
              public_config: {}, status: "draft", config_version: 1,
              archived: false, used_by: [], last_test: {},
              secret: { configured: false },
            },
            {
              id: "33333333-3333-3333-3333-333333333333",
              name: "Архивная", provider: "openai", mode: "batch",
              base_url: "https://api.openai.com/v1", model: "whisper-1",
              public_config: {}, status: "archived", config_version: 1,
              archived: true, used_by: [], last_test: {},
              secret: { configured: true },
            },
          ],
        },
      },
    });
    await openStt(panel.page);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelector("#stt-routes").hidden === false);

    const options = await panel.page.$$eval(
      '[data-route="telegram_voice"] [data-route-field="primary_config_id"] option',
      (nodes) => nodes.map((node) => node.textContent),
    );
    assert.ok(options.some((text) => text.includes("Deepgram production")));
    // Ни конфигурация без ключа, ни архивная работать не смогут —
    // предлагать их в списке значит готовить отказ на проде.
    assert.ok(!options.some((text) => text.includes("Без ключа")));
    assert.ok(!options.some((text) => text.includes("Архивная")));
  });
});
