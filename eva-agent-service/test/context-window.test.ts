import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_RESERVE_TOKENS,
  MIN_CONTEXT_WINDOW,
  safeContextWindow,
} from "../dist/letta/context-window.js";

test("предел берётся по самой слабой модели цепочки, а не по активной", () => {
  // Аварийный резерв обязан принять тот же разговор, иначе он не резерв.
  const limit = safeContextWindow([
    { context_window: 256_000, max_output_tokens: 8_000 },
    { context_window: 128_000, max_output_tokens: 4_000 },
  ]);
  assert.equal(limit, 128_000 - 8_000 - CONTEXT_RESERVE_TOKENS);
});

test("из предела вычитается всё, что приходит в ход помимо истории", () => {
  // Системный промпт, персона и описания инструментов — около ста
  // килобайт постоянного префикса в каждом обращении к модели.
  const limit = safeContextWindow([{ context_window: 200_000, max_output_tokens: 10_000 }])!;
  assert.ok(limit < 200_000 - 10_000, "запас обязан быть учтён");
  assert.equal(limit, 200_000 - 10_000 - CONTEXT_RESERVE_TOKENS);
});

test("боевой случай: 256к перестаёт превращаться в 770к", () => {
  // Ровно та модель, на которой диалог человека умер: предел есть, и он
  // заметно меньше окна — значит Letta сожмёт историю задолго до отказа.
  const limit = safeContextWindow([{ context_window: 256_000, max_output_tokens: 4_096 }])!;
  assert.ok(limit > 0 && limit < 256_000);
  assert.ok(limit >= MIN_CONTEXT_WINDOW);
});

test("у маленькой модели предел — доля окна, а не отрицательное число", () => {
  // Вычет съедает окно целиком, но предел всё равно нужен: без него
  // Letta не сожмёт историю вовсе.
  const limit = safeContextWindow([{ context_window: 32_000, max_output_tokens: 4_000 }])!;
  assert.ok(limit >= MIN_CONTEXT_WINDOW, `предел ${limit} слишком мал`);
  assert.ok(limit < 32_000);
});

test("слишком маленькая модель предела не получает: это не лечится числом", () => {
  assert.equal(safeContextWindow([{ context_window: 8_000, max_output_tokens: 4_000 }]), null);
});

test("без включённых провайдеров число не выдумывается", () => {
  assert.equal(safeContextWindow([]), null);
  assert.equal(safeContextWindow([{ context_window: 0, max_output_tokens: 0 }]), null);
});
