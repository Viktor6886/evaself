/**
 * Раздел распознавания речи в браузере.
 *
 * Проверяется главное свойство раздела: форма строится по схеме,
 * которую отдаёт сервер, и ничего не знает о провайдерах сама. Плюс
 * отрицательные проверки, которые видно только здесь: сохранённый ключ
 * нельзя посмотреть, неподдерживаемый параметр не показывается вовсе,
 * а запись голоса не уезжает на сервер сама по себе.
 *
 * Подтверждения паролем в этом разделе больше нет — снято по решению
 * владельца, и тесты сторожат именно это: окно пароля не должно
 * появиться ни на одном действии.
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
      keys: { total: 2, usable: 1, exhausted: 1, invalid: 0 },
    },
  ],
};

const ROUTES_PAYLOAD = {
  routes: [
    {
      use_case: "telegram_voice",
      enabled: true,
      rotation_enabled: true,
      timeout_ms: 120000,
      max_audio_seconds: 1800,
      config_version: 4,
      chain: [{
        position: 0,
        config_id: "11111111-1111-1111-1111-111111111111",
        name: "Deepgram production",
        provider: "deepgram",
        model: "nova-3",
        status: "healthy",
      }],
    },
    {
      use_case: "webapp_voice_message",
      enabled: true, rotation_enabled: true, timeout_ms: 90000,
      max_audio_seconds: 600, config_version: 1, chain: [],
    },
  ],
};

const KEYS_PAYLOAD = {
  keys: [
    {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      label: "Основной", position: 0, enabled: true, status: "active",
      cooldown_until: null, last_error_code: null,
      success_count: 42, failure_count: 0,
    },
    {
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      label: "Резервный", position: 10, enabled: true, status: "exhausted",
      cooldown_until: "2099-01-01T00:00:00Z", last_error_code: "stt_rate_limited",
      success_count: 3, failure_count: 1,
    },
  ],
};

const BASE_ROUTES = {
  "/stt/provider-schemas": SCHEMAS,
  "/stt/configs": CONFIGS,
  "/stt/routes": ROUTES_PAYLOAD,
  "/stt/configs/11111111-1111-1111-1111-111111111111/keys": KEYS_PAYLOAD,
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
    // Не «настроен», а сколько ключей и сколько из них живы: пять
    // ключей при четырёх исчерпанных — это повод зайти внутрь.
    assert.match(card, /2 · 1 с исчерпанным лимитом/);
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

  test("сохранение уходит сразу, без подтверждения паролем", async () => {
    // Пароль на каждом шаге сняли по решению владельца: ключи вводят и
    // меняют часто, и за одну сессию его приходилось вводить десяток
    // раз. Защита осталась на входе в панель, на роли и в аудите.
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.evaluate(() => openSttEditor(null));
    await panel.page.waitForSelector("#stt-dialog[open]");
    await panel.page.fill("#stt-name", "Новый Deepgram");
    await panel.page.fill("#stt-api-key", "dg-secret-from-form");

    await panel.page.click("#stt-save");
    await panel.page.waitForTimeout(400);

    assert.equal(
      await panel.page.evaluate(() => !!document.querySelector("#sudo-dialog[open]")),
      false,
      "окно пароля больше не появляется",
    );
    const created = panel.requests.find(
      (item) => item.method === "POST" && item.path === "/stt/configs");
    assert.ok(created, "конфигурация должна уйти на сервер сразу");
    assert.equal(created.body.api_key, "dg-secret-from-form");
  });

  test("смена маршрута тоже уходит сразу", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelector("#stt-routes").hidden === false);

    await panel.page.click('[data-stt-action="save-route"]');
    await panel.page.waitForTimeout(400);

    assert.equal(
      await panel.page.evaluate(() => !!document.querySelector("#sudo-dialog[open]")),
      false,
    );
    assert.ok(panel.requests.some((item) => item.method === "PUT"
      && item.path.includes("/stt/routes/")));
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

  test("раздел живёт, когда media-service молчит", async () => {
    // Схемы нужны только редактору параметров. Конфигурации, ключи и
    // маршруты лежат в PostgreSQL, и недоступность media-service не
    // должна превращать раздел в мёртвую страницу.
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        "/stt/provider-schemas": {
          __status: 503,
          __body: { error: { message: "media-service недоступен" } },
        },
      },
    });
    await openStt(panel.page);

    const text = await panel.page.$eval("#page-stt", (node) => node.textContent);
    assert.match(text, /Deepgram production/, "карточки должны отрисоваться");
    assert.match(text, /media-service не отвечает/, "оператор должен понять, что недоступно");
    assert.ok(await panel.page.$('[data-stt-action="key"]'), "ключ схем не требует");
  });

  /** Открывает диалог ключей и раскрывает форму добавления. */
  const openKeys = async (page) => {
    await page.click('[data-stt-action="key"]');
    await page.waitForSelector("#stt-key-dialog[open]");
    await page.waitForFunction(
      () => document.querySelectorAll("#stt-key-list .key-row").length > 0);
    await page.evaluate(() => { document.querySelector("#stt-key-add").open = true; });
  };

  test("ввод ключа не уходит на сервер до подтверждения паролем", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await openKeys(panel.page);

    const field = await panel.page.$eval("#stt-key-value", (node) => ({
      type: node.type, value: node.value,
    }));
    assert.equal(field.type, "password");
    assert.equal(field.value, "", "сохранённый ключ обратно не показывается");

    await panel.page.fill("#stt-key-value", "dg-secret-from-form");
    await panel.page.click("#stt-key-save");
    await panel.page.waitForTimeout(400);

    assert.equal(
      await panel.page.evaluate(() => !!document.querySelector("#sudo-dialog[open]")),
      false,
      "пароль при вводе ключа больше не спрашивается",
    );
    const posted = panel.requests.find(
      (item) => item.method === "POST" && item.path.includes("/keys"));
    assert.ok(posted, "ключ должен уйти сразу");
    assert.equal(posted.body.api_key, "dg-secret-from-form");
  });

  test("список ключей показывает очередь и состояние, но не значения", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await openKeys(panel.page);

    const rows = await panel.page.$$eval(
      "#stt-key-list .key-row", (nodes) => nodes.map((node) => node.textContent));
    assert.equal(rows.length, 2);
    // Порядок строк — порядок перебора, и он должен быть виден: иначе
    // непонятно, какой ключ тратится первым.
    assert.match(rows[0], /Основной/);
    assert.match(rows[0], /1-й в очереди/);
    assert.match(rows[1], /Резервный/);
    assert.match(rows[1], /2-й в очереди/);
    assert.match(rows[1], /лимит исчерпан/);

    const dialog = await panel.page.$eval("#stt-key-dialog", (node) => node.innerHTML);
    assert.doesNotMatch(dialog, /dg-live|sha256:/);
  });

  test("выключение ключа тоже происходит сразу", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await openKeys(panel.page);

    await panel.page.click('[data-key-action="toggle"]');
    await panel.page.waitForTimeout(400);
    assert.equal(
      await panel.page.evaluate(() => !!document.querySelector("#sudo-dialog[open]")),
      false,
    );
    assert.ok(
      panel.requests.some((item) => item.method === "PATCH" && item.path.includes("/keys/")),
    );
  });

  test("каждое окно закрывается кнопкой «Назад»", async () => {
    // Раньше на телефоне окно закрыть было нечем: крестик уезжал вверх
    // вместе с прокруткой, и пользователь оставался в ловушке.
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);

    const cases = [
      ['[data-stt-action="key"]', "stt-key-dialog"],
      ['[data-stt-action="test"]', "stt-test-dialog"],
      ['[data-stt-action="edit"]', "stt-dialog"],
    ];
    for (const [opener, dialogId] of cases) {
      await panel.page.click(opener);
      await panel.page.waitForSelector(`#${dialogId}[open]`);

      const back = await panel.page.$eval(
        `#${dialogId} [data-close-dialog]`, (node) => {
          const box = node.getBoundingClientRect();
          return {
            text: node.textContent.trim(),
            // Шапка закреплена, поэтому кнопка обязана быть на экране
            // независимо от того, докуда прокручено окно.
            onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
          };
        });
      assert.match(back.text, /Назад/, `${dialogId}: нет кнопки «Назад»`);
      assert.equal(back.onScreen, true, `${dialogId}: кнопка «Назад» вне экрана`);

      await panel.page.click(`#${dialogId} [data-close-dialog]`);
      await panel.page.waitForTimeout(150);
      assert.equal(
        await panel.page.evaluate((id) => !!document.querySelector(`#${id}[open]`), dialogId),
        false,
        `${dialogId} не закрылось`,
      );
    }
  });

  test("окно проверки предлагает записать голос, а файл прячет во второй план", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="test"]');
    await panel.page.waitForSelector("#stt-test-dialog[open]");

    const record = await panel.page.$eval("#stt-record", (node) => ({
      text: node.textContent.replace(/\s+/g, " ").trim(),
      height: Math.round(node.getBoundingClientRect().height),
      primary: node.classList.contains("primary"),
    }));
    // Собственный голос — единственный способ проверить язык, акцент и
    // микрофон, поэтому это главное действие окна, а не поле формы.
    assert.match(record.text, /Записать голос/);
    assert.equal(record.primary, true);
    assert.ok(record.height >= 40, "кнопка записи должна быть крупной");

    // Выбор файла остаётся, но свёрнут: им пользуются редко.
    const collapsed = await panel.page.$eval(
      ".test-alt", (node) => ({ open: node.open, has: !!node.querySelector("#stt-test-file") }));
    assert.equal(collapsed.has, true);
    assert.equal(collapsed.open, false);
  });

  test("запись не уходит на сервер сама — только по кнопке проверки", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="test"]');
    await panel.page.waitForSelector("#stt-test-dialog[open]");

    // Подкладываем «запись» напрямую: настоящий микрофон в браузере
    // теста недоступен, а проверяем мы не MediaRecorder, а то, что
    // аудио попадает в запрос и только по явному действию.
    await panel.page.evaluate(() => {
      recorder.blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
    });
    assert.equal(
      panel.requests.some((item) => item.path.includes("/test")),
      false,
      "до нажатия проверки запрос уходить не должен",
    );

    await panel.page.click("#stt-test-run");
    await panel.page.waitForTimeout(500);
    const sent = panel.requests.find(
      (item) => item.method === "POST" && item.path.includes("/test"));
    assert.ok(sent, "проверка должна уйти на сервер");
    assert.equal(sent.body.audio_base64, "AQIDBA==", "запись должна доехать в base64");
  });

  test("закрытие окна проверки забывает запись", async () => {
    // Иначе голос из прошлой проверки уедет в следующую — и на другого
    // провайдера, где он ничего не проверяет.
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-action="test"]');
    await panel.page.waitForSelector("#stt-test-dialog[open]");
    await panel.page.evaluate(() => {
      recorder.blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    });

    await panel.page.click('#stt-test-dialog [data-close-dialog]');
    await panel.page.waitForTimeout(200);
    assert.equal(await panel.page.evaluate(() => recorder.blob), null);
  });

  test("проверка сообщает состояние каждого ключа, а не только итог", async () => {
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        // Первый ключ отвергнут, второй работает — конфигурация жива,
        // но администратор обязан узнать про первый.
        "POST /stt/configs/11111111-1111-1111-1111-111111111111/test": {
          success: true,
          provider: "deepgram", model: "nova-3",
          latency_ms: 300, audio_duration_ms: 3000,
          transcript: "Проверка", warnings: [],
          keys: [
            { id: "k1", label: "Основной", success: false, latency_ms: null,
              error_code: "stt_auth_failed", error_message: "Deepgram вернул HTTP 401" },
            { id: "k2", label: "Резервный", success: true, latency_ms: 300,
              error_code: null, error_message: null },
          ],
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
    assert.match(text, /Основной/);
    assert.match(text, /stt_auth_failed/);
    assert.match(text, /Резервный/);
    assert.match(text, /300 мс/);
  });

  test("без ключа проверка и активация недоступны", async () => {
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        "/stt/configs": {
          configs: [{
            ...CONFIGS.configs[0],
            id: "44444444-4444-4444-4444-444444444444",
            name: "Пресет без ключа",
            status: "draft",
            secret: { configured: false },
          }],
        },
      },
    });
    await openStt(panel.page);

    for (const action of ["test", "activate"]) {
      const disabled = await panel.page.$eval(
        `[data-stt-action="${action}"]`, (node) => node.disabled);
      assert.equal(disabled, true, `${action} без ключа работать не может`);
    }
    const primary = await panel.page.$eval('[data-stt-action="key"]', (node) => node.className);
    assert.match(primary, /primary/, "ввод ключа — главное действие пресета");
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

    // Deepgram уже в цепочке — в списке добавления его быть не должно,
    // зато он должен стоять первым звеном.
    const links = await panel.page.$$eval(
      '[data-route="telegram_voice"] .chain-link .chain-name strong',
      (nodes) => nodes.map((node) => node.textContent.trim()),
    );
    assert.deepEqual(links, ["Deepgram production"]);

    const options = await panel.page.$$eval(
      '[data-stt-chain-pick="telegram_voice"] option',
      (nodes) => nodes.map((node) => node.textContent),
    );
    // Ни конфигурация без ключа, ни архивная работать не смогут —
    // предлагать их в списке значит готовить отказ на проде.
    assert.ok(!options.some((text) => text.includes("Без ключа")));
    assert.ok(!options.some((text) => text.includes("Архивная")));
    assert.ok(!options.some((text) => text.includes("Deepgram production")),
      "уже стоящего в цепочке предлагать второй раз нельзя");
  });

  test("порядок в цепочке меняется и уходит на сервер целиком", async () => {
    const second = {
      ...CONFIGS.configs[0],
      id: "55555555-5555-5555-5555-555555555555",
      name: "OpenAI резервный", provider: "openai", model: "gpt-4o-transcribe",
    };
    const panel = await open({
      routes: {
        ...BASE_ROUTES,
        "/stt/configs": { configs: [...CONFIGS.configs, second] },
        "/stt/routes": {
          routes: [{
            ...ROUTES_PAYLOAD.routes[0],
            chain: [
              ROUTES_PAYLOAD.routes[0].chain[0],
              { position: 1, config_id: second.id, name: second.name,
                provider: "openai", model: "gpt-4o-transcribe", status: "healthy" },
            ],
          }],
        },
      },
    });
    await openStt(panel.page);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-routes .chain-link").length === 2);

    await panel.page.click('[data-stt-chain="up"][data-config="55555555-5555-5555-5555-555555555555"]');
    await panel.page.waitForTimeout(400);

    const sent = panel.requests.find(
      (item) => item.method === "PUT" && item.path.includes("/stt/routes/"));
    assert.ok(sent, "после подтверждения запрос должен уйти");
    // Цепочка отправляется целиком: позиции — свойство всего списка,
    // а не одного звена.
    assert.deepEqual(sent.body.chain, [
      "55555555-5555-5555-5555-555555555555",
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  test("ротацию можно выключить, и это отдельная настройка маршрута", async () => {
    const panel = await open({ routes: BASE_ROUTES });
    await openStt(panel.page);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-routes .status-card").length > 0);

    const toggle = '[data-route="telegram_voice"] [data-route-field="rotation_enabled"]';
    assert.equal(await panel.page.$eval(toggle, (node) => node.checked), true);

    await panel.page.uncheck(toggle);
    await panel.page.click('[data-stt-action="save-route"][data-id="telegram_voice"]');
    await panel.page.waitForTimeout(400);

    const sent = panel.requests.find(
      (item) => item.method === "PUT" && item.path.includes("/stt/routes/telegram_voice"));
    assert.equal(sent.body.rotation_enabled, false);
  });
});
