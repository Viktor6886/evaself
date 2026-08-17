/**
 * Раздел «Пользователи»: приватность переписки и защита мутаций.
 *
 * Здесь проверяется в первую очередь то, чего интерфейс делать НЕ должен.
 * Переписка — личный разговор, и правило «её нельзя открыть мимоходом»
 * держится не сервером, а именно интерфейсом: сервер честно отдаст
 * сообщения любому, у кого есть роль и действующий sudo. Регрессия, при
 * которой карточка начнёт подгружать переписку сама, не уронит ни один
 * серверный тест.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { openPanel } from "./harness.mjs";

const USERS = [
  {
    id: 1, telegram_id: "555", username: "anna", first_name: "Анна",
    state: "active", is_blocked: false, language_code: "ru", timezone: "Europe/Moscow",
    plan: "free", subscription_status: "none", current_period_end: null,
    message_count: 42, last_message_at: "2026-07-29T10:00:00Z",
    created_at: "2026-01-01T00:00:00Z", last_seen_at: "2026-07-30T09:00:00Z",
  },
  {
    id: 2, telegram_id: "556", username: "petr", first_name: "Пётр",
    state: "blocked", is_blocked: true, language_code: "ru", timezone: "UTC",
    plan: "free", subscription_status: "none", current_period_end: null,
    message_count: 3, last_message_at: null,
    created_at: "2026-02-01T00:00:00Z", last_seen_at: null,
  },
];

const CARD = {
  user: {
    ...USERS[0], city: null, country_code: null, language_mode: "auto",
    preferred_language: null, timezone_source: null, consent_at: null, notes: null,
  },
  quotas: [{ metric: "messages", period: "day", limit_value: 30, used: 4, remaining: 26 }],
  preferences: {
    response_mode: "text", agent_mode: "companion", heartbeat_enabled: true,
    voice: null, character: null, use_emoji: true,
  },
  notes: [{
    id: "n1", actor_name: "owner", note: "пилотный участник",
    created_at: "2026-07-01T00:00:00Z",
  }],
  activity: { updates_total: "120", updates_failed: "2", last_update_at: null },
  crisis_events: [{
    id: 1, severity: "low", handled: true,
    handled_at: "2026-07-02T00:00:00Z", created_at: "2026-07-01T00:00:00Z",
  }],
};

const CONVERSATION = {
  user: { id: 1, telegram_id: "555", username: "anna", first_name: "Анна" },
  conversations: [],
  messages: [
    { role: "user", content: "привет, Ева", created_at: "2026-07-30T09:00:00Z" },
    { role: "assistant", content: "привет!", created_at: "2026-07-30T09:00:05Z" },
  ],
  messages_error: null,
};

const ROUTES = {
  "/users": { users: USERS, total: USERS.length, limit: 50, offset: 0 },
  "/users/1": CARD,
  "/users/1/conversation": CONVERSATION,
  "POST /users/1/block": { id: 1, state: "blocked", is_blocked: true },
};

async function openUsers(options = {}) {
  const panel = await openPanel({ routes: ROUTES, ...options });
  await panel.page.evaluate(() => openPage("users"));
  await panel.page.waitForFunction(
    () => document.querySelectorAll("#users-body .user-row").length > 0,
  );
  return panel;
}

describe("список", () => {
  let panel;
  after(async () => await panel?.close());

  test("строки отрисованы, заблокированный помечен", async () => {
    panel = await openUsers();
    const rows = await panel.page.$$eval("#users-body .user-row", (els) => els.length);
    const pills = await panel.page.$$eval(".pill-blocked", (els) => els.length);
    assert.equal(rows, 2);
    assert.equal(pills, 1, "заблокированный пользователь должен быть видно помечен");
    assert.deepEqual(panel.errors, []);
  });
});

describe("приватность переписки", () => {
  let panel;
  after(async () => await panel?.close());

  test("открытие карточки не загружает переписку", async () => {
    panel = await openUsers();
    await panel.page.click("#users-body .user-row");
    await panel.page.waitForFunction(() => !document.querySelector("#user-card").hidden);

    assert.equal(
      panel.countTo("conversation"), 0,
      "переписка не должна загружаться без явного действия",
    );
    const block = await panel.page.textContent("#user-conversation");
    assert.equal(block.trim(), "", "блок переписки должен быть пуст до нажатия");
  });

  test("переписка требует sudo и не уходит до подтверждения", async () => {
    await panel.sudoWatch();
    await panel.page.click('[data-action="conversation"]');

    assert.equal(await panel.sudoScope(), "users:messages");
    assert.equal(
      panel.countTo("conversation"), 0,
      "запрос не должен уходить до подтверждения пароля",
    );
  });

  test("после подтверждения приходят сообщения и выдержки", async () => {
    await panel.confirmSudo();
    await panel.page.waitForFunction(
      () => document.querySelector("#user-conversation").textContent.includes("Переписка"),
    );

    assert.equal(panel.countTo("conversation"), 1);
    const rendered = await panel.page.$$eval("#user-conversation .msg", (els) => els.length);
    assert.equal(rendered, 2);
    const text = await panel.page.textContent("#user-conversation");
    assert.match(text, /привет, Ева/);
    assert.match(text, /Выдержки/);
  });
});

describe("мутации", () => {
  let panel;
  after(async () => await panel?.close());

  test("блокировка требует sudo и не уходит до подтверждения", async () => {
    panel = await openUsers();
    await panel.page.click("#users-body .user-row");
    await panel.page.waitForFunction(() => !document.querySelector("#user-card").hidden);

    await panel.sudoWatch();
    await panel.page.click('[data-action="block"]');

    assert.equal(await panel.sudoScope(), "users:write");
    assert.equal(panel.countTo("/block"), 0, "блокировка не должна уходить до подтверждения");
  });
});

describe("отрисовка по ролям", () => {
  let panel;
  after(async () => await panel?.close());

  test("viewer не получает кнопок, меняющих состояние", async () => {
    panel = await openUsers({ role: "viewer" });
    await panel.page.click("#users-body .user-row");
    await panel.page.waitForFunction(() => !document.querySelector("#user-card").hidden);

    const actions = await panel.page.$$eval("[data-action]", (els) =>
      els.map((e) => e.dataset.action));
    assert.deepEqual(actions, [], `viewer не должен видеть действий, найдено: ${actions}`);
  });
});

describe("экранирование", () => {
  let panel;
  after(async () => await panel?.close());

  test("текст сообщения не исполняется как разметка", async () => {
    const evil = "<img src=x onerror=\"window.__pwned=1\">";
    panel = await openPanel({
      routes: {
        ...ROUTES,
        "/users/1/conversation": {
          ...CONVERSATION,
          messages: [{ role: "user", content: evil, created_at: null }],
        },
      },
    });
    await panel.page.evaluate(() => openPage("users"));
    await panel.page.waitForFunction(
      () => document.querySelectorAll("#users-body .user-row").length > 0,
    );
    await panel.page.click("#users-body .user-row");
    await panel.page.waitForFunction(() => !document.querySelector("#user-card").hidden);
    await panel.page.click('[data-action="conversation"]');
    await panel.confirmSudo();
    await panel.page.waitForFunction(
      () => document.querySelector("#user-conversation").textContent.includes("Переписка"),
    );

    const pwned = await panel.page.evaluate(() => window.__pwned ?? null);
    assert.equal(pwned, null, "разметка из сообщения не должна исполняться");
    const images = await panel.page.$$eval("#user-conversation img", (els) => els.length);
    assert.equal(images, 0, "тег из текста не должен становиться элементом");
    const text = await panel.page.textContent("#user-conversation");
    assert.match(text, /<img/, "текст должен остаться видимым как текст");
  });
});
