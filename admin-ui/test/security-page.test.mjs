/**
 * Страница «Безопасность»: фильтр системных ключей и пароль архива.
 *
 * Пароль архива опасен несимметрично. Задать его — обратимо, а снять,
 * потеряв, — нет: архивы, зашифрованные им, больше ничем не открываются.
 * Поэтому пустая отправка формы, означающая снятие пароля, не должна
 * доходить до сервера в обход подтверждения. Проверить это можно только
 * в браузере: на сервере пустой пароль — законный запрос.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const ADMIN_FACING = [
  "sec_eva_telegram_bot_token",
  "sec_todoist_api_token",
  "sec_media_asr_api_key",
  "sec_media_tts_api_key",
  "sec_lava_webhook_password",
  "sec_eva_llm_api_key",
  "sec_eva_embedding_api_key",
];

const INTERNAL = [
  "sec_eva_db_password",
  "sec_postgres_super_password",
  "sec_valkey_password",
  "sec_searxng_secret",
  "sec_crawl4ai_api_token",
  "sec_letta_db_password",
];

const SECRETS = [...ADMIN_FACING, ...INTERNAL].map((ref) => ({
  secret_ref: ref,
  configured: true,
  used_by: ["service"],
  created_at: "2026-01-01T00:00:00Z",
  last_rotated_at: null,
}));

const ROUTES = {
  "/secrets": { secrets: SECRETS },
  "PUT /backups/password": { configured: true },
};

async function openSecurity() {
  const panel = await openPanel({ routes: ROUTES });
  await panel.page.evaluate(() => openPage("security"));
  await panel.page.waitForFunction(
    () => document.querySelectorAll("#secrets-list .secret-ref").length > 0,
  );
  return panel;
}

describe("список ключей", () => {
  let panel;
  after(async () => await panel?.close());

  test("по умолчанию видны только ключи администратора", async () => {
    panel = await openSecurity();
    const shown = await panel.page.$$eval(
      "#secrets-list .secret-ref", (els) => els.map((e) => e.textContent.trim()));

    assert.deepEqual(shown.sort(), [...ADMIN_FACING].sort());
    for (const ref of INTERNAL) {
      assert.ok(!shown.includes(ref), `служебный ключ ${ref} не должен быть в списке`);
    }
  });

  test("подсказка называет число скрытых", async () => {
    const hint = await panel.page.textContent(".secrets-hint");
    assert.match(hint, new RegExp(String(INTERNAL.length)));
  });

  test("переключатель показывает все и возвращает обратно", async () => {
    await panel.page.click("#toggle-all-secrets");
    let shown = await panel.page.$$eval("#secrets-list .secret-ref", (els) => els.length);
    assert.equal(shown, SECRETS.length);

    await panel.page.click("#toggle-all-secrets");
    shown = await panel.page.$$eval("#secrets-list .secret-ref", (els) => els.length);
    assert.equal(shown, ADMIN_FACING.length);
  });
});

describe("пароль архива backup", () => {
  let panel;
  after(async () => await panel?.close());

  test("пустая отправка не доходит до сервера", async () => {
    panel = await openSecurity();
    await panel.page.evaluate(() => {
      document.querySelector("#backup-password-form")
        .dispatchEvent(new Event("submit", { cancelable: true }));
    });
    await panel.page.waitForTimeout(150);

    assert.equal(
      panel.countTo("/backups/password"), 0,
      "пустая форма означала бы снятие пароля в обход подтверждения",
    );
  });

  test("несовпадающие пароли не доходят до сервера", async () => {
    await panel.page.evaluate(() => {
      const form = document.querySelector("#backup-password-form");
      form.elements.password.value = "abcdefghijklmnop";
      form.elements.confirm.value = "abcdefghijklmnoq";
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    await panel.page.waitForTimeout(150);

    assert.equal(panel.countTo("/backups/password"), 0);
  });

  test("смена пароля требует sudo secrets:write", async () => {
    await panel.sudoWatch();
    await panel.page.evaluate(() => {
      const form = document.querySelector("#backup-password-form");
      form.elements.password.value = "correct-horse-battery-staple";
      form.elements.confirm.value = "correct-horse-battery-staple";
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    await panel.page.waitForTimeout(150);

    assert.equal(await panel.sudoScope(), "secrets:write");
    assert.equal(
      panel.countTo("/backups/password"), 0,
      "пароль не должен уходить до подтверждения",
    );
  });

  test("после подтверждения пароль уходит и поле очищается", async () => {
    await panel.confirmSudo();
    await panel.page.waitForTimeout(150);

    const sent = panel.requests.filter((r) => r.path.includes("/backups/password"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "PUT");
    assert.equal(sent[0].body.password, "correct-horse-battery-staple");

    const left = await panel.page.evaluate(
      () => document.querySelector("#backup-password-form").elements.password.value);
    assert.equal(left, "", "пароль не должен оставаться в поле формы");
  });
});
