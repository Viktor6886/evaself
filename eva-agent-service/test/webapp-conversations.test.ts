import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appUrl = new URL("../../webapp/public/app/app.js", import.meta.url);
const cssUrl = new URL("../../webapp/public/app/app.css", import.meta.url);
const app = existsSync(appUrl) ? await readFile(appUrl, "utf8") : "";
const css = existsSync(cssUrl) ? await readFile(cssUrl, "utf8") : "";
const routes = await readFile(new URL("../src/public/routes.ts", import.meta.url), "utf8");

test("conversation repository methods establish verified Telegram tenant scope", () => {
  for (const operation of ["list", "create", "activate", "archive"]) {
    assert.match(routes, new RegExp(`this\\.scoped\\(telegramId, ["']conversations\\.${operation}["']`));
  }
});

test("mobile profile exposes complete conversation management", { skip: app ? false : "webapp source is outside the service Docker build context" }, () => {
  assert.match(app, /settingsRow\("conversations"/);
  assert.match(app, /\/public\/conversations/);
  assert.match(app, /\/activate/);
  assert.match(app, /method:\s*"DELETE"/);
  assert.match(app, /Новый диалог/);
  assert.doesNotMatch(app, /prompt\("Название нового диалога"/);
  assert.doesNotMatch(app, /confirm\("Архивировать диалог/);
  assert.match(app, /Сначала выберите другой диалог/);
  assert.match(app, /conversation-badge[^>]*>Активный/);
  assert.doesNotMatch(app, /\$\{item\.active \? " · активный"/);
  assert.match(css, /\.conversation-list\s*\{[^}]*overflow-y:\s*auto/s);
  // Область нажатия задаётся одной переменной на весь интерфейс: шаг 26
  // поднял её до 44 пикселей, и отдельное значение здесь снова
  // разъехалось бы с остальными кнопками.
  assert.match(css, /--tap:\s*44px/);
  assert.match(css, /\.conversation-action[^{}]*\{[^}]*min-height:\s*var\(--tap\)/s);
  assert.match(css, /@media\s*\(max-width:\s*350px\)/);
});
