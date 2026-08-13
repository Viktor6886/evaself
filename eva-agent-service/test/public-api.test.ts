import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import Fastify from "fastify";

import {
  registerPublicRoutes,
  type PublicDataSource,
} from "../dist/public/routes.js";
import {
  verifyTelegramWebAppInitData,
} from "../dist/public/telegram-webapp-auth.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFG";
const NOW = new Date("2026-07-29T08:00:00.000Z");
const USER = {
  id: 424242,
  first_name: "Виктор",
  username: "viktor",
  language_code: "ru",
};

test("valid Telegram initData is accepted", () => {
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  const verified = verifyTelegramWebAppInitData(initData, BOT_TOKEN, { now: NOW });
  assert.equal(verified.user.id, USER.id);
  assert.equal(verified.user.first_name, USER.first_name);
});

test("changed Telegram initData HMAC is rejected", () => {
  const valid = signInitData(USER, Math.floor(NOW.getTime() / 1000));
  const changedParams = new URLSearchParams(valid);
  changedParams.set("user", JSON.stringify({ ...USER, first_name: "tampered" }));
  const changed = changedParams.toString();
  assert.throws(
    () => verifyTelegramWebAppInitData(changed, BOT_TOKEN, { now: NOW }),
    /подпис/i,
  );
});

test("expired Telegram initData is rejected", () => {
  const old = Math.floor(NOW.getTime() / 1000) - 3_601;
  assert.throws(
    () => verifyTelegramWebAppInitData(signInitData(USER, old), BOT_TOKEN, { now: NOW }),
    /истекла/i,
  );
});

test("/public/session and /public/tasks derive identity only from initData", async () => {
  let sessionTelegramId = 0;
  let tasksTelegramId = 0;
  const protectedCalls: Array<{ operation: string; telegramId: number; id?: number }> = [];
  const repository: PublicDataSource = {
    openSession: async (user) => {
      sessionTelegramId = user.id;
      return {
        user: {
          id: 1,
          first_name: user.first_name,
          last_name: null,
          username: user.username ?? null,
          language_code: user.language_code ?? "ru",
          timezone: "Asia/Yekaterinburg",
        },
        plan: "free",
        quotas: [],
      };
    },
    getToday: async (telegramId) => {
      protectedCalls.push({ operation: "today", telegramId });
      return { main_action: "Сделать первый шаг" };
    },
    listTasks: async (telegramId) => {
      tasksTelegramId = telegramId;
      return [{
        id: "7",
        title: "Проверить следующий шаг",
        description: null,
        status: "open",
        priority: 3,
        due_at: null,
        remind_at: null,
        completed_at: null,
        updated_at: NOW,
      }];
    },
    listGoals: async (telegramId) => {
      protectedCalls.push({ operation: "goals", telegramId });
      return [{ id: "3", title: "Подготовить запуск" }];
    },
    createGoal: async (telegramId, input) => {
      protectedCalls.push({ operation: "create-goal", telegramId });
      return { id: "4", ...input };
    },
    updateGoal: async (telegramId, goalId, input) => {
      protectedCalls.push({ operation: "update-goal", telegramId, id: goalId });
      return { id: String(goalId), ...input };
    },
    getProfile: async (telegramId) => ({
      telegram_id: telegramId,
      confirmed: [],
      candidates: [],
    }),
    updateProfile: async (telegramId, input) => ({
      telegram_id: telegramId,
      input,
    }),
    getProgress: async (telegramId) => {
      protectedCalls.push({ operation: "progress", telegramId });
      return { completed_results: [] };
    },
    startWorkBlock: async (telegramId, workBlockId) => {
      protectedCalls.push({ operation: "start", telegramId, id: workBlockId });
      return { id: String(workBlockId), status: "active" };
    },
    completeWorkBlock: async (telegramId, workBlockId) => {
      protectedCalls.push({ operation: "complete", telegramId, id: workBlockId });
      return { id: String(workBlockId), status: "completed" };
    },
    listConversations: async (telegramId) => [{ id: "conv-1", title: "Основной чат", active: true, telegram_id: telegramId }],
    createConversation: async (telegramId, input) => ({ id: "conv-2", title: input.title, active: true, telegram_id: telegramId }),
    activateConversation: async (telegramId, conversationId) => ({ id: conversationId, active: true, telegram_id: telegramId }),
    archiveConversation: async (telegramId, conversationId) => ({ id: conversationId, archived: true, replacement_id: "conv-2", telegram_id: telegramId }),
  };
  const app = Fastify();
  registerPublicRoutes(app, {
    config: {
      telegramBotToken: BOT_TOKEN,
      telegramWebAppMaxAgeSeconds: 3_600,
    } as never,
    repository,
    now: () => NOW,
  });
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));

  const session = await app.inject({
    method: "POST",
    url: "/public/session",
    headers: { "x-telegram-init-data": initData },
    payload: { user_id: 999999 },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().user.first_name, "Виктор");
  assert.equal(sessionTelegramId, USER.id);

  const tasks = await app.inject({
    method: "GET",
    url: "/public/tasks",
    headers: { "x-telegram-init-data": initData },
  });
  assert.equal(tasks.statusCode, 200);
  assert.equal(tasks.json().tasks[0].id, "7");
  assert.equal(tasksTelegramId, USER.id);

  const profile = await app.inject({
    method: "PATCH",
    url: "/public/profile",
    headers: { "x-telegram-init-data": initData },
    payload: { user_id: 999999, fields: { preferred_name: "Виктор" } },
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().profile.telegram_id, USER.id);
  assert.equal(profile.json().profile.input.user_id, 999999);

  const conversationRequests = [
    { method: "GET", url: "/public/conversations" },
    { method: "POST", url: "/public/conversations", payload: { title: "Новый чат", user_id: 999999 } },
    { method: "POST", url: "/public/conversations/conv-1/activate", payload: { user_id: 999999 } },
    { method: "DELETE", url: "/public/conversations/conv-1", payload: { user_id: 999999 } },
  ] as const;
  for (const request of conversationRequests) {
    const response = await app.inject({ ...request, headers: { "x-telegram-init-data": initData } });
    assert.equal(response.statusCode, 200, `${request.method} ${request.url}: ${response.body}`);
    assert.equal(response.json().conversation?.telegram_id ?? response.json().conversations?.[0]?.telegram_id, USER.id);
  }

  const protectedRequests = [
    { method: "GET", url: "/public/today" },
    { method: "GET", url: "/public/goals" },
    { method: "POST", url: "/public/goals", payload: { title: "Новая цель" } },
    { method: "PATCH", url: "/public/goals/3", payload: { status: "paused" } },
    { method: "GET", url: "/public/progress" },
    { method: "POST", url: "/public/work-blocks/8/start", payload: {} },
    { method: "POST", url: "/public/work-blocks/8/complete", payload: {} },
  ] as const;
  for (const request of protectedRequests) {
    const response = await app.inject({
      ...request,
      headers: { "x-telegram-init-data": initData },
    });
    assert.equal(response.statusCode, 200, `${request.method} ${request.url}`);
  }
  assert.deepEqual(
    protectedCalls.map((call) => call.telegramId),
    Array(protectedRequests.length).fill(USER.id),
  );
  assert.equal(protectedCalls.find((call) => call.operation === "start")?.id, 8);

  const missing = await app.inject({ method: "GET", url: "/public/tasks" });
  assert.equal(missing.statusCode, 401);
  await app.close();
});

function signInitData(
  user: Record<string, unknown>,
  authDate: number,
): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAEAAAE",
    signature: "telegram-ed25519-signature",
    user: JSON.stringify(user),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
