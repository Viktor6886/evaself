import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../../webapp/public/app/app.js", import.meta.url), "utf8");

test("mobile profile exposes complete conversation management", () => {
  assert.match(app, /settingsRow\("conversations"/);
  assert.match(app, /\/public\/conversations/);
  assert.match(app, /\/activate/);
  assert.match(app, /method:\s*"DELETE"/);
  assert.match(app, /Новый диалог/);
  assert.doesNotMatch(app, /prompt\("Название нового диалога"/);
  assert.doesNotMatch(app, /confirm\("Архивировать диалог/);
  assert.match(app, /сначала выберите другой диалог/);
});
