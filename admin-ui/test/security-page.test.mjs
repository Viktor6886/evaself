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
  "sec_media_asr_api_key",
  "sec_media_tts_api_key",
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

  test("пароль архива подтверждается последствиями, а не паролем входа", async () => {
    await panel.confirmWatch();
    await panel.page.evaluate(() => {
      const form = document.querySelector("#backup-password-form");
      form.elements.password.value = "correct-horse-battery-staple";
      form.elements.confirm.value = "correct-horse-battery-staple";
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    await panel.page.waitForFunction(() => state.pendingConfirm !== null);

    // Окно называет последствие: без этого пароля архив не восстановить.
    const dialog = await panel.page.textContent("#confirm-dialog");
    assert.match(dialog, /восстановление станет невозможным/);
    assert.equal(
      panel.countTo("/backups/password"), 0,
      "пароль не должен уходить до подтверждения",
    );
    assert.equal(panel.countTo("/sudo"), 0, "панель всё ещё просит sudo-грант");
  });

  test("после подтверждения пароль уходит и поле очищается", async () => {
    await panel.confirmAccept();
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

/**
 * Боты Евы в разделе безопасности.
 *
 * Токен Telegram — секрет, и правило то же, что у остальных: наружу он
 * не выходит. Проверяется и это, и то, что переезд на другого бота не
 * случается от одного касания: он меняет, кому пишут люди.
 */
describe("боты Telegram", () => {
  const TOKENS = {
    limit: 5,
    tokens: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "рабочий", bot_username: "eva_bot",
        is_active: true, created_at: "2026-08-01T10:00:00Z", activated_at: "2026-08-01T10:00:00Z" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "запасной", bot_username: "eva_spare_bot",
        is_active: false, created_at: "2026-08-02T10:00:00Z", activated_at: null },
    ],
  };
  let panel;
  after(async () => await panel?.close());

  test("список показывает бота по метке и @username, но не токен", async () => {
    panel = await openPanel({ routes: { ...ROUTES, "/telegram/tokens": TOKENS } });
    await panel.page.evaluate(() => openPage("security"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#telegram-tokens-list [data-telegram-token]").length > 0);

    const card = await panel.page.textContent("#telegram-tokens-card");
    assert.match(card, /рабочий/);
    assert.match(card, /@eva_bot/);
    assert.match(card, /активен/);
    assert.match(card, /запасной/);

    // У активного нет ни «сделать активным», ни «удалить»: первое
    // бессмысленно, второе оставило бы Еву без токена.
    const actions = await panel.page.$$eval("[data-telegram-action]",
      (nodes) => nodes.map((node) => `${node.dataset.telegramAction}:${node.dataset.telegramId}`));
    assert.deepEqual(actions.sort(), [
      "activate:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "remove:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });

  /**
   * Переезд на другого бота меняет, кому пишут люди: у прежнего бота
   * снимается вебхук, а его собеседники сами к новому не перейдут.
   * Поэтому окно с последствиями осталось — но пароль в нём больше не
   * спрашивается: он введён при входе в панель.
   */
  test("переезд на другого бота предупреждает о последствиях", async () => {
    const before = panel.requests.length;
    await panel.page.click('[data-telegram-action="activate"]');
    await panel.page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open === true);

    const dialog = await panel.page.textContent("#confirm-dialog");
    // Человеку сказано главное: люди прежнего бота сами не перейдут.
    assert.match(dialog, /eva_spare_bot/);
    assert.match(dialog, /сами не перейдут/);
    assert.match(dialog, /перезапуск/i);
    // До подтверждения наружу не ушло ни одного запроса.
    assert.equal(
      panel.requests.slice(before).filter((item) => item.method === "POST").length, 0,
      "переезд не должен случаться от одного касания",
    );
  });

  test("сохранение бота уходит сразу и не требует второго пароля", async () => {
    await panel.page.evaluate(() => {
      document.querySelector("#confirm-dialog").close();
      state.pendingConfirm = null;
      const form = document.querySelector("#telegram-token-form");
      form.elements.label.value = "запасной";
      form.elements.token.value = "123456:ABC";
      form.requestSubmit();
    });

    const saved = await panel.waitForRequest(
      (item) => item.method === "POST" && item.path === "/telegram/tokens",
    );
    assert.ok(saved, "токен не ушёл на сервер");
    assert.equal(saved.body.token, "123456:ABC");
    assert.equal(saved.body.label, "запасной");
    assert.equal(
      await panel.page.evaluate(() => state.pendingConfirm), null,
      "добавление бота в список открыло окно",
    );
    assert.equal(panel.countTo("/sudo"), 0, "панель всё ещё просит sudo-грант");
  });
});
