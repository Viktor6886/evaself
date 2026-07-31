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

const ROUTES = {
  "/llm/state": { providers: [], routes: [], breakers: [] },
  "/llm/usage": { rows: [] },
  "/providers": { providers: [] },
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

    const boxes = await panel.page.$$eval(
      '.router-flags input[type="checkbox"]',
      (nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.name, w: Math.round(rect.width), h: Math.round(rect.height) };
      }),
    );

    assert.ok(boxes.length >= 6, `ожидались флажки редактора, найдено ${boxes.length}`);

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
