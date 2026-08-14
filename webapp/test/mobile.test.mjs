/**
 * Mini App на телефоне: device-матрица шага 26.
 *
 * Проверяется то, чего нельзя увидеть в коде и что теряется при любой
 * правке вёрстки: страница не едет вбок, до кнопки можно дотянуться
 * пальцем, клавиатура не накрывает поле, аппаратная «Назад» закрывает
 * то, что лежит сверху, а опасное действие не срабатывает от одного
 * касания.
 *
 * Восемь разрешений из задания прогоняются на «Сегодня» — самом плотном
 * экране; остальные экраны проверяются на 320 и 360, где ломается всё.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { DEVICES, PHONES, documentWidth, openApp, smallTapTargets } from "./harness.mjs";

const SCREENS = ["today", "development", "organizer", "hub", "profile"];

describe("Mini App на device-матрице", () => {
  const opened = [];
  const open = async (options) => {
    const app = await openApp(options);
    opened.push(app);
    return app;
  };
  after(async () => {
    for (const app of opened) await app.close().catch(() => {});
  });

  for (const device of DEVICES) {
    test(`${device.name}: страница не прокручивается вбок`, async () => {
      const app = await open({ viewport: { width: device.width, height: device.height } });
      for (const screen of SCREENS) {
        await app.openScreen(screen);
        const width = await documentWidth(app.page);
        assert.equal(
          width.document,
          width.screen,
          `экран «${screen}» растягивает страницу до ${width.document} при ${width.screen}`,
        );
      }
      assert.deepEqual(app.errors, [], "страница не должна падать с ошибкой");
    });
  }

  for (const device of PHONES.slice(0, 2)) {
    test(`${device.name}: до каждой кнопки можно дотянуться пальцем`, async () => {
      const app = await open({ viewport: { width: device.width, height: device.height } });
      for (const screen of SCREENS) {
        await app.openScreen(screen);
        const small = await smallTapTargets(app.page);
        assert.deepEqual(
          small,
          [],
          `на экране «${screen}» есть области нажатия меньше 44×44: ${JSON.stringify(small)}`,
        );
      }
    });
  }

  test("широкие блоки прокручиваются внутри себя, а не растягивают страницу", async () => {
    const app = await open({ viewport: { width: 320, height: 568 } });
    await app.openScreen("organizer");
    const overflowing = await app.page.evaluate(() => {
      const bad = [];
      for (const node of document.querySelectorAll(".screen:not([hidden]) *")) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.right > window.innerWidth + 1) bad.push(String(node.className));
      }
      return bad;
    });
    assert.deepEqual(overflowing, []);
  });

  test("клавиатура не накрывает поле в открытом листе", async () => {
    const app = await open({ viewport: { width: 360, height: 640 } });
    await app.openScreen("organizer");
    await app.page.click("#organizer-add");
    await app.page.waitForSelector("#task-form");

    // Клавиатура эмулируется так же, как её видит приложение: через
    // высоту, которую app.js пишет в --keyboard по visualViewport.
    await app.page.evaluate(() => {
      document.documentElement.style.setProperty("--keyboard", "260px");
    });
    const field = app.page.locator('#task-form [name="priority"]');
    await field.focus();
    await app.page.waitForTimeout(400);
    const visible = await field.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const keyboard = 260;
      return { bottom: box.bottom, limit: window.innerHeight - keyboard };
    });
    assert.ok(
      visible.bottom <= visible.limit + 1,
      `поле уходит под клавиатуру: низ ${visible.bottom} при границе ${visible.limit}`,
    );
  });

  test("«Назад» закрывает лист, потом раздел, и только потом приложение", async () => {
    const app = await open({ viewport: { width: 390, height: 844 } });
    await app.openScreen("organizer");
    await app.page.click("#organizer-add");
    await app.page.waitForSelector("#task-form");

    await app.pressBack();
    assert.equal(
      await app.page.evaluate(() => document.getElementById("sheet").open),
      false,
      "первое нажатие должно закрыть лист",
    );
    assert.equal(
      await app.page.evaluate(() => window.EvaApp.state.screen),
      "organizer",
      "лист закрылся — раздел остаётся прежним",
    );

    await app.pressBack();
    assert.equal(await app.page.evaluate(() => window.EvaApp.state.screen), "today");

    await app.pressBack();
    assert.equal(
      await app.page.evaluate(() => window.__closed === true),
      true,
      "с «Сегодня» назад идти некуда — приложение закрывается",
    );
  });

  test("удаление не срабатывает от одного касания", async () => {
    const app = await open({
      viewport: { width: 360, height: 640 },
      routes: { "/public/v2/tasks": { tasks: [{ id: "9", title: "Проверить", status: "open", priority: 3 }] } },
    });
    await app.openScreen("organizer");
    await app.page.click('[data-task-edit="9"]');
    await app.page.waitForSelector("#delete-task");
    await app.page.click("#delete-task");
    await app.page.waitForSelector("#confirm-dialog[open]");

    assert.equal(
      app.requests.filter((item) => item.method === "DELETE").length,
      0,
      "запрос ушёл до подтверждения",
    );
    // Опасная кнопка не должна быть под пальцем по умолчанию.
    const focused = await app.page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, "confirm-cancel", "фокус должен стоять на отмене");

    await app.page.click("#confirm-accept");
    await app.page.waitForTimeout(200);
    assert.equal(
      app.requests.filter((item) => item.method === "DELETE" && item.path.includes("/tasks/9")).length,
      1,
      "после подтверждения запрос должен уйти ровно один раз",
    );
  });

  test("отказ API даёт состояние ошибки с повтором, а не пустой список", async () => {
    const app = await open({
      viewport: { width: 360, height: 640 },
      routes: { "/public/goals": { __status: 500 }, "/public/progress": { __status: 500 } },
    });
    await app.openScreen("development");
    const text = await app.page.textContent('[data-screen="development"] .scroll-content');
    assert.match(text, /не загрузились/);
    assert.ok(
      await app.page.$('[data-screen="development"] [data-retry]'),
      "экран отказа обязан давать кнопку повтора",
    );
  });

  test("выключенный дневник не оставляет карточки, которая никуда не ведёт", async () => {
    const app = await open({ viewport: { width: 360, height: 640 } });
    await app.openScreen("hub");
    const codes = await app.page.$$eval("[data-hub]", (nodes) => nodes.map((node) => node.dataset.hub));
    assert.ok(!codes.includes("journal"), "при 404 дневника карточки быть не должно");
  });

  test("включённый дневник открывается и показывает честный обзор", async () => {
    const app = await open({ viewport: { width: 360, height: 640 }, journal: true });
    await app.openScreen("hub");
    await app.page.click('[data-hub="journal"]');
    await app.page.waitForSelector("#journal-add");
    const text = await app.page.textContent("#journal-host");
    assert.match(text, /Данных пока мало/);
    const width = await documentWidth(app.page);
    assert.equal(width.document, width.screen, "дневник не должен растягивать страницу");
    const small = await smallTapTargets(app.page);
    assert.deepEqual(small, [], `в дневнике мелкие области нажатия: ${JSON.stringify(small)}`);
  });
});
