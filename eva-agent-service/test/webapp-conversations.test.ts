import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appUrl = new URL("../../webapp/public/app/app.js", import.meta.url);
const app = existsSync(appUrl) ? await readFile(appUrl, "utf8") : "";
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
  assert.match(app, /сначала выберите другой диалог/);
});
