import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import Fastify from "fastify";

import {
  registerPublicRoutes,
  type PublicDataSource,
} from "../dist/public/routes.js";
import { EvaError } from "../dist/errors.js";
import {
  clientAddress,
  enforceRateLimit,
  ValkeyRateLimiter,
} from "../dist/public/rate-limit.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFG";
const NOW = new Date("2026-07-29T08:00:00.000Z");
const USER = { id: 424242, first_name: "Виктор" };
const OTHER = { id: 515151, first_name: "Борис" };

class FakeRedis {
  readonly counters = new Map<string, number>();
  readonly ttls = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -1;
  }
}

test("счётчик окна пропускает лимит и отсекает следующий запрос", async () => {
  const limiter = new ValkeyRateLimiter(new FakeRedis() as never);
  for (let i = 0; i < 3; i += 1) {
    const verdict = await limiter.hit("bucket", 3, 60);
    assert.equal(verdict.allowed, true, `запрос ${i + 1} в пределах лимита`);
  }
  const blocked = await limiter.hit("bucket", 3, 60);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
});

test("лимит 0 отключает проверку целиком", async () => {
  const limiter = new ValkeyRateLimiter(new FakeRedis() as never);
  for (let i = 0; i < 50; i += 1) {
    assert.equal((await limiter.hit("off", 0, 60)).allowed, true);
  }
});

test("разные корзины не мешают друг другу", async () => {
  const limiter = new ValkeyRateLimiter(new FakeRedis() as never);
  assert.equal((await limiter.hit("a", 1, 60)).allowed, true);
  assert.equal((await limiter.hit("a", 1, 60)).allowed, false);
  assert.equal((await limiter.hit("b", 1, 60)).allowed, true);
});

test("адрес клиента берётся из первого элемента X-Forwarded-For", () => {
  // Всё, кроме первого элемента, клиент может написать сам.
  assert.equal(
    clientAddress({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 127.0.0.1" }, "1.2.3.4"),
    "203.0.113.7",
  );
  assert.equal(clientAddress({}, "1.2.3.4"), "1.2.3.4");
  assert.equal(clientAddress({ "x-forwarded-for": "   " }, "1.2.3.4"), "1.2.3.4");
  assert.equal(clientAddress({}, undefined), "unknown");
});

test("публичные маршруты отвечают 429 при превышении лимита по IP", async () => {
  const app = buildApp({ perIp: 2, perUser: 1000 });
  const initData = signInitData(USER);
  const headers = { "x-telegram-init-data": initData, "x-forwarded-for": "203.0.113.9" };

  assert.equal((await app.inject({ method: "GET", url: "/public/tasks", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/public/tasks", headers })).statusCode, 200);

  const blocked = await app.inject({ method: "GET", url: "/public/tasks", headers });
  assert.equal(blocked.statusCode, 429);

  await app.close();
});

test("превышение лимита даёт retryable-ошибку rate_limited с задержкой", async () => {
  // Форму тела собирает обработчик ошибок из server.ts, поэтому здесь
  // проверяется сама брошенная ошибка, а не её сериализация.
  const limiter = new ValkeyRateLimiter(new FakeRedis() as never);
  await enforceRateLimit(limiter, "shape", { limit: 1, windowSeconds: 60 });

  await assert.rejects(
    () => enforceRateLimit(limiter, "shape", { limit: 1, windowSeconds: 60 }),
    (error: EvaError) => {
      assert.equal(error.code, "rate_limited");
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryable, true);
      assert.equal(
        (error.details as { retry_after_seconds: number }).retry_after_seconds,
        60,
      );
      // Сообщение не должно раскрывать ни счётчик, ни сам лимит.
      assert.ok(!/\d/.test(error.message), `в сообщении не должно быть чисел: ${error.message}`);
      return true;
    },
  );
});

test("лимит по личности считается отдельно от адреса", async () => {
  const app = buildApp({ perIp: 1000, perUser: 2 });
  const mine = signInitData(USER);
  const theirs = signInitData(OTHER);

  // Один и тот же пользователь с разных адресов упирается в свой лимит.
  for (const ip of ["203.0.113.1", "203.0.113.2"]) {
    const response = await app.inject({
      method: "GET",
      url: "/public/tasks",
      headers: { "x-telegram-init-data": mine, "x-forwarded-for": ip },
    });
    assert.equal(response.statusCode, 200);
  }
  const blocked = await app.inject({
    method: "GET",
    url: "/public/tasks",
    headers: { "x-telegram-init-data": mine, "x-forwarded-for": "203.0.113.3" },
  });
  assert.equal(blocked.statusCode, 429);

  // Другой пользователь при этом не задет.
  const other = await app.inject({
    method: "GET",
    url: "/public/tasks",
    headers: { "x-telegram-init-data": theirs, "x-forwarded-for": "203.0.113.1" },
  });
  assert.equal(other.statusCode, 200);

  await app.close();
});

test("идентификатор из тела запроса не влияет на корзину лимита", async () => {
  const app = buildApp({ perIp: 1000, perUser: 2 });
  const mine = signInitData(USER);

  // Клиент подставляет чужой user_id, надеясь считаться другим человеком.
  for (let i = 0; i < 2; i += 1) {
    const response = await app.inject({
      method: "PATCH",
      url: "/public/profile",
      headers: { "x-telegram-init-data": mine, "x-forwarded-for": "203.0.113.4" },
      payload: { user_id: 999999, fields: {} },
    });
    assert.equal(response.statusCode, 200);
  }
  const blocked = await app.inject({
    method: "PATCH",
    url: "/public/profile",
    headers: { "x-telegram-init-data": mine, "x-forwarded-for": "203.0.113.4" },
    payload: { user_id: 777777, fields: {} },
  });
  assert.equal(
    blocked.statusCode,
    429,
    "подмена user_id в теле не должна давать новую корзину",
  );

  await app.close();
});

test("неподписанный запрос тоже расходует лимит по адресу", async () => {
  // Иначе поток неподписанных запросов проходил бы бесплатно, а проверка
  // подписи всё равно стоит процессорного времени.
  const app = buildApp({ perIp: 2, perUser: 1000 });
  const headers = { "x-forwarded-for": "203.0.113.50" };

  assert.equal((await app.inject({ method: "GET", url: "/public/tasks", headers })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/public/tasks", headers })).statusCode, 401);
  const blocked = await app.inject({ method: "GET", url: "/public/tasks", headers });
  assert.equal(blocked.statusCode, 429);

  await app.close();
});

// ---------------------------------------------------------------------
function buildApp(limits: { perIp: number; perUser: number }) {
  const repository: PublicDataSource = {
    openSession: async (user) => ({
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: null,
        username: null,
        language_code: "ru",
        timezone: "UTC",
      },
      plan: "free",
      quotas: [],
    }),
    getToday: async () => ({}),
    listTasks: async () => [],
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
      rateLimitWindowSeconds: 60,
      publicRateLimitPerIp: limits.perIp,
      publicRateLimitPerUser: limits.perUser,
    } as never,
    repository,
    now: () => NOW,
    rateLimiter: new ValkeyRateLimiter(new FakeRedis() as never),
  });
  return app;
}

function signInitData(user: Record<string, unknown>): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(NOW.getTime() / 1000)),
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
