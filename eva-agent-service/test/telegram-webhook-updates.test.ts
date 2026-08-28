/**
 * Список видов апдейтов — один на всех, кто ставит вебхук.
 *
 * Чего в нём нет, того webhook не увидит: молча, без ошибки где-либо.
 * Именно так не работала оплата звёздами — `pre_checkout_query` добавили
 * в код, но бот, зарегистрированный раньше, остался с прежним списком,
 * Telegram не спрашивал подтверждения и отменял платёж по таймауту.
 *
 * Ставят вебхук трое: рантайм при старте, переезд на другого бота в
 * панели и скрипт установщика. Разойдись любой из них — отказ будет
 * такой же тихий. Скрипт сверяется отдельно, проверкой уровня
 * репозитория: тесты сервиса идут внутри образа, где корня репозитория
 * нет и быть не должно.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sameAllowedUpdates,
  TELEGRAM_ALLOWED_UPDATES,
} from "../dist/telegram/allowed-updates.js";
import { TelegramClient } from "../dist/telegram.js";

test("оплата и опросы входят в список: без них они не доходят вовсе", () => {
  assert.equal(TELEGRAM_ALLOWED_UPDATES.includes("pre_checkout_query" as never), true);
  assert.equal(TELEGRAM_ALLOWED_UPDATES.includes("poll_answer" as never), true);
  assert.equal(TELEGRAM_ALLOWED_UPDATES.includes("message" as never), true);
  assert.equal(TELEGRAM_ALLOWED_UPDATES.includes("callback_query" as never), true);
});

test("сверка отличает прежний список от действующего", () => {
  assert.equal(sameAllowedUpdates([...TELEGRAM_ALLOWED_UPDATES]), true);
  // Порядок Telegram не гарантирует.
  assert.equal(sameAllowedUpdates([...TELEGRAM_ALLOWED_UPDATES].reverse()), true);
  // Ровно тот список, с которым бот был зарегистрирован до оплаты.
  assert.equal(sameAllowedUpdates(["message", "edited_message", "callback_query"]), false);
  // Умолчание Telegram: поле отсутствует — значит доставляется не то,
  // что нам нужно.
  assert.equal(sameAllowedUpdates(undefined), false);
});

/** Клиент с подставленным Bot API: настоящих запросов не делаем. */
function client(info: Record<string, unknown>) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "TOKEN", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = (async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    if (method === "getWebhookInfo") return info;
    return true;
  }) as never;
  return { telegram, calls };
}

const URL_ = "https://api.example.test/telegram/webhook";

test("бот с прежним списком получает новый при старте", async () => {
  // Ровно состояние стенда: вебхук стоит, но зарегистрирован до того,
  // как в список добавили оплату.
  const { telegram, calls } = client({
    url: URL_, allowed_updates: ["message", "edited_message", "callback_query"],
  });
  assert.equal(await telegram.ensureWebhook(URL_, "секрет"), "updated");
  const set = calls.find((item) => item.method === "setWebhook");
  assert.ok(set, "вебхук не переставлен");
  assert.deepEqual([...(set!.body.allowed_updates as string[])].sort(),
    [...TELEGRAM_ALLOWED_UPDATES].sort());
  // Накопленные сообщения — наши: это не переезд на другого бота.
  assert.equal(set!.body.drop_pending_updates, false);
});

test("совпадающий вебхук не трогается", async () => {
  const { telegram, calls } = client({
    url: URL_, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
  });
  assert.equal(await telegram.ensureWebhook(URL_, "секрет"), "ok");
  assert.equal(calls.some((item) => item.method === "setWebhook"), false,
    "лишний setWebhook сбрасывал бы вебхук на каждом старте");
});

test("отказ Telegram не мешает сервису подняться", async () => {
  const telegram = new TelegramClient(
    { telegramBotToken: "TOKEN", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = (async () => { throw new Error("Telegram недоступен"); }) as never;
  assert.equal(await telegram.ensureWebhook(URL_, "секрет"), "failed");
});

/*
 * Ожидание — тоже отказ.
 *
 * У бота десять секунд на подтверждение списания, после которых Telegram
 * отменяет платёж сам. Запрос без срока может провисеть дольше — и
 * человек увидит BOT_PRECHECKOUT_TIMEOUT вместо ответа, который сервис
 * якобы отправил.
 */
test("ответ на предварительную проверку не ждёт дольше отведённого", async () => {
  const seen: Array<{ method: string; timeout: number | undefined }> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "TOKEN", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = (async (
    method: string,
    _body: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    seen.push({ method, timeout: timeoutMs });
    return true;
  }) as never;

  await telegram.answerPreCheckout("q-1", true);
  assert.equal(seen[0]?.method, "answerPreCheckoutQuery");
  assert.ok(
    typeof seen[0]?.timeout === "number" && seen[0].timeout <= 10_000,
    "ответ обязан укладываться в срок, который даёт Telegram",
  );
});

test("сверка вебхука при старте не висит бесконечно", async () => {
  const seen: number[] = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "TOKEN", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = (async (
    _method: string,
    _body: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    seen.push(timeoutMs ?? 0);
    return { url: URL_, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] };
  }) as never;
  await telegram.ensureWebhook(URL_, "секрет");
  assert.ok(seen.every((value) => value > 0), "запрос при старте остался без срока");
});
