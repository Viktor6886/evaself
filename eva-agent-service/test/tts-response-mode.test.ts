/**
 * Синтез речи и формат ответа.
 *
 * Проверяется то, что легко разъезжается между слоями: набор голосов и
 * полей формы в панели, значения формата ответа в публичном API и
 * колонке `user_preferences`, и правило «формат решает backend, а не
 * клиент».
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GEMINI_TTS_VOICES,
  TTS_DEFAULT_MODEL,
  TTS_PROVIDER_PRESETS,
  TTS_RESPONSE_FORMATS,
} from "../dist/admin/integration-config-service.js";
import { PublicRepository } from "../dist/public/routes.js";

test("форма синтеза предлагает OpenRouter, модель Gemini и её голоса", async () => {
  const { IntegrationConfigService } = await import("../dist/admin/integration-config-service.js");
  const service = new IntegrationConfigService(
    { query: async () => ({ rows: [] }) } as never,
    { get: async () => null, list: async () => [] } as never,
  );
  const form = await service.get("tts");
  const field = (name: string) => (form.fields as Array<Record<string, unknown>>)
    .find((item) => item.name === name);

  const providers = (field("provider")?.options as Array<{ value: string }>).map((item) => item.value);
  assert.ok(providers.includes("openrouter"), `нет OpenRouter: ${providers.join(", ")}`);

  // Голос выбирается из списка, а не вводится вслепую: опечатка в имени
  // голоса возвращается провайдером как ошибка уже во время ответа.
  const voices = (field("voice")?.options as Array<{ value: string }>).map((item) => item.value);
  assert.deepEqual(voices, [...GEMINI_TTS_VOICES]);
  assert.equal(voices.length, 30);
  assert.ok(voices.includes("Kore") && voices.includes("Zephyr"));

  // Описание манеры речи — отдельное многострочное поле.
  assert.equal(field("voice_prompt")?.kind, "textarea");

  // Формат ответа провайдера — настройка: Gemini TTS отдаёт PCM, и
  // зашитый mp3 давал 400, в котором администратору нечего менять.
  const formats = (field("response_format")?.options as Array<{ value: string }>)
    .map((item) => item.value);
  assert.deepEqual(formats, [...TTS_RESPONSE_FORMATS]);
  assert.ok(formats.includes("wav") && formats.includes("pcm"));
  assert.equal(field("model")?.placeholder, TTS_DEFAULT_MODEL);
  assert.equal(TTS_PROVIDER_PRESETS.openrouter?.base_url, "https://openrouter.ai/api/v1");
  assert.equal(TTS_PROVIDER_PRESETS.openrouter?.model, "google/gemini-3.1-flash-tts-preview");
  // Формат проверен кругом до провайдера: на mp3 Gemini TTS отвечает
  // четырёхсотой, pcm принимает. Набор возит его вместе с адресом, иначе
  // новая установка повторит ту же настройку вслепую.
  assert.equal(TTS_PROVIDER_PRESETS.openrouter?.response_format, "pcm");
  assert.equal(TTS_PROVIDER_PRESETS.openai?.response_format, "mp3");
  const openrouter = (field("provider")?.options as Array<{ value: string; preset?: unknown }>)
    .find((item) => item.value === "openrouter");
  assert.deepEqual(openrouter?.preset, TTS_PROVIDER_PRESETS.openrouter);
});

/** Поддельная база: хранит единственную строку настроек пользователя. */
function preferencesDb(initial: string | null = null) {
  const state: { mode: string | null; writes: unknown[][] } = { mode: initial, writes: [] };
  const db = {
    state,
    withUserScope: <T>(_scope: unknown, work: () => Promise<T>) => work(),
    bindScopeUserId: () => undefined,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM users")) {
        return { rows: [{ id: 7, telegram_id: values[0], timezone: "UTC", city: null }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO user_preferences")) {
        state.mode = String(values[1]);
        state.writes.push(values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM user_preferences")) {
        return { rows: state.mode ? [{ response_mode: state.mode }] : [], rowCount: state.mode ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function repositoryFor(db: ReturnType<typeof preferencesDb>) {
  return new PublicRepository(
    db as never,
    {
      getProfile: async () => ({ confirmed: [], candidates: [], completeness: 0 }),
      upsert: async () => undefined, confirm: async () => undefined,
      decline: async () => undefined, setLanguage: async () => undefined,
    } as never,
    {} as never,
    {} as never,
  );
}

test("формат ответа сохраняется по пользователю и возвращается профилем", async () => {
  for (const mode of ["text", "voice", "both"]) {
    const db = preferencesDb();
    const repository = repositoryFor(db);
    const updated = await repository.updateProfile(100_500, { response_mode: mode });
    assert.equal(db.state.mode, mode, mode);
    assert.equal((updated.user as { response_mode: string }).response_mode, mode, mode);
    // Значение пишется владельцу хода, а не тому, кого назвал клиент.
    assert.equal(db.state.writes[0]?.[0], 7, mode);
  }
});

test("без настройки действует текстовый режим, четвёртого варианта нет", async () => {
  const repository = repositoryFor(preferencesDb());
  const profile = await repository.getProfile(100_500);
  assert.equal((profile.user as { response_mode: string }).response_mode, "text");

  await assert.rejects(
    repositoryFor(preferencesDb()).updateProfile(100_500, { response_mode: "video" }),
    /response_mode должен быть text, voice или both/,
  );
});

test("токен провайдера сохраняется вместе с остальными полями формы", async () => {
  // Регрессия: `put` записывал настройки транзакцией, а секрет отдавал
  // Secret Store без списка потребителей. Тот требует массив, поэтому
  // сохранение падало с «used_by должен быть массивом строк» уже после
  // коммита — Base URL и модель сохранялись, токен нет, и проверка
  // синтеза честно отвечала «TTS не настроен».
  const { IntegrationConfigService } = await import("../dist/admin/integration-config-service.js");
  const { SecretStore } = await import("../dist/admin/secret-store.js");

  // Без токена media-service раздача значений живому сервису не
  // начинается: тест проверяет запись, а не сеть.
  const previousToken = process.env.MEDIA_SERVICE_TOKEN;
  delete process.env.MEDIA_SERVICE_TOKEN;
  const settings = new Map<string, string>();
  const secretWrites: Array<{ ref: string; usedBy: unknown }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("INSERT INTO system_settings")) {
      settings.set(String(values[0]), String(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO secret_records")) {
      secretWrites.push({ ref: String(values[0]), usedBy: JSON.parse(String(values[5])) });
      return {
        rows: [{
          secret_ref: values[0], created_at: new Date(),
          last_rotated_at: new Date(), used_by_json: JSON.parse(String(values[5])),
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
  const secrets = new SecretStore({ masterKey: Buffer.alloc(32, 7), pool: pool as never });
  const service = new IntegrationConfigService(pool as never, secrets, "http://media-service:8090");

  const result = await service.put("tts", {
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    api_key: "test-token-value",
    model: TTS_DEFAULT_MODEL,
    voice: "Charon",
    voice_prompt: "Тёплый женский голос",
  }, "admin");

  assert.deepEqual(secretWrites, [
    { ref: "sec_media_tts_api_key", usedBy: ["media-service"] },
  ]);
  assert.equal(settings.get("bootstrap.env.media.tts.model"), TTS_DEFAULT_MODEL);
  assert.equal(settings.get("bootstrap.env.media.tts.voice"), "Charon");
  assert.equal(result.id, "tts");
  if (previousToken !== undefined) process.env.MEDIA_SERVICE_TOKEN = previousToken;
});

test("пароль при записи интеграции спрашивается по интеграции, а не по маршруту", async () => {
  // Маршрут один на все интеграции. Владелец решил не спрашивать пароль
  // при настройке речи — но тем же запросом меняются Telegram bot_token,
  // секрет SearXNG и ключ Crawl4AI, поэтому послабление ограничено
  // asr и tts.
  const { buildAdminServer } = await import("../dist/admin/server.js");
  const sudo: string[] = [];
  const saved: string[] = [];
  const app = buildAdminServer({
    auth: {
      authenticate: async () => ({
        id: "session-1",
        user: { id: "00000000-0000-0000-0000-000000000001", username: "владелец", role: "owner" },
      }),
      requireCsrf: () => undefined,
      requireSudo: async (_id: string, scope: string) => { sudo.push(scope); },
    },
    audit: {
      start: async () => ({ id: "audit-1", startedAt: Date.now() }),
      finish: async () => undefined,
      annotate: async () => undefined,
      list: async () => [],
    },
    integrations: {
      put: async (id: string) => { saved.push(id); return { id }; },
    },
    config: {}, secrets: {}, health: {}, operations: {}, providers: {},
    llmRouter: {}, stt: {}, users: {}, crud: {}, artifacts: {},
    events: { publish: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    readiness: async () => true,
  } as never);
  await app.ready();

  const put = (id: string) => app.inject({
    method: "PUT",
    url: `/api/admin/v1/integrations/${id}/config`,
    headers: { cookie: "eva_admin=session-1", "x-csrf-token": "t" },
    payload: { base_url: "https://openrouter.ai/api/v1" },
  });

  for (const id of ["tts", "asr"]) {
    assert.equal((await put(id)).statusCode, 200, id);
  }
  assert.deepEqual(sudo, [], "речь не должна требовать пароль");

  for (const id of ["telegram", "searxng", "crawl4ai"]) {
    assert.equal((await put(id)).statusCode, 200, id);
  }
  assert.deepEqual(sudo, ["secrets:write", "secrets:write", "secrets:write"]);
  assert.deepEqual(saved, ["tts", "asr", "telegram", "searxng", "crawl4ai"]);
  await app.close();
});

test("ответ провайдера доходит до администратора, а не теряется по дороге", async () => {
  // Регрессия: media-service кладёт объяснение провайдера в
  // `error.details`, а панель показывала только `message` — «провайдер
  // вернул 400», по которому нечего менять.
  const { IntegrationConfigService } = await import("../dist/admin/integration-config-service.js");
  const previousToken = process.env.MEDIA_SERVICE_TOKEN;
  process.env.MEDIA_SERVICE_TOKEN = "media-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      error: {
        code: "tts_error",
        message: "провайдер вернул 400",
        details: '{"error":{"message":"unsupported response_format"}}',
      },
    }),
    { status: 502, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  try {
    const service = new IntegrationConfigService(
      { query: async () => ({ rows: [] }) } as never,
      { get: async () => null } as never,
      "http://media-service:8090",
    );
    const result = await service.test("tts");
    assert.equal(result.ok, false);
    assert.match(String(result.message), /провайдер вернул 400/);
    assert.match(String(result.message), /unsupported response_format/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.MEDIA_SERVICE_TOKEN;
    else process.env.MEDIA_SERVICE_TOKEN = previousToken;
  }
});
