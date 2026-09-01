/**
 * Раздел «Распознавание медиа» в браузере.
 *
 * Стережётся ровно то, ради чего раздел появился: он показывает и правит
 * маршрут `vision` того же LLM Router, а не заводит собственный реестр
 * провайдеров, и его проверка уходит не к провайдеру напрямую, а через
 * production Router.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const SEEING = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "gpt-vision", model: "gpt-5-vision", protocol: "openai-compatible",
  enabled: true, priority: 10, breaker_state: "closed", p95_latency_ms: 812,
  supports_tools: true, supports_json: true, supports_vision: true, supports_streaming: true,
  context_window: 128000, sensitive_data_allowed: true, pinned_out: false,
  // Операционный статус считает сервер: раздел медиа берёт его
  // готовым, как и карточка провайдера.
  status: { code: "ok", label: "работает", color: "green", detail: { check: "ok", router: "closed" } },
  routes: [{ code: "vision", title: "vision", position: 0 }],
};
const BLIND = {
  ...SEEING,
  id: "22222222-2222-4222-8222-222222222222",
  name: "text-only", model: "text-model", supports_vision: false,
};

const STATE = {
  providers: [SEEING, BLIND],
  routes: [
    {
      code: "chat", title: "chat", requires_tools: true, requires_json: false,
      requires_streaming: true, min_context_window: 8000, rotation_enabled: true,
      chain: [{ provider_id: BLIND.id, name: BLIND.name, model: BLIND.model, protocol: BLIND.protocol, enabled: true }],
    },
    {
      code: "vision", title: "vision", requires_tools: false, requires_json: false,
      requires_streaming: false, min_context_window: 8000, rotation_enabled: true,
      chain: [{ provider_id: SEEING.id, name: SEEING.name, model: SEEING.model, protocol: SEEING.protocol, enabled: true }],
    },
  ],
  recent_failures: [],
  routing_settings: { mode: "adaptive", single_provider_id: null, single_failover_enabled: false },
};

const OK_CHECK = {
  ok: true, recognized: true, provider: "gpt-vision", model: "gpt-5-vision",
  route: "vision", switches: 0, latency_ms: 940, answer: "зелёный", error: null,
};

function routes(check = OK_CHECK) {
  return {
    "/llm/state": STATE,
    "/providers?kind=llm": { providers: [], kind: "llm", runtime_connected: true },
    "/providers": { providers: [], kind: "llm", runtime_connected: true },
    "POST /llm/vision/check": check,
  };
}

describe("раздел распознавания медиа", () => {
  let panel;
  after(async () => { await panel?.close(); });

  test("раздел показывает цепочку vision и только зрячих провайдеров", async () => {
    panel = await openPanel({ routes: routes() });
    // Стартовая загрузка панели — поток событий и обзор вместе с
    // состоянием роутера — заканчивается уже после того, как появился
    // `#app`. Без этого барьера её запросы попадали в измерение
    // открытия раздела: тест падал примерно в одном прогоне из трёх и
    // жаловался на «лишние» /events, /overview и второй /llm/state.
    for (const path of ["/events", "/overview", "/llm/state"]) {
      assert.ok(
        await panel.waitForRequest((item) => item.path === path),
        `стартовая загрузка панели не запросила ${path}`,
      );
    }
    const before = panel.requests.length;
    await panel.page.evaluate(() => openPage("media"));
    await panel.page.waitForSelector("#media-chain .route-block");

    // Цепочка — та же, что у роутера, и только она: маршрут chat в
    // разделе не показывается, иначе его правили бы отсюда по ошибке.
    const blocks = await panel.page.$$eval("#media-chain .route-block",
      (nodes) => nodes.map((node) => node.dataset.route));
    assert.deepEqual(blocks, ["vision"]);
    const chain = await panel.page.textContent("#media-chain");
    assert.match(chain, /gpt-vision/);

    const capable = await panel.page.textContent("#media-providers");
    assert.match(capable, /gpt-vision/);
    assert.doesNotMatch(capable, /text-only/, "модель без зрения в списке не нужна");
    assert.match(capable, /в цепочке vision/);

    // Своего реестра у раздела нет: открытие страницы читает то же
    // состояние роутера, что и раздел моделей, и больше ничего. Запрос
    // ровно один: /llm/state отдаёт провайдера целиком, склеивать его с
    // /providers в браузере больше не нужно.
    const opened = panel.requests.slice(before).map((item) => item.path).sort();
    assert.deepEqual(opened, ["/llm/state"]);
    assert.equal(panel.countTo("/vision/check"), 0, "проверка сама собой не запускается");
  });

  test("проверка уходит через Router и показывает, кто ответил", async () => {
    await panel.page.click("#media-check");
    await panel.page.waitForSelector("#media-check-result .health-facts");

    const request = panel.requests.filter((item) => item.path === "/llm/vision/check");
    assert.equal(request.length, 1);
    assert.equal(request[0].method, "POST");

    const report = await panel.page.textContent("#media-check-result");
    assert.match(report, /gpt-vision/);
    assert.match(report, /vision/);
    assert.match(report, /940 мс/);
    assert.match(report, /доехало до модели/);
  });

  test("ответ без картинки виден как отказ, а не как успех", async () => {
    await panel.close();
    panel = await openPanel({
      routes: routes({
        ...OK_CHECK, recognized: false, route: "chat", answer: "Я не вижу изображения.",
        error: "запрос ушёл маршрутом chat, а не vision",
      }),
    });
    await panel.page.evaluate(() => openPage("media"));
    await panel.page.waitForSelector("#media-chain .route-block");
    await panel.page.click("#media-check");
    await panel.page.waitForSelector("#media-check-result .health-facts");

    const host = await panel.page.$("#media-check-result");
    assert.match(await host.getAttribute("class"), /is-fail/);
    const report = await host.textContent();
    assert.match(report, /цвет не назвала/);
    assert.match(report, /не вижу изображения/);
    assert.equal(panel.errors.length, 0);
  });
});
