/**
 * Боты Евы: набор токенов и переезд между ними.
 *
 * Токен Telegram — личность бота, а не взаимозаменяемый ключ, поэтому
 * проверяется не ротация, а выбор: что активен ровно один, что переезд
 * переставляет вебхук и что сам токен никуда не утекает.
 *
 * Что здесь НЕ проверяется: правила схемы. Единственность активного и
 * запрет на дубль бота держат частичные индексы, и проверены они на
 * живом PostgreSQL в CI, а не поддельным пулом.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTelegramRuntimeApply,
  TelegramTokenService,
} from "../dist/admin/telegram-token-service.js";
import { containerNameOf } from "../dist/admin/service-catalog.js";
import { TelegramClient } from "../dist/telegram.js";
import { buildServer } from "../dist/server.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const ENVELOPE = {
  ciphertext: Buffer.from("cipher"),
  nonce: Buffer.alloc(12),
  authTag: Buffer.alloc(16),
};

/** Хранилище секретов: шифрование здесь не предмет проверки. */
function secrets(written: Array<{ ref: string; value: string }>) {
  return {
    seal: () => ENVELOPE,
    open: () => "TOKEN-VALUE",
    put: async (ref: string, value: string) => { written.push({ ref, value }); return {} as never; },
  };
}

function pool(rows: Record<string, unknown[]>, executed: string[] = []) {
  return {
    async query(text: string) {
      executed.push(text.trim().split("\n")[0]!.trim());
      if (text.includes("count(*)")) return { rows: rows.count ?? [{ count: "0" }] };
      if (text.startsWith("SELECT ciphertext")) return { rows: rows.previous ?? [] };
      if (text.startsWith("INSERT INTO telegram_bot_tokens")) return { rows: rows.inserted ?? [] };
      if (text.startsWith("UPDATE telegram_bot_tokens\n          SET is_active = true")
        || text.includes("SET is_active = true")) return { rows: rows.activated ?? [] };
      if (text.startsWith("SELECT *")) return { rows: rows.row ?? [] };
      if (text.startsWith("SELECT id, label")) return { rows: rows.list ?? [] };
      return { rows: [] };
    },
  } as never;
}

const logger = { info() {}, warn() {} };

function service(overrides: Record<string, unknown>) {
  return new TelegramTokenService({
    pool: overrides.pool, secrets: overrides.secrets, api: overrides.api,
    runtime: overrides.runtime,
    webhookUrl: "https://api.eva.test/telegram/webhook",
    webhookSecret: "hook-secret",
    logger,
  } as never);
}

const ROW = (extra: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  label: "рабочий", bot_id: 7, bot_username: "eva_bot",
  ...ENVELOPE, auth_tag: ENVELOPE.authTag,
  is_active: false, created_at: "2026-08-27T10:00:00Z", activated_at: null,
  ...extra,
});

test("токен проверяется у Telegram до записи в базу", async () => {
  const asked: string[] = [];
  const svc = service({
    pool: pool({ inserted: [ROW()] }),
    secrets: secrets([]),
    api: {
      identify: async (token: string) => { asked.push(token); return { id: 7, username: "eva_bot" }; },
      setWebhook: async () => {}, deleteWebhook: async () => {},
    },
  });

  const created = await svc.add({ token: "  123:ABC  ", label: " рабочий " }, "admin-1");
  // Пробелы по краям — след копирования из чата, а не часть токена.
  assert.deepEqual(asked, ["123:ABC"]);
  assert.equal(created.bot_username, "eva_bot");
  // Наружу уходит метка и имя бота, но не токен.
  assert.equal(Object.hasOwn(created, "token"), false);
  assert.doesNotMatch(JSON.stringify(created), /123:ABC/u);
});

test("токен, который Telegram не принял, до базы не доходит", async () => {
  const executed: string[] = [];
  const svc = service({
    pool: pool({}, executed),
    secrets: secrets([]),
    api: {
      identify: async () => { throw new Error("Unauthorized"); },
      setWebhook: async () => {}, deleteWebhook: async () => {},
    },
  });

  await assert.rejects(() => svc.add({ token: "опечатка", label: "бот" }, null), /Unauthorized/u);
  assert.equal(executed.some((query) => query.startsWith("INSERT")), false,
    "опечатка не должна попадать в базу");
});

test("шестой бот отвергается с внятной причиной", async () => {
  const svc = service({
    pool: pool({ count: [{ count: "5" }] }),
    secrets: secrets([]),
    api: { identify: async () => ({ id: 1, username: "x" }), setWebhook: async () => {}, deleteWebhook: async () => {} },
  });
  await assert.rejects(() => svc.add({ token: "t", label: "шестой" }, null), /предел/u);
});

/**
 * Порядок шагов переезда важнее самого переезда: ни один отказ не
 * должен оставить установку между двумя ботами.
 */
test("вебхук ставится новому боту раньше, чем токен становится активным", async () => {
  const order: string[] = [];
  const written: Array<{ ref: string; value: string }> = [];
  const svc = service({
    pool: pool({
      row: [ROW()],
      previous: [{ ...ENVELOPE, auth_tag: ENVELOPE.authTag, bot_username: "старый_bot" }],
      activated: [ROW({ is_active: true, activated_at: "2026-08-27T11:00:00Z" })],
    }),
    secrets: {
      seal: () => ENVELOPE,
      open: () => "TOKEN-VALUE",
      put: async (ref: string, value: string) => { order.push("secret"); written.push({ ref, value }); return {} as never; },
    },
    api: {
      identify: async () => ({ id: 7, username: "eva_bot" }),
      setWebhook: async (_t: string, url: string, secret: string) => {
        order.push("setWebhook");
        assert.equal(url, "https://api.eva.test/telegram/webhook");
        assert.equal(secret, "hook-secret");
      },
      deleteWebhook: async () => { order.push("deleteWebhook"); },
    },
  });

  const result = await svc.activate(ROW().id, "admin-1");
  assert.deepEqual(order, ["setWebhook", "secret", "deleteWebhook"]);
  // Активный токен ложится в прежний ref: его читают service-catalog,
  // bootstrap и форма интеграций, и менять их не пришлось.
  assert.deepEqual(written, [{ ref: "sec_eva_telegram_bot_token", value: "TOKEN-VALUE" }]);
  // Именно `up -d`: перезапуск отдаёт контейнеру то окружение, с
  // которым он был создан, и правку `.env` не заметил бы.
  assert.equal(result.restart_required, "docker compose up -d eva-agent-service");
});

test("отказ Telegram на новом боте оставляет прежнего нетронутым", async () => {
  const written: Array<{ ref: string; value: string }> = [];
  const svc = service({
    pool: pool({ row: [ROW()] }),
    secrets: secrets(written),
    api: {
      identify: async () => ({ id: 7, username: "eva_bot" }),
      setWebhook: async () => { throw new Error("Bad webhook"); },
      deleteWebhook: async () => { throw new Error("не должен вызываться"); },
    },
  });

  await assert.rejects(() => svc.activate(ROW().id, null), /Bad webhook/u);
  assert.deepEqual(written, [], "переезд не состоялся — секрет не тронут");
});

test("неудача при снятии вебхука у прежнего переезд не откатывает", async () => {
  const written: Array<{ ref: string; value: string }> = [];
  const svc = service({
    pool: pool({
      row: [ROW()],
      previous: [{ ...ENVELOPE, auth_tag: ENVELOPE.authTag, bot_username: "старый_bot" }],
      activated: [ROW({ is_active: true })],
    }),
    secrets: secrets(written),
    api: {
      identify: async () => ({ id: 7, username: "eva_bot" }),
      setWebhook: async () => {},
      // Прежний бот мог быть удалён у BotFather — это уже не наша забота.
      deleteWebhook: async () => { throw new Error("Unauthorized"); },
    },
  });

  const result = await svc.activate(ROW().id, null);
  assert.equal(result.token.is_active, true);
  assert.equal(written.length, 1);
});

/**
 * Переезд обязан дойти до работающего сервиса.
 *
 * secret_records читают только административные контейнеры: мастер-ключ
 * монтируется им, а eva-agent-service берёт токен из окружения при
 * старте. Без записи в `.env` переезд ломался ровно посередине — вебхук
 * уже стоял на новом боте и входящие приходили ему, а ответы уходили
 * прежним токеном. Со стороны выглядело так, будто новый бот пересылает
 * сообщения старому.
 */
test("выбранный токен доезжает и до .env, и до работающего сервиса", async () => {
  const order: string[] = [];
  let written: string | null = null;
  let live: string | null = null;
  const svc = service({
    pool: pool({
      row: [ROW()],
      previous: [{ ...ENVELOPE, auth_tag: ENVELOPE.authTag, bot_username: "старый_bot" }],
      activated: [ROW({ is_active: true })],
    }),
    secrets: secrets([]),
    api: {
      identify: async () => ({ id: 7, username: "eva_bot" }),
      setWebhook: async () => { order.push("setWebhook"); },
      deleteWebhook: async () => { order.push("deleteWebhook"); },
    },
    runtime: {
      persist: async (token: string) => { order.push("env"); written = token; },
      applyLive: async (token: string) => { order.push("live"); live = token; },
    },
  });

  const result = await svc.activate(ROW().id, null);
  assert.equal(written, "TOKEN-VALUE", "в .env должен уехать сам токен");
  assert.equal(live, "TOKEN-VALUE", "и он же — в работающий сервис");
  // Вебхук первым: откажет Telegram — ничего ещё не изменилось.
  assert.deepEqual(order, ["setWebhook", "env", "live", "deleteWebhook"]);
  assert.equal(result.applied_live, true);
  assert.equal(result.apply_error, null);
});

test("недоступный сервис операций не отменяет переезд, но и не молчит", async () => {
  const svc = service({
    pool: pool({ row: [ROW()], activated: [ROW({ is_active: true })] }),
    secrets: secrets([]),
    api: {
      identify: async () => ({ id: 7, username: "eva_bot" }),
      setWebhook: async () => {}, deleteWebhook: async () => {},
    },
    runtime: {
      persist: async () => { throw new Error("socket недоступен"); },
      applyLive: async () => { throw new Error("не должен вызываться"); },
    },
  });

  const result = await svc.activate(ROW().id, null);
  // Выбор записан и вебхук переставлен — откатывать это поздно и незачем.
  assert.equal(result.token.is_active, true);
  // Но человеку сказано, что руками осталось сделать.
  assert.equal(result.applied_live, false);
  assert.match(result.apply_error ?? "", /socket недоступен/u);
});

test("без сервиса операций переезд честно сообщает, что не применён", async () => {
  const svc = service({
    pool: pool({ row: [ROW()], activated: [ROW({ is_active: true })] }),
    secrets: secrets([]),
    api: {
      identify: async () => ({ id: 7, username: "eva_bot" }),
      setWebhook: async () => {}, deleteWebhook: async () => {},
    },
    // runtime не передан вовсе.
  });
  const result = await svc.activate(ROW().id, null);
  assert.equal(result.applied_live, false);
  assert.match(result.apply_error ?? "", /недоступен/u);
});

test("активного бота удалить нельзя", async () => {
  const svc = service({
    pool: pool({ row: [ROW({ is_active: true })] }),
    secrets: secrets([]),
    api: { identify: async () => ({ id: 1, username: "x" }), setWebhook: async () => {}, deleteWebhook: async () => {} },
  });
  await assert.rejects(() => svc.remove(ROW().id), /Нельзя удалить активного/u);
});

test("список не содержит ни токена, ни его шифротекста", async () => {
  const svc = service({
    pool: pool({ list: [ROW({ is_active: true })] }),
    secrets: secrets([]),
    api: { identify: async () => ({ id: 1, username: "x" }), setWebhook: async () => {}, deleteWebhook: async () => {} },
  });
  const view = await svc.list();
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /cipher|ciphertext|auth_tag|TOKEN-VALUE/u);
  assert.equal(view.tokens[0]!.bot_username, "eva_bot");
  assert.equal(view.limit, 5);
});

/*
 * Как выбор доходит до прода.
 *
 * Обе цели пишутся строками в чужие контракты, и ошибка в них видна
 * только на живой установке: панель отвечала «Сервис отсутствует в
 * списке разрешённых», потому что перезапуск просили по имени
 * контейнера, а сервис операций знает цели по идентификаторам каталога.
 */
/*
 * Токен нужен двум службам, а не одной.
 *
 * Рантайм им отвечает, media-service — скачивает голосовое у Telegram.
 * Переезд, дошедший только до первой, выглядел исправным: Ева отвечала
 * текстом, а голосовые переставали распознаваться, и человек видел
 * общее «не получилось распознать» без единого указания на причину.
 */
test("боевой адаптер доносит токен до всех, кому он нужен", async () => {
  const updaterCalls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const agentCalls: Array<{ path: string; body: unknown }> = [];
  const mediaCalls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: { body?: unknown } = {}) => {
    mediaCalls.push({ url: String(url), body: init.body });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const apply = createTelegramRuntimeApply({
      updater: {
        call: async (command: string, params: Record<string, unknown> = {}) => {
          updaterCalls.push({ command, params });
          return null;
        },
      },
      agent: {
        request: async (path: string, options: { body?: unknown } = {}) => {
          agentCalls.push({ path, body: options.body });
          return null;
        },
      },
      media: {
        baseUrl: "http://media-service:8090",
        serviceToken: async () => "media-key",
      },
    });

    await apply.persist("TOKEN-VALUE");
    await apply.applyLive("TOKEN-VALUE");

    assert.deepEqual(updaterCalls, [
      { command: "set_telegram_token", params: { token: "TOKEN-VALUE" } },
    ]);
    assert.equal(agentCalls.length, 1);
    assert.equal(agentCalls[0]?.path, "/v1/telegram/token");
    assert.deepEqual(JSON.parse(String(agentCalls[0]?.body)), { token: "TOKEN-VALUE" });

    assert.equal(mediaCalls.length, 1, "media-service тоже должен узнать о переезде");
    assert.match(mediaCalls[0]?.url ?? "", /\/config\/media$/u);
    assert.deepEqual(
      JSON.parse(String(mediaCalls[0]?.body)),
      { telegram: { bot_token: "TOKEN-VALUE" } },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("недоступный media-service не выдаётся за успешный переезд", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof globalThis.fetch;
  try {
    const apply = createTelegramRuntimeApply({
      updater: { call: async () => null },
      agent: { request: async () => null },
      media: { baseUrl: "http://media-service:8090", serviceToken: async () => "media-key" },
    });
    // Переезд состоялся, но распознавание осталось на прежнем боте:
    // человеку об этом говорят, а не показывают зелёную галочку.
    await assert.rejects(() => apply.applyLive("TOKEN-VALUE"), /распознавание голоса/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("сервис операций знает цели по идентификаторам каталога", () => {
  assert.equal(containerNameOf("agent-runtime"), "evaself-eva-agent-service");
  // Имя сервиса compose целью не является. Разница между этими двумя
  // строками и стоила человеку отказа на кнопке «Сделать активным».
  assert.equal(containerNameOf("eva-agent-service"), null);
});

/*
 * Переезд обязан состояться в этом же процессе.
 *
 * Перезапуск здесь не помощник: compose подставляет
 * `EVA_TELEGRAM_BOT_TOKEN` в контейнер при создании, и перезапущенный
 * контейнер получает то же окружение, что и раньше. Пока рантайм не
 * умеет сменить токен на ходу, панель может сколько угодно писать
 * `.env` — отвечать будет прежний бот.
 */
test("рантайм отвечает новым ботом сразу после смены токена", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: { username: "новый_bot" } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const telegram = new TelegramClient(
      { telegramBotToken: "СТАРЫЙ", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
      { debug() {}, info() {}, warn() {}, error() {} },
    );
    await telegram.call("sendMessage", { chat_id: 1, text: "до" });
    telegram.setToken("НОВЫЙ");
    await telegram.call("sendMessage", { chat_id: 1, text: "после" });

    assert.match(urls[0] ?? "", /\/botСТАРЫЙ\//u);
    assert.match(urls[1] ?? "", /\/botНОВЫЙ\//u, "исходящие обязаны уйти новым токеном");
    // Имя бота кешируется на время процесса — после переезда кеш назвал
    // бы человеку прежнего бота.
    assert.equal(await telegram.username(), "новый_bot");
  } finally {
    globalThis.fetch = original;
  }
});

/*
 * Дорога, которой панель доносит токен до рантайма.
 *
 * Она же — единственная: мастер-ключ секретов этому сервису не
 * монтируется, поэтому расшифровать токен он не может и получает его
 * готовым, тем же внутренним ключом, что и остальные `/v1`.
 */
test("внутренний маршрут смены токена закрыт ключом и меняет бота", async () => {
  const API_KEY = "test-internal-key-32-characters!!";
  const applied: string[] = [];
  const config = {
    apiKey: API_KEY,
    port: 0,
    host: "127.0.0.1",
    domains: { root: "", app: "", api: "", letta: "", status: "" },
    turnLifecycleEnabled: false,
    healthRateLimitPerIp: 100,
    rateLimitWindowSeconds: 60,
    publicRateLimitPerIp: 100,
    publicRateLimitPerUser: 100,
    webhookRateLimitPerIp: 100,
    telegramBotToken: "СТАРЫЙ",
  };
  const app = buildServer({
    config: config as never,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    db: withTenantScopes({
      query: async () => ({ rows: [] }),
      poolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
    }) as never,
    letta: { sessionStats: () => ({ active: 0, idle: 0 }) } as never,
    sdk: {} as never,
    llm: {} as never,
    inbox: {} as never,
    profile: {} as never,
    goals: {} as never,
    payments: {} as never,
    queue: { activeUsers: 0, queuedUsers: 0 } as never,
    telegram: {
      setToken: (token: string) => { applied.push(token); },
      username: async () => "новый_bot",
    } as never,
    redisPing: async () => true,
  });
  try {
    const anonymous = await app.inject({
      method: "POST", url: "/v1/telegram/token", payload: { token: "НОВЫЙ" },
    });
    assert.equal(anonymous.statusCode, 401, "чужой смены бота быть не может");
    assert.deepEqual(applied, []);

    const empty = await app.inject({
      method: "POST", url: "/v1/telegram/token",
      headers: { "x-api-key": API_KEY }, payload: { token: "   " },
    });
    assert.equal(empty.statusCode, 400);

    const ok = await app.inject({
      method: "POST", url: "/v1/telegram/token",
      headers: { "x-api-key": API_KEY }, payload: { token: "НОВЫЙ" },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(JSON.parse(ok.body), { applied: true, username: "новый_bot" });
    assert.deepEqual(applied, ["НОВЫЙ"]);
    // Mini App проверяет initData тем же токеном: он читается из config
    // на каждом запросе, поэтому переезд обязан дойти и туда.
    assert.equal(config.telegramBotToken, "НОВЫЙ");
  } finally {
    await app.close();
  }
});
