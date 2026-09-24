/**
 * Пресеты системных настроек.
 *
 * Профиль подставляет сразу несколько значений, и ошибка в любом из них
 * всплыла бы только в момент сохранения — уже после того, как
 * администратор выбрал набор и нажал «Сохранить». Поэтому набор
 * проверяется тем же кодом, что и ручной ввод.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SETTING_BY_KEY,
  SETTING_PROFILES,
  SETTINGS_REGISTRY,
} from "../dist/admin/settings-registry.js";

/** Те же правила, что в ConfigService.validate. */
function assertValid(key: string, value: unknown) {
  const definition = SETTING_BY_KEY.get(key);
  assert.ok(definition, `настройки ${key} нет в реестре`);
  if (definition.type === "boolean") {
    assert.equal(typeof value, "boolean", `${key}: ожидается boolean`);
    return;
  }
  if (definition.type === "integer") {
    assert.ok(Number.isSafeInteger(value), `${key}: ожидается целое`);
    if (definition.min !== undefined) {
      assert.ok((value as number) >= definition.min, `${key}: ниже минимума ${definition.min}`);
    }
    if (definition.max !== undefined) {
      assert.ok((value as number) <= definition.max, `${key}: выше максимума ${definition.max}`);
    }
    return;
  }
  assert.equal(typeof value, "string", `${key}: ожидается строка`);
  assert.ok(String(value).trim().length > 0, `${key}: пустая строка`);
}

test("каждое значение любого профиля проходит серверную проверку", () => {
  assert.ok(SETTING_PROFILES.length >= 2, "профилей должно быть больше одного");
  for (const profile of SETTING_PROFILES) {
    for (const [key, value] of Object.entries(profile.values)) {
      assertValid(key, value);
    }
  }
});

test("профили трогают один и тот же набор ключей", () => {
  // Иначе переключение между профилями оставляло бы хвосты от прежнего:
  // выбрал «экономный», потом «отзывчивый» — и часть значений осталась
  // от первого, потому что во втором её просто нет.
  const sets = SETTING_PROFILES.map((profile) => Object.keys(profile.values).sort().join(","));
  assert.equal(new Set(sets).size, 1, "наборы ключей у профилей различаются");
});

test("значения пресетов у поля тоже валидны и не повторяются", () => {
  for (const definition of SETTINGS_REGISTRY) {
    if (!definition.presets) continue;
    const seen = new Set<string>();
    for (const preset of definition.presets) {
      assertValid(definition.key, preset.value);
      const token = JSON.stringify(preset.value);
      assert.ok(!seen.has(token), `${definition.key}: значение ${token} повторяется`);
      seen.add(token);
      assert.ok(preset.title.trim().length > 0, `${definition.key}: пресет без названия`);
    }
  }
});

test("у каждой настройки есть рекомендация", () => {
  const without = SETTINGS_REGISTRY.filter((item) => !item.recommended?.trim());
  assert.deepEqual(without.map((item) => item.key), [],
    "настройка без подписи с рекомендуемым значением");
});

test("основных настроек заметно меньше, чем всего", () => {
  // Смысл 2.7 — сократить видимое до важного; если «продвинутых» нет,
  // список снова длинный.
  const advanced = SETTINGS_REGISTRY.filter((item) => item.advanced);
  assert.ok(advanced.length > 0, "ни одна настройка не спрятана в продвинутые");
  assert.ok(
    SETTINGS_REGISTRY.length - advanced.length <= 8,
    "основных настроек больше восьми — экран снова перегружен",
  );
});

test("профиль по умолчанию совпадает с default реестра", () => {
  // «Сбалансированный» описан как «значения по умолчанию» — если это
  // разойдётся с реестром, подпись станет враньём.
  const balanced = SETTING_PROFILES.find((item) => item.code === "balanced");
  assert.ok(balanced);
  for (const [key, value] of Object.entries(balanced.values)) {
    assert.deepEqual(value, SETTING_BY_KEY.get(key)?.default, `${key} расходится с default`);
  }
});

test("разбор аудиофайлов включается из панели без перезапуска", async () => {
  // Переключатель, который сохраняется, но ни на что не влияет, хуже
  // отсутствующего: администратор видит «включено», а Ева работает
  // по-старому. Параметр без пометки «нужен перезапуск» обязан доезжать
  // до конфига через applyManagedRuntimeConfig.
  const { applyManagedRuntimeConfig } = await import("../dist/admin/managed-runtime-config.js");
  const definition = SETTING_BY_KEY.get("runtime.audio_file_transcripts");
  assert.ok(definition, "переключателя нет в реестре панели");
  assert.equal(definition.env, "EVA_AUDIO_FILE_TRANSCRIPTS");
  assert.equal(definition.type, "boolean");
  assert.equal(definition.default, false, "флаг в production включает человек");
  assert.equal(definition.requires_restart, false);
  assert.ok(!definition.advanced, "переключатель спрятан в «остальные настройки»");

  const apply = async (value: unknown, start: boolean) => {
    const config = { audioFileTranscriptsEnabled: start };
    const changed = await applyManagedRuntimeConfig(config as never, {
      query: async () => ({ rows: [{ key: "runtime.audio_file_transcripts", value_json: value }] }),
    } as never);
    return { config, changed };
  };
  const on = await apply(true, false);
  assert.equal(on.config.audioFileTranscriptsEnabled, true);
  assert.deepEqual(on.changed, ["runtime.audio_file_transcripts"]);
  assert.equal((await apply(false, true)).config.audioFileTranscriptsEnabled, false);
  // Мусор в строке настройки не переключает флаг.
  assert.equal((await apply("yes", false)).config.audioFileTranscriptsEnabled, false);

  // Откат первого сохранения удаляет строку: флаг возвращается к
  // значению старта, а не застревает включённым до перезапуска.
  for (const bootstrap of [false, true]) {
    const config = { audioFileTranscriptsEnabled: bootstrap };
    let rows: Array<{ key: string; value_json: unknown }> = [];
    const db = { query: async () => ({ rows }) } as never;
    await applyManagedRuntimeConfig(config as never, db);
    assert.equal(config.audioFileTranscriptsEnabled, bootstrap, "старт без строки меняет флаг");
    rows = [{ key: "runtime.audio_file_transcripts", value_json: !bootstrap }];
    await applyManagedRuntimeConfig(config as never, db);
    assert.equal(config.audioFileTranscriptsEnabled, !bootstrap);
    rows = [];
    const changed = await applyManagedRuntimeConfig(config as never, db);
    assert.equal(config.audioFileTranscriptsEnabled, bootstrap, "флаг застрял после удаления строки");
    assert.deepEqual(changed, []);
  }
});

test("версия настроек принимается и в слабой форме, которую даёт прокси", async () => {
  // Caddy при сжатии ответа ослабляет ETag: `"cfg-12"` → `W/"cfg-12"`.
  // Панель возвращает его в If-Match как получила, и сохранение любой
  // настройки падало с «Некорректный If-Match».
  const { parseEtag } = await import("../dist/admin/config-service.js");
  assert.equal(parseEtag('"cfg-12"'), 12);
  assert.equal(parseEtag('W/"cfg-12"'), 12);
  assert.equal(parseEtag(" W/\"cfg-7\" "), 7);
  assert.equal(parseEtag("cfg-3"), 3);
  for (const bad of ['W/"other-1"', '"cfg-"', "W/cfg-x", '"cfg-1", "cfg-2"']) {
    assert.throws(() => parseEtag(bad), /Некорректный If-Match/, bad);
  }
  assert.throws(() => parseEtag(undefined));
});

test("режим и темп печати переключаются из панели без перезапуска", async () => {
  const { applyManagedRuntimeConfig } = await import("../dist/admin/managed-runtime-config.js");
  const mode = SETTING_BY_KEY.get("runtime.telegram_stream_mode");
  const speed = SETTING_BY_KEY.get("runtime.telegram_typing_speed");
  assert.ok(mode && speed, "переключателей нет в реестре панели");
  // Режим — в основном списке: его ищут на странице, а не под «остальными».
  assert.ok(!mode.advanced);
  assert.equal(mode.default, "edit", "по умолчанию — прежний показ");
  assert.equal(speed.default, "calm");
  assert.equal(mode.requires_restart, false);
  assert.equal(speed.requires_restart, false);
  assert.deepEqual(mode.presets?.map((preset) => preset.value), ["edit", "draft"]);
  assert.deepEqual(speed.presets?.map((preset) => preset.value), ["slow", "calm", "fast"]);

  const config = { telegramStreamMode: "edit", telegramTypingSpeed: "calm" };
  await applyManagedRuntimeConfig(config as never, {
    query: async () => ({ rows: [
      { key: "runtime.telegram_stream_mode", value_json: "draft" },
      { key: "runtime.telegram_typing_speed", value_json: "slow" },
    ] }),
  } as never);
  assert.equal(config.telegramStreamMode, "draft");
  assert.equal(config.telegramTypingSpeed, "slow");
  // Неизвестное значение не переключает режим.
  await applyManagedRuntimeConfig(config as never, {
    query: async () => ({ rows: [{ key: "runtime.telegram_stream_mode", value_json: "stream" }] }),
  } as never);
  assert.equal(config.telegramStreamMode, "draft");
  // Откат удаляет строку: темп и режим возвращаются к значениям старта,
  // а не держат выбранное до перезапуска.
  assert.equal(config.telegramTypingSpeed, "calm", "темп застрял после удаления строки");
  await applyManagedRuntimeConfig(config as never, { query: async () => ({ rows: [] }) } as never);
  assert.equal(config.telegramStreamMode, "edit", "режим застрял после удаления строки");
});

test("темп догоняет отставание от модели плавно и успевает к сроку хвоста", async () => {
  const { livePacedChars, LIVE_TYPING_CPS } = await import("../dist/telegram/live-pace.js");
  const calm = LIVE_TYPING_CPS.calm;
  // Без хвоста — около темпа: 25 знаков в секунду.
  assert.equal(livePacedChars({ cps: calm, elapsedMs: 1_000, backlog: 0, tailRemainingMs: null }), calm);
  // Большой хвост ускоряет показ, но без скачка до «всё сразу».
  const catching = livePacedChars({ cps: calm, elapsedMs: 600, backlog: 600, tailRemainingMs: null });
  assert.ok(catching > calm * 0.6 && catching < 600, String(catching));
  // Модель закончила: хвост успевает к сроку.
  const tail = livePacedChars({ cps: calm, elapsedMs: 1_000, backlog: 800, tailRemainingMs: 2_000 });
  assert.ok(tail >= 400, String(tail));
  // Долгая пауза (429) не превращается в один гигантский шаг.
  assert.ok(livePacedChars({ cps: calm, elapsedMs: 60_000, backlog: 0, tailRemainingMs: null }) <= calm * 2);
});
