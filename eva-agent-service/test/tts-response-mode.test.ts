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
  assert.equal(field("model")?.placeholder, TTS_DEFAULT_MODEL);
  assert.equal(TTS_PROVIDER_PRESETS.openrouter?.base_url, "https://openrouter.ai/api/v1");
  assert.equal(TTS_PROVIDER_PRESETS.openrouter?.model, "google/gemini-3.1-flash-tts-preview");
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
