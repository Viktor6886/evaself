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
