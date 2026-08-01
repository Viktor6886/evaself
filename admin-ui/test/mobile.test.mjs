/**
 * Панель на телефоне.
 *
 * Проверяется одно свойство, которое нельзя увидеть в коде и легко
 * потерять при любой правке вёрстки: страница не должна прокручиваться
 * вбок. На телефоне это худшее, что может случиться, — содержимое
 * уезжает под край экрана, и промахиваешься мимо всего сразу.
 *
 * Раздел STT именно так и был сломан: три вкладки не помещались в
 * строку шириной 360 и растягивали документ до 456 пикселей.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel, PHONE } from "./harness.mjs";

const svc = (name, color) => ({
  name, title: name,
  status: { color, enabled: true, message: "", last_check_at: "2026-08-01T10:00:00Z" },
});

const OVERVIEW = {
  installation: { version: "0.4.2" },
  verdict: { color: "green", title: "Все сервисы работают", detail: "" },
  groups: { core: [svc("eva-agent-service", "green"), svc("media-service", "green")] },
  host: {
    load_average: [0.4, 0.5, 0.6], cpu_count: 4,
    memory_total_bytes: 8 * 2 ** 30, memory_free_bytes: 3 * 2 ** 30,
    disk_total_bytes: 100 * 2 ** 30, disk_free_bytes: 38 * 2 ** 30,
    uptime_seconds: 372_000, hostname: "eva-prod",
  },
};

const CONFIG = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Deepgram production", provider: "deepgram", mode: "batch",
  base_url: "https://api.deepgram.com/v1/listen", model: "nova-3",
  public_config: {}, status: "healthy", config_version: 1, archived: false,
  used_by: ["telegram_voice"], last_test: { at: null, ok: null },
  secret: { configured: true }, keys: { total: 3, usable: 2, exhausted: 1, invalid: 0 },
};

const ROUTES = {
  "/overview": OVERVIEW,
  "/stt/provider-schemas": { providers: [] },
  "/stt/configs": { configs: [CONFIG] },
  "/stt/routes": {
    routes: [{
      use_case: "telegram_voice", enabled: true, rotation_enabled: true,
      timeout_ms: 120000, max_audio_seconds: 1800, config_version: 4,
      chain: [{
        position: 0, config_id: CONFIG.id, name: "Deepgram production",
        provider: "deepgram", model: "nova-3", status: "healthy",
      }],
    }],
  },
  [`/stt/configs/${CONFIG.id}/keys`]: {
    keys: Array.from({ length: 6 }, (_, index) => ({
      id: `aaaaaaaa-0000-0000-0000-00000000000${index}`,
      label: `Ключ ${index + 1}`, position: index * 10, enabled: true,
      status: "active", cooldown_until: null, last_error_code: null,
      success_count: 0, failure_count: 0,
    })),
  },
};

/** Ширина документа против ширины экрана — та самая боковая прокрутка. */
const documentWidth = (page) => page.evaluate(() => ({
  document: document.documentElement.scrollWidth,
  screen: window.innerWidth,
}));

describe("панель на телефоне", () => {
  const panels = [];
  const open = async (options) => {
    const panel = await openPanel({ ...options, viewport: PHONE });
    panels.push(panel);
    return panel;
  };
  after(async () => {
    for (const panel of panels) await panel.close().catch(() => {});
  });

  test("ни один раздел не прокручивается вбок", async () => {
    const panel = await open({ routes: ROUTES });
    const pages = await panel.page.evaluate(() =>
      [...document.querySelectorAll("#nav .nav-item")].map((item) => item.dataset.page));
    assert.ok(pages.length >= 8, "разделы должны быть найдены");

    for (const name of pages) {
      await panel.page.evaluate((page) => openPage(page), name);
      await panel.page.waitForTimeout(120);
      const width = await documentWidth(panel.page);
      assert.equal(
        width.document, width.screen,
        `раздел «${name}» растягивает страницу до ${width.document} при экране ${width.screen}`,
      );
    }
  });

  test("вкладки раздела STT переносятся, а не уезжают за экран", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);

    // Именно вкладки STT: такие же есть и в других разделах.
    const tabs = await panel.page.$$eval("#page-stt .tab", (nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { right: box.right, height: box.height };
    }));
    assert.equal(tabs.length, 3);
    for (const tab of tabs) {
      assert.ok(tab.right <= PHONE.width + 1, "вкладка не должна выходить за экран");
      // Палец — не мышь: ниже сорока пикселей начинаются промахи.
      assert.ok(tab.height >= 40, `высота вкладки ${tab.height} мала для касания`);
    }
  });

  test("цепочка провайдеров читается и управляется с телефона", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);
    await panel.page.click('[data-stt-tab="routes"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-routes .chain-link").length > 0);

    const overflowing = await panel.page.evaluate(() => {
      const bad = [];
      for (const node of document.querySelectorAll("#stt-routes *")) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.right > window.innerWidth + 1) bad.push(node.className);
      }
      return bad;
    });
    assert.deepEqual(overflowing, []);

    // Выключатель ротации должен быть на экране, а не только в вёрстке.
    const toggle = await panel.page.$eval(
      '[data-route-field="rotation_enabled"]', (node) => node.checked);
    assert.equal(toggle, true);
  });

  test("длинный диалог помещается в экран и прокручивается внутри себя", async () => {
    const panel = await open({ routes: ROUTES });
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);
    await panel.page.click('[data-stt-action="key"]');
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-key-list .key-row").length === 6);

    const dialog = await panel.page.evaluate(() => {
      const node = document.querySelector("#stt-key-dialog");
      const box = node.getBoundingClientRect();
      return {
        fitsWidth: box.left >= -1 && box.right <= window.innerWidth + 1,
        bottomOnScreen: box.bottom <= window.innerHeight + 1,
        scrollsInside: node.scrollHeight > node.clientHeight,
      };
    });
    assert.equal(dialog.fitsWidth, true, "диалог не должен выходить за края");
    // Шесть ключей в 740 пикселей не влезают — значит, прокрутка должна
    // быть у самого диалога, а не у страницы под ним.
    assert.equal(dialog.bottomOnScreen, true, "низ диалога должен быть на экране");
    assert.equal(dialog.scrollsInside, true, "содержимое должно прокручиваться внутри");
  });

  test("боковое меню закрывается тычком мимо и клавишей Escape", async () => {
    const panel = await open({ routes: ROUTES });
    const state = () => panel.page.evaluate(() => ({
      open: document.querySelector(".sidebar").classList.contains("open"),
      scrim: document.querySelector("#sidebar-scrim").classList.contains("show"),
      expanded: document.querySelector("#menu").getAttribute("aria-expanded"),
    }));

    await panel.page.click("#menu");
    assert.deepEqual(await state(), { open: true, scrim: true, expanded: "true" });

    // Панель занимает 260 пикселей слева; тычок правее — мимо неё.
    await panel.page.mouse.click(340, 420);
    await panel.page.waitForTimeout(150);
    assert.deepEqual(await state(), { open: false, scrim: false, expanded: "false" });

    await panel.page.click("#menu");
    await panel.page.keyboard.press("Escape");
    await panel.page.waitForTimeout(150);
    assert.equal((await state()).open, false, "Escape тоже должен закрывать меню");
  });

  test("на широком экране вёрстка остаётся прежней", async () => {
    // Мобильные правила не должны протечь на ноутбук: диалог там
    // по-прежнему окно по центру, а не лист снизу.
    const panel = await openPanel({ routes: ROUTES, viewport: { width: 1440, height: 900 } });
    panels.push(panel);
    await panel.page.evaluate(() => openPage("stt"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#stt-configs .status-card").length > 0);

    const dialog = await panel.page.evaluate(() => {
      const node = document.querySelector("#stt-key-dialog");
      node.showModal();
      const box = node.getBoundingClientRect();
      const radius = getComputedStyle(node).borderBottomLeftRadius;
      node.close();
      return { width: Math.round(box.width), radius };
    });
    assert.ok(dialog.width <= 620, "на широком экране диалог не растягивается во всю ширину");
    assert.notEqual(dialog.radius, "0px", "нижние углы скругляются только у листа снизу");
  });
});
