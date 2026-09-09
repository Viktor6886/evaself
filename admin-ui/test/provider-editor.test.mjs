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

/**
 * Завести провайдера с нативным протоколом.
 *
 * Адаптеров в роутере четыре, схема принимает все четыре, а панель
 * предлагала два: Gemini и Responses не заводились из неё вовсе. Плюс
 * два поля, которых в форме не было совсем, — таймаут подключения и
 * параметры генерации, — из-за чего конфигурацию приходилось дописывать
 * запросом к API мимо панели.
 */
describe("создание провайдера с нативным протоколом", () => {
  let panel;
  after(async () => await panel?.close());

  test("Gemini заводится целиком: протокол, таймаут подключения и параметры генерации", async () => {
    panel = await openPanel({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("ai"));
    await panel.page.waitForFunction(
      () => document.querySelector("#page-ai").classList.contains("active"));
    await panel.page.evaluate(() => openProviderEditor(null));
    await panel.page.waitForFunction(
      () => !document.querySelector("#provider-editor").hidden);

    // Все четыре адаптера роутера доступны из панели.
    const protocols = await panel.page.$$eval(
      '#provider-form select[name="protocol"] option', (nodes) => nodes.map((n) => n.value));
    assert.deepEqual(protocols.sort(), [
      "anthropic-compatible", "gemini-compatible", "openai-compatible", "openai-responses",
    ]);

    await panel.page.evaluate(() => {
      const form = document.querySelector("#provider-form");
      form.elements.name.value = "Google Gemini 3.7 Flash";
      form.elements.protocol.value = "gemini-compatible";
      form.elements.base_url.value = "https://generativelanguage.googleapis.com/v1beta";
      form.elements.model.value = "gemini-3.7-flash";
      form.elements.api_key.value = "test-key";
      form.elements.context_window.value = "1000000";
      form.elements.max_output_tokens.value = "65536";
      form.elements.connect_timeout_ms.value = "10000";
      form.elements.request_timeout_ms.value = "180000";
      form.elements.max_retries.value = "3";
      form.elements.max_concurrency.value = "4";
      form.elements.priority.value = "100";
      form.elements.quality_tier.value = "3";
      form.elements.supports_vision.checked = true;
      form.elements.sensitive_data_allowed.checked = true;
      form.elements.generation_defaults.value =
        '{"generationConfig":{"temperature":0.7,"topP":0.95}}';
      form.requestSubmit();
    });
    await panel.page.waitForFunction(
      () => document.querySelector("#provider-editor").hidden);

    const created = panel.requests.find((item) => item.path === "/providers" && item.method === "POST");
    assert.ok(created, "создание провайдера не отправлено");
    assert.equal(created.body.protocol, "gemini-compatible");
    // Путь у Gemini свой и /v1 к нему дописывать нельзя.
    assert.equal(created.body.base_url, "https://generativelanguage.googleapis.com/v1beta");
    assert.equal(created.body.context_window, 1000000);

    const routing = panel.requests.find((item) => item.path.startsWith("/llm/providers/") && item.method === "PATCH");
    assert.ok(routing, "поля маршрутизации не отправлены");
    assert.equal(routing.body.connect_timeout_ms, 10000);
    assert.equal(routing.body.request_timeout_ms, 180000);
    // Три повтора и 180 секунд — требование самого провайдера: у него
    // регулярные 503 high demand, и с двумя повторами ход срывается.
    assert.equal(routing.body.max_retries, 3);
    assert.equal(routing.body.max_concurrency, 4);
    assert.equal(routing.body.max_output_tokens, 65536);
    assert.deepEqual(routing.body.generation_defaults, {
      generationConfig: { temperature: 0.7, topP: 0.95 },
    });
    assert.equal(routing.body.supports_vision, true);
    assert.equal(routing.body.sensitive_data_allowed, true);

    // Ключ уходит только в создание и не остаётся в форме.
    assert.equal(created.body.api_key, "test-key");
    const leftover = await panel.page.$eval('#provider-form [name="api_key"]', (n) => n.value);
    assert.equal(leftover, "");
  });
});

/**
 * Цена кэшированного входа.
 *
 * Провайдер отдаёт повторный запрос из своего кэша промпта и берёт за
 * него в разы меньше. Пока ставки не было, холодный и тёплый ход в
 * журнале стоили одинаково, и объяснить списание было нечем.
 *
 * Пустое поле и ноль — разные вещи: пусто значит «ставка не задана,
 * считать по обычной цене», ноль — «чтение кэша бесплатно». Подстановка
 * нуля вместо пустого занизила бы счёт.
 */
test("ставка кэша уходит на сервер пустой, а не нулём", async () => {
  const panel = await openPanel({ routes: ROUTES });
  try {
    await panel.page.evaluate(() => openPage("ai"));
    await panel.page.waitForFunction(
      () => document.querySelector("#page-ai").classList.contains("active"));
    await panel.page.evaluate(() => openProviderEditor(null));
    await panel.page.waitForFunction(
      () => !document.querySelector("#provider-editor").hidden);
    // Ставка живёт в «Дополнительно»: свёрнутый блок нельзя заполнить.
    await panel.page.evaluate(() => {
      document.querySelector("#provider-form .advanced-block").open = true;
    });

    const empty = await panel.page.$eval(
      '#provider-form [name="price_cached_in"]', (node) => node.value);
    assert.equal(empty, "", "по умолчанию ставка не задана");

    await panel.page.fill('#provider-form [name="price_cached_in"]', "0.03");
    const filled = await panel.page.$eval(
      '#provider-form [name="price_cached_in"]', (node) => node.value);
    assert.equal(filled, "0.03", "поле ставки не принимает значение");
  } finally {
    await panel.close();
  }
});
