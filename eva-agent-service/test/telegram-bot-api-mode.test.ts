/**
 * Облачный или свой сервер Bot API — переключение из панели.
 *
 * Проверяется то, что обещано администратору: ключи приложения хранятся
 * там же, где остальные настройки Telegram, и не утекают ни в ответ, ни в
 * аудит; бот выходит из облака раньше, чем начинается переезд, а без
 * ответа облака переезд не начинается; `.env` меняется только в
 * разрешённых ключах.
 *
 * Что здесь НЕ проверяется: сам скрипт переключения и Docker — их
 * выполняет сервис операций на сервере.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { IntegrationConfigService } from "../dist/admin/integration-config-service.js";
import { auditParams } from "../dist/admin/redactor.js";
import { SecretStore } from "../dist/admin/secret-store.js";
import { containerNameOf, SERVICE_BY_ID } from "../dist/admin/service-catalog.js";
import { modeOf, TelegramBotApiModeService } from "../dist/admin/telegram-bot-api-mode.js";
import { setEnvValues, telegramApiCredentials } from "../dist/admin/updater-env.js";

const API_ID = "1234567";
const API_HASH = "0123456789abcdef0123456789abcdef";
const TOKEN = "123456:bot-token-value";

interface Call { command: string; params: Record<string, unknown>; timeoutMs?: number }

function harness(options: {
  baseUrl?: string;
  apiId?: string | null;
  apiHash?: string | null;
  token?: string | null;
  fetcher?: typeof fetch;
  updaterError?: Error;
  container?: Record<string, unknown> | Error;
} = {}) {
  const events: string[] = [];
  const calls: Call[] = [];
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const secretValues: Record<string, string | null> = {
    sec_telegram_api_hash: options.apiHash === undefined ? API_HASH : options.apiHash,
    sec_eva_telegram_bot_token: options.token === undefined ? TOKEN : options.token,
  };
  const service = new TelegramBotApiModeService({
    pool: {
      query: async () => ({
        rows: (options.apiId === undefined ? API_ID : options.apiId) === null
          ? []
          : [{ value_json: options.apiId === undefined ? API_ID : options.apiId }],
      }),
    } as never,
    secrets: {
      get: async (ref: string) => secretValues[ref] ?? null,
      list: async () => Object.entries(secretValues).map(([ref, value]) => ({
        secret_ref: ref, configured: Boolean(value), created_at: null, last_rotated_at: null, used_by: [],
      })),
    } as never,
    updater: {
      call: async (command: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
        events.push(`updater:${command}`);
        calls.push({ command, params, timeoutMs });
        if (command === "get_service_status") {
          if (options.container instanceof Error) throw options.container;
          return options.container ?? { exists: false, running: false, health: null };
        }
        if (options.updaterError) throw options.updaterError;
        return { completed: true };
      },
    } as never,
    baseUrl: options.baseUrl ?? "https://api.telegram.org",
    fetcher: options.fetcher ?? (async (url: string | URL | Request) => {
      events.push(`fetch:${String(url).replace(TOKEN, "<token>")}`);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch,
    logger: { info() {}, warn: (message: string, meta: unknown) => warnings.push({ message, meta }) },
  });
  return { service, events, calls, warnings };
}

test("режим определяется по адресу Bot API, с которым создан admin-api", () => {
  assert.equal(modeOf("https://api.telegram.org"), "cloud");
  assert.equal(modeOf("https://api.telegram.org/"), "cloud");
  assert.equal(modeOf("http://telegram-bot-api:8081"), "local");
});

test("состояние показывает ключи признаком, а не значением", async () => {
  const { service } = harness({ container: { exists: true, running: true, health: "healthy" } });
  const status = await service.status();
  assert.equal(status.mode, "cloud");
  assert.deepEqual(status.credentials, { api_id: API_ID, api_hash_configured: true });
  assert.equal(status.bot_token_configured, true);
  assert.deepEqual(status.server, { exists: true, running: true, health: "healthy" });
  assert.ok(!JSON.stringify(status).includes(API_HASH), "API Hash ушёл в ответ");
  assert.ok(!JSON.stringify(status).includes(TOKEN), "токен ушёл в ответ");
});

test("недоступный сервис операций не ломает раздел, а называет причину", async () => {
  const { service } = harness({ container: new Error("Сервис безопасного перезапуска недоступен") });
  const status = await service.status();
  assert.equal(status.server, null);
  assert.match(String(status.server_error), /недоступен/);
  assert.equal(status.credentials.api_id, API_ID);
});

test("бот выходит из облака раньше, чем начинается переезд", async () => {
  const { service, events, calls } = harness();
  const result = await service.switchMode("local");
  assert.deepEqual(result, { mode: "local", admin_restart_scheduled: true });
  assert.deepEqual(events, ["fetch:https://api.telegram.org/bot<token>/logOut", "updater:switch_telegram_bot_api"]);
  assert.deepEqual(calls[0]!.params, { mode: "local", api_id: API_ID, api_hash: API_HASH });
  // Сборка образа и подъём трёх сервисов не укладываются в обычные 35 секунд.
  assert.ok((calls[0]!.timeoutMs ?? 0) >= 5 * 60_000);
});

test("без ответа облака переезд не начинается", async () => {
  const { service, calls } = harness({
    fetcher: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
  });
  await assert.rejects(() => service.switchMode("local"), /не ответил на выход бота/);
  assert.equal(calls.length, 0, "переезд начат без выхода из облака");
});

test("отказ облака в logOut — бот уже вышел — переезду не мешает, токена в журнале нет", async () => {
  const { service, calls, warnings } = harness({
    fetcher: (async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })) as typeof fetch,
  });
  await service.switchMode("local");
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes(TOKEN));
});

test("на своём сервере повторное включение применяет ключи без выхода из облака", async () => {
  const { service, events } = harness({ baseUrl: "http://telegram-bot-api:8081" });
  await service.switchMode("local");
  assert.deepEqual(events, ["updater:switch_telegram_bot_api"]);
});

test("без ключей или токена переезд не начинается и из облака бот не выходит", async () => {
  for (const missing of [{ apiId: null }, { apiHash: null }, { token: null }]) {
    const { service, events } = harness(missing);
    await assert.rejects(() => service.switchMode("local"), /API ID|Токен бота/);
    assert.deepEqual(events, [], `начато без ${Object.keys(missing)[0]}`);
  }
});

test("возврат в облако не трогает ни ключи, ни токен", async () => {
  const { service, events, calls } = harness({ baseUrl: "http://telegram-bot-api:8081" });
  await service.switchMode("cloud");
  assert.deepEqual(events, ["updater:switch_telegram_bot_api"]);
  assert.deepEqual(calls[0]!.params, { mode: "cloud" });
});

test("отказ скрипта доходит до панели без значений ключей", async () => {
  // Значения попадают в редактор, когда их открывает Secret Store;
  // поддельное хранилище этого не делает, поэтому — вручную.
  const store = new SecretStore({ masterKey: Buffer.alloc(32, 1), pool: {} as never });
  store.open(store.seal(API_HASH));
  const { service } = harness({
    baseUrl: "http://telegram-bot-api:8081",
    updaterError: new Error(`Command failed: TELEGRAM_API_HASH=${API_HASH} compose up`),
  });
  await assert.rejects(
    () => service.switchMode("local"),
    (error: Error) => /Переключение не завершено/.test(error.message) && !error.message.includes(API_HASH),
  );
});

test("неизвестный режим отвергается до любых действий", async () => {
  const { service, events } = harness();
  await assert.rejects(() => service.switchMode("both"), /local или cloud/);
  assert.deepEqual(events, []);
});

test(".env меняется только в разрешённых ключах, остальные строки не трогаются", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "evaself-env-"));
  const file = path.join(dir, ".env");
  await writeFile(file, "DOMAIN=eva.test\nTELEGRAM_API_ID=1\n# комментарий\n");
  const result = await setEnvValues(file, { TELEGRAM_API_ID: API_ID, TELEGRAM_API_HASH: API_HASH });
  assert.deepEqual(result.replaced, ["TELEGRAM_API_ID"]);
  assert.equal(
    await readFile(file, "utf8"),
    `DOMAIN=eva.test\nTELEGRAM_API_ID=${API_ID}\n# комментарий\nTELEGRAM_API_HASH=${API_HASH}\n`,
  );
  await assert.rejects(() => setEnvValues(file, { DOMAIN: "evil.test" }), /панелью не меняется/);
  await assert.rejects(() => setEnvValues(file, { TELEGRAM_API_ID: "1\nDOMAIN=evil" }), /перевод строки/);
});

test("сервис операций сам проверяет ключи перед записью в .env", () => {
  assert.deepEqual(telegramApiCredentials({ api_id: API_ID, api_hash: API_HASH }), { apiId: API_ID, apiHash: API_HASH });
  assert.throws(() => telegramApiCredentials({ api_id: "12a", api_hash: API_HASH }), /API ID/);
  assert.throws(() => telegramApiCredentials({ api_id: API_ID, api_hash: "short" }), /API Hash/);
});

test("API Hash не попадает в журнал аудита", () => {
  const params = auditParams("/api/admin/v1/integrations/telegram/config", { api_id: API_ID, api_hash: API_HASH }, {});
  assert.ok(!JSON.stringify(params).includes(API_HASH));
  assert.equal((params.body as Record<string, unknown>).api_id, API_ID);
});

test("форма Telegram принимает ключи в правильном виде и отвергает опечатку до записи", async () => {
  const written: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("INSERT INTO system_settings")) written.push(`${values[0]}=${values[1]}`);
    if (sql.includes("INSERT INTO secret_records")) {
      written.push(String(values[0]));
      return {
        rows: [{ secret_ref: values[0], created_at: new Date(), last_rotated_at: new Date(), used_by_json: [] }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  const service = new IntegrationConfigService(pool as never, new SecretStore({ masterKey: Buffer.alloc(32, 3), pool: pool as never }));

  await assert.rejects(() => service.put("telegram", { api_id: "12 34" }, "admin"), /API ID: неверный формат/);
  await assert.rejects(() => service.put("telegram", { api_hash: "not-a-hash" }, "admin"), /API Hash: неверный формат/);
  assert.deepEqual(written, [], "опечатка дошла до записи");

  const saved = await service.put("telegram", { api_id: API_ID, api_hash: API_HASH }, "admin");
  assert.deepEqual(written, [`bootstrap.env.telegram.api.id=${API_ID}`, "sec_telegram_api_hash"]);
  const hash = saved.fields.find((field) => field.name === "api_hash");
  assert.equal(hash?.value, null, "значение секрета вернулось в ответе");
  assert.equal(hash?.required, false, "без своего сервера Bot API ключ не нужен");
});

test("свой сервер Bot API — необязательная цель сервиса операций", () => {
  assert.equal(containerNameOf("telegram-bot-api"), "evaself-telegram-bot-api");
  assert.equal(SERVICE_BY_ID.get("telegram-bot-api")?.optional, true);
});
