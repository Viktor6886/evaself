import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import Fastify from "fastify";

import { loadConfig } from "../dist/config.js";
import {
  registerPublicRoutes,
  type PublicDataSource,
} from "../dist/public/routes.js";
import {
  initDataFingerprint,
  ValkeyMiniAppSessions,
} from "../dist/public/webapp-session.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFG";
const NOW = new Date("2026-07-29T08:00:00.000Z");
const USER = { id: 424242, first_name: "Виктор", username: "viktor" };

// ---------------------------------------------------------------------
// Заглушка Valkey: ровно те операции, которыми пользуется хранилище.
// ---------------------------------------------------------------------
class FakeRedis {
  readonly store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    _mode: "EX",
    _ttl: number,
    condition?: "NX",
  ): Promise<string | null> {
    if (condition === "NX" && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

// ---------------------------------------------------------------------
// Окно приёма initData
// ---------------------------------------------------------------------
test("окно приёма initData зажато в 300–600 секунд", () => {
  const base = { EVA_TELEGRAM_BOT_TOKEN: BOT_TOKEN };
  const read = (value: string): number =>
    loadConfig({ ...base, EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS: value } as never)
      .telegramWebAppMaxAgeSeconds;

  // Прежнее значение по умолчанию — час — больше не принимается.
  assert.equal(read("3600"), 600);
  assert.equal(read("86400"), 600);
  // Слишком короткое окно ломало бы медленные соединения.
  assert.equal(read("5"), 300);
  assert.equal(read("450"), 450);
  assert.equal(
    loadConfig(base as never).telegramWebAppMaxAgeSeconds,
    600,
    "по умолчанию — верхняя граница диапазона, а не час",
  );
});

// ---------------------------------------------------------------------
// Обмен initData на сессию и защита от повтора
// ---------------------------------------------------------------------
test("initData обменивается на сессию ровно один раз", async () => {
  const redis = new FakeRedis();
  const sessions = new ValkeyMiniAppSessions(redis as never);
  const app = buildApp(sessions);
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));

  const first = await app.inject({
    method: "POST",
    url: "/public/session",
    headers: { "x-telegram-init-data": initData },
  });
  assert.equal(first.statusCode, 200);
  const token = first.json().session_token as string;
  assert.ok(token && token.length >= 32, "сессионный токен выдан");
  assert.equal(first.json().session_expires_in, 900);

  // Повтор той же строки — перехваченная initData не даёт второй сессии.
  const replay = await app.inject({
    method: "POST",
    url: "/public/session",
    headers: { "x-telegram-init-data": initData },
  });
  assert.equal(replay.statusCode, 401);

  await app.close();
});

test("сессионный токен заменяет initData на защищённых маршрутах", async () => {
  const redis = new FakeRedis();
  const sessions = new ValkeyMiniAppSessions(redis as never);
  const app = buildApp(sessions);
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));

  const opened = await app.inject({
    method: "POST",
    url: "/public/session",
    headers: { "x-telegram-init-data": initData },
  });
  const token = opened.json().session_token as string;

  const withSession = await app.inject({
    method: "GET",
    url: "/public/tasks",
    headers: { "x-eva-webapp-session": token },
  });
  assert.equal(withSession.statusCode, 200);
  assert.equal(withSession.json().tasks[0].id, "7");

  await app.close();
});

test("негодный сессионный токен отвергается и не откатывается на initData", async () => {
  const redis = new FakeRedis();
  const sessions = new ValkeyMiniAppSessions(redis as never);
  const app = buildApp(sessions);
  const initData = signInitData(USER, Math.floor(NOW.getTime() / 1000));

  // Заголовок сессии предъявлен — значит клиент утверждает, что сессия у
  // него есть. Молча принять вместо неё initData значило бы дать обход.
  const forged = await app.inject({
    method: "GET",
    url: "/public/tasks",
    headers: {
      "x-eva-webapp-session": "a".repeat(43),
      "x-telegram-init-data": initData,
    },
  });
  assert.equal(forged.statusCode, 401);

  await app.close();
});

test("токен хранится в Valkey только как SHA-256", async () => {
  const redis = new FakeRedis();
  const sessions = new ValkeyMiniAppSessions(redis as never);
  const token = await sessions.issue(USER as never, 900);

  const keys = [...redis.store.keys()];
  assert.equal(keys.length, 1);
  assert.ok(
    !keys[0]!.includes(token),
    "сырой токен не должен попадать в ключ: дамп Valkey не даёт готовый доступ",
  );
  const values = [...redis.store.values()].join(" ");
  assert.ok(!values.includes(token), "сырой токен не должен попадать в значение");

  // При этом сам токен по-прежнему разрешается.
  const record = await sessions.resolve(token);
  assert.equal(record?.user.id, USER.id);
});

test("повторная заявка на тот же initData отвергается на уровне хранилища", async () => {
  const redis = new FakeRedis();
  const sessions = new ValkeyMiniAppSessions(redis as never);
  const fingerprint = initDataFingerprint(
    signInitData(USER, Math.floor(NOW.getTime() / 1000)),
  );

  assert.equal(await sessions.claimInitData(fingerprint, 600), true);
  assert.equal(await sessions.claimInitData(fingerprint, 600), false);
});

// ---------------------------------------------------------------------
function buildApp(sessions: ValkeyMiniAppSessions) {
  const repository: PublicDataSource = {
    openSession: async (user) => ({
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: null,
        username: user.username ?? null,
        language_code: "ru",
        timezone: "Europe/Moscow",
      },
      plan: "free",
      quotas: [],
    }),
    getToday: async () => ({}),
    listTasks: async () => [
      {
        id: "7",
        title: "Задача",
        description: null,
        status: "open",
        priority: 3,
        due_at: null,
        remind_at: null,
        completed_at: null,
        updated_at: NOW,
      },
    ],
    listGoals: async () => [],
    createGoal: async () => ({}),
    updateGoal: async () => ({}),
    getProfile: async () => ({}),
    updateProfile: async () => ({}),
    getProgress: async () => ({}),
    startWorkBlock: async () => ({}),
    completeWorkBlock: async () => ({}),
  };
  const app = Fastify();
  registerPublicRoutes(app, {
    config: {
      telegramBotToken: BOT_TOKEN,
      telegramWebAppMaxAgeSeconds: 600,
      webAppSessionTtlSeconds: 900,
    } as never,
    repository,
    now: () => NOW,
    sessions,
  });
  return app;
}

function signInitData(user: Record<string, unknown>, authDate: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAEAAAE",
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
