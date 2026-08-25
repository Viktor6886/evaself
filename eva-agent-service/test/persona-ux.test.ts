import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CoreToolFactory } from "../dist/tools/core-tools.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({ name, label, description, parameters, execute });

function descriptions(): Map<string, string> {
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: "/nonexistent" } as never,
    { withUserScope: async <T>(_s: unknown, work: () => Promise<T>) => await work() } as never,
    {} as never,
  );
  return new Map(factory.build(tool as never).map((item) => [item.name, item.description]));
}

test("persona file is structurally valid editable UTF-8 content", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("persona is outside the service-only Docker build context");
    return;
  }
  assert.ok(persona.trim().length > 0);
  assert.ok(Buffer.byteLength(persona, "utf8") <= 1_000_000);
});

test("typed tool descriptions make reaction and buttons the active default when appropriate", () => {
  const tools = descriptions();
  assert.match(tools.get("set_reaction") ?? "", /по умолчанию рассмотри/i);
  assert.match(tools.get("set_reaction") ?? "", /горе или кризис/i);
  assert.match(tools.get("present_inline_choices") ?? "", /2–6 вариантов/);
  assert.match(tools.get("present_inline_choices") ?? "", /Открытый вопрос/i);
});

/**
 * Ева — она.
 *
 * Мужской род о себе — жалоба, которая повторяется: «понял», «сделал»,
 * «принял» проскакивают в коротких служебных репликах, где модель не
 * следит за собой. Одной строки в персоне для этого мало, поэтому правило
 * стоит среди абсолютных — там, где приоритет объявлен выше памяти,
 * стиля собеседника и примеров из recall.
 *
 * Тест сторожит не формулировку, а наличие правила и его абсолютность.
 */
test("женский род о себе закреплён как абсолютное правило", async (t) => {
  let systemPrompt: string;
  let persona: string;
  try {
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
    persona = await readFile(
      new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  const absolute = systemPrompt.slice(
    systemPrompt.indexOf("# Абсолютные правила ответа"),
    systemPrompt.indexOf("# Архитектура контекста"),
  );
  assert.ok(absolute.length > 0, "раздел абсолютных правил не найден");
  assert.match(absolute, /женском роде/i, "правила рода нет среди абсолютных");
  // Именно те формы, на которых Ева и сбивалась.
  for (const wrong of ["понял", "сделал", "готов", "рад"]) {
    assert.ok(
      absolute.includes(wrong),
      `правило не называет ошибочную форму «${wrong}» — общего указания мало`,
    );
  }
  // Прошлая ошибка в памяти не должна читаться как разрешение.
  assert.match(absolute, /прошлая ошибка|не повторяй/i);

  assert.match(persona, /женском роде/i, "персона не называет род");
});

test("тон Евы задан тёплым, а тепло не подменяет честность", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("персона вне образа сервиса; проверяется на репозитории");
    return;
  }
  assert.match(persona, /тёплая, добрая/i);
  assert.match(persona, /Emoji/);
  // Доброта, съевшая прямоту, — это не доброта, а поддакивание.
  assert.match(persona, /Поддержка ≠ согласие/);
  assert.match(persona, /не превращай доброту в\s+поддакивание/i);
});
