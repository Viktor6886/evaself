/**
 * Флажки редактора провайдера.
 *
 * Общее правило для полей ввода задаёт width:100% и min-height:44px.
 * Флажки под него тоже попадали и превращались в огромные квадраты,
 * растянутые по высоте подписи: у двухстрочных подписей они выходили
 * вдвое больше, чем у однострочных, и ряд разъезжался. Заметно это только
 * в браузере — разметка при этом совершенно правильная.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

/**
 * Провайдер приходит из /llm/state — того же ответа, что рисует карточку.
 * Отдельного /providers у раздела больше нет, и редактор обязан находить
 * в этой записи все свои поля: пропущенное поле молча затирается
 * умолчанием при первом же сохранении.
 */
const SAVED = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "OpenRouter", protocol: "openai-compatible",
  base_url: "https://openrouter.ai/api/v1", model: "minimax/minimax-m3",
  context_window: 262144, enabled: true, api_key_configured: true,
  quality_tier: 3, sensitive_data_allowed: true, priority: 7,
  supports_tools: true, supports_json: true, supports_vision: true, supports_streaming: false,
  max_output_tokens: 8192, max_retries: 4, max_concurrency: 6,
  max_rpm: 240, max_tpm: 400000, price_in_micro: 15, price_out_micro: 60,
  daily_budget_micro: 5000000, monthly_budget_micro: 120000000,
  additional_parameters: { request_timeout_ms: 90000 },
  status: { code: "ok", label: "работает", color: "green", detail: { check: "ok", router: "closed" } },
  routes: [], single_selected: false,
};

const ROUTES = {
  "/llm/state": { providers: [], routes: [], breakers: [] },
  "/llm/usage": { rows: [] },
  "/providers": { providers: [] },
};

const WITH_PROVIDER = {
  ...ROUTES,
  "/llm/state": {
    providers: [SAVED], routes: [], recent_failures: [],
    routing_settings: { mode: "adaptive" },
  },
};

describe("флажки редактора провайдера", () => {
  let panel;
  after(async () => await panel?.close());

  test("все одного размера и не растянуты подписью", async () => {
    panel = await openPanel({ routes: ROUTES });
    // Скрытый элемент измерить нельзя: сначала раздел, потом редактор.
    await panel.page.evaluate(() => openPage("ai"));
    await panel.page.waitForFunction(
      () => document.querySelector("#page-ai").classList.contains("active"));
    await panel.page.evaluate(() => openProviderEditor(null));
    await panel.page.waitForFunction(
      () => !document.querySelector("#provider-editor").hidden);
    // Флажки переехали в «Дополнительно»: свёрнутый блок не измерить,
    // у скрытого элемента нулевой прямоугольник.
    await panel.page.evaluate(() => {
      document.querySelector("#provider-form .advanced-block").open = true;
    });

    const boxes = await panel.page.$$eval(
      '.router-flags input[type="checkbox"]',
      (nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.name, w: Math.round(rect.width), h: Math.round(rect.height) };
      }),
    );

    // Возможности модели выясняет проба, и обычно их не трогают: галочка
    // вместо факта либо уводит запрос к модели, которая его не потянет,
    // либо прячет пригодную. Из формы их поэтому и убирали.
    //
    // Вернули по обратной причине: запись пробы бывает неверной. Отказ,
    // который о модели ничего не говорил, оставлял в базе «инструменты не
    // поддерживаются», провайдер выпадал из всех маршрутов, и снять это
    // было нечем — у занятого провайдера новая проба отвечает лимитом и
    // прежнее значение не трогает. Дверь обязана открываться в обе
    // стороны; следующая удачная проверка правку перепишет.
    assert.ok(boxes.length >= 2, `ожидались флажки редактора, найдено ${boxes.length}`);
    const names = boxes.map((box) => box.name).sort();
    assert.deepEqual(names, [
      "enabled", "sensitive_data_allowed",
      "supports_json", "supports_streaming", "supports_tools", "supports_vision",
    ], `состав флажков редактора изменился: ${names.join(", ")}`);

    const widths = new Set(boxes.map((b) => b.w));
    const heights = new Set(boxes.map((b) => b.h));
    assert.equal(widths.size, 1, `флажки разной ширины: ${JSON.stringify(boxes)}`);
    assert.equal(heights.size, 1, `флажки разной высоты: ${JSON.stringify(boxes)}`);

    const [{ w, h }] = boxes;
    assert.ok(w > 0 && w <= 24, `флажок шириной ${w}px — это уже не флажок`);
    assert.ok(h > 0 && h <= 24, `флажок высотой ${h}px — это уже не флажок`);
  });

  test("новый провайдер по умолчанию допущен к личным данным", async () => {
    // Иначе роутер отвергнет весь его трафик как чувствительный, а
    // оператор увидит лишь 503 без понятной причины.
    const checked = await panel.page.evaluate(() => {
      openProviderEditor(null);
      return document.querySelector('[name="sensitive_data_allowed"]').checked;
    });
    assert.equal(checked, true);
  });
});

describe("редактор открывается из состояния роутера", () => {
  let panel;
  after(async () => await panel?.close());

  test("все сохранённые поля подставлены, ключ не приходит в браузер", async () => {
    panel = await openPanel({ routes: WITH_PROVIDER });
    await panel.page.evaluate(() => openPage("ai"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#providers-list .provider-card").length > 0);
    // Открываем ровно так, как это делает человек, — кнопкой карточки.
    await panel.page.click('#providers-list [data-provider-action="edit"]');
    await panel.page.waitForFunction(
      () => !document.querySelector("#provider-editor").hidden);

    const filled = await panel.page.evaluate(() => {
      const form = document.querySelector("#provider-form");
      const value = (name) => {
        const field = form.elements[name];
        return field.type === "checkbox" ? field.checked : field.value;
      };
      return {
        name: value("name"), protocol: value("protocol"), base_url: value("base_url"),
        model: value("model"), context_window: value("context_window"),
        timeout_ms: value("timeout_ms"), max_output_tokens: value("max_output_tokens"),
        max_retries: value("max_retries"), max_concurrency: value("max_concurrency"),
        max_rpm: value("max_rpm"), max_tpm: value("max_tpm"),
        price_in: value("price_in"), price_out: value("price_out"),
        daily: value("daily_budget"), monthly: value("monthly_budget"),
        quality: value("quality_tier"), priority: value("priority"),
        vision: value("supports_vision"), streaming: value("supports_streaming"),
        enabled: value("enabled"), sensitive: value("sensitive_data_allowed"),
      };
    });

    assert.equal(filled.name, "OpenRouter");
    assert.equal(filled.base_url, "https://openrouter.ai/api/v1");
    assert.equal(filled.model, "minimax/minimax-m3");
    assert.equal(filled.context_window, "262144");
    // Таймаут лежит в additional_parameters — его тоже нельзя потерять.
    assert.equal(filled.timeout_ms, "90000");
    assert.equal(filled.max_output_tokens, "8192");
    assert.equal(filled.max_retries, "4");
    assert.equal(filled.max_concurrency, "6");
    assert.equal(filled.max_rpm, "240");
    assert.equal(filled.max_tpm, "400000");
    // Цены и бюджеты форма показывает в валюте, а не в микроединицах.
    assert.equal(filled.price_in, "0.000015");
    assert.equal(filled.price_out, "0.00006");
    assert.equal(filled.daily, "5");
    assert.equal(filled.monthly, "120");
    assert.equal(filled.quality, "3");
    assert.equal(filled.priority, "7");
    // Возможности выяснила проба — редактор переносит их как есть, а не
    // сбрасывает на умолчание. Правятся они галочками: неверную запись
    // пробы иначе не снять, а провайдер с ней выпадает из всех маршрутов.
    assert.equal(filled.vision, true);
    assert.equal(filled.streaming, false);
    assert.equal(filled.enabled, true);
    assert.equal(filled.sensitive, true);

    // API key остаётся write-only: в разметке страницы его нет.
    const markup = await panel.page.content();
    assert.doesNotMatch(markup, /api_key_encrypted|sk-/);
    // И раздел не ходил за вторым представлением провайдера.
    assert.equal(panel.countTo("/providers"), 0);
  });
});
