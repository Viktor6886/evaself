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

import { TelegramTokenService } from "../dist/admin/telegram-token-service.js";

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
  assert.equal(result.restart_required, "eva-agent-service");
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
