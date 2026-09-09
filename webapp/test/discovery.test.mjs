import assert from "node:assert/strict";
import { test } from "node:test";
import { openApp } from "./harness.mjs";

test("all discovery topics open a contextual conversation without writing answers", async () => {
  const app = await openApp();
  try {
    await app.openScreen("discovery");
    for (const id of ["personality", "emotions", "relationships", "direction"]) {
      await app.page.click(`[data-discovery-topic="${id}"]`);
      assert.match(await app.page.textContent("#sheet-content"), /саморефлексия/);
      await app.page.click("#discovery-discuss");
      assert.match(await app.page.textContent("#sheet-title"), /Обсудить с Евой/);
      assert.match(await app.page.textContent("#sheet-content"), /Не проводи психологическое тестирование/);
      await app.pressBack();
    }
    assert.equal(app.requests.filter(({ method }) => !["GET", "POST"].includes(method)).length, 0);
    assert.equal(app.requests.filter(({ method, path }) => method === "POST" && path !== "/public/session").length, 0);
    await app.pressBack();
    assert.equal(await app.page.getAttribute('[data-target="today"]', "aria-current"), "page");
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test("reward profile entry opens discovery; goals outages do not block it", async () => {
  const app = await openApp({ routes: { "/public/goals": { __status: 503 } } });
  try {
    await app.page.click("#reward-action");
    await app.page.click("#reward-profile");
    assert.equal(await app.page.getAttribute('[data-target="discovery"]', "aria-current"), "page");
    assert.equal(await app.page.locator(".discovery-topic").count(), 4);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

for (const colorScheme of ["light", "dark"]) {
  test(`${colorScheme}: content viewport ends above navigation on a narrow phone`, async () => {
    const app = await openApp({ viewport: { width: 320, height: 568 } });
    try {
      await app.page.emulateMedia({ colorScheme });
      for (const screen of ["today", "discovery", "journal", "development", "profile"]) {
        await app.openScreen(screen);
        const geometry = await app.page.evaluate(() => {
          const visible = document.querySelector(".screen.is-active");
          const nav = document.querySelector(".bottom-nav");
          return { content: visible.getBoundingClientRect().bottom, nav: nav.getBoundingClientRect().top,
            clippedLabels: [...nav.querySelectorAll("b")].some((label) => label.scrollWidth > label.clientWidth) };
        });
        assert.ok(geometry.content <= geometry.nav, JSON.stringify(geometry));
        assert.equal(geometry.clippedLabels, false);
      }
      await app.openScreen("today");
      const contrast = await app.page.locator("#profile-investment").evaluate((card) => {
        const style = getComputedStyle(card);
        const luminance = (rgb) => {
          const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
            const s = value / 255;
            return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
          });
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        const bg = luminance(style.backgroundColor);
        const fg = luminance(getComputedStyle(card.querySelector(".profile-value-note")).color);
        return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
      });
      assert.ok(contrast >= 4.5, `profile secondary copy contrast: ${contrast}`);
    } finally { await app.close(); }
  });
}

test("long main focus remains complete and wraps inside its card", async () => {
  const title = "Проверить сценарий отмены подписки: после окончания оплаченного периода доступ отключается, а память сохраняется по правилам продукта";
  const app = await openApp({ viewport: { width: 320, height: 568 }, routes: {
    "/public/v2/dashboard": { main_focus: { id: "1", title } },
  } });
  try {
    assert.equal(await app.page.textContent("#main-focus-title"), title);
    const fits = await app.page.locator("#main-focus-title").evaluate((node) => node.scrollWidth <= node.clientWidth);
    assert.ok(fits);
  } finally { await app.close(); }
});
