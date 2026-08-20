/**
 * Кнопки выбора: оформление ответа, а не отдельное сообщение.
 *
 * Сторожится главное: `callback_data` непрозрачна и не несёт ни команды,
 * ни идентификаторов; кнопка принадлежит своему человеку; повторный клик
 * не заводит второй ход; выбор возвращается в разговор значением из
 * серверной записи, а не строкой из Telegram.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_DATA_LIMIT,
  InlineChoiceError,
  MAX_CHOICES,
  inlineKeyboard,
  newCallbackToken,
  normalizeChoices,
} from "../dist/telegram/inline-choices.js";
import { CoreToolFactory } from "../dist/tools/core-tools.js";
import { runInTurn } from "../dist/turns/turn-context.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({
  name, label, description, parameters,
  execute: async (_callId: string, args: Record<string, unknown>, runtime: unknown) =>
    ({ details: await execute(args, runtime) }),
});

function factory() {
  return new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: "/nonexistent" } as never,
    { withUserScope: async <T>(_s: unknown, w: () => Promise<T>) => await w() } as never,
    {} as never,
  );
}

test("варианты проверяются до того, как станут клавиатурой", () => {
  assert.throws(() => normalizeChoices([]), InlineChoiceError);
  assert.throws(() => normalizeChoices(Array.from({ length: MAX_CHOICES + 1 }, (_, i) => ({ label: `в${i}` }))), InlineChoiceError);
  assert.throws(() => normalizeChoices([{ label: "  " }]), InlineChoiceError);
  assert.throws(() => normalizeChoices([{ label: "а".repeat(65) }]), InlineChoiceError);
  // Два одинаковых значения неразличимы в ответе — это ошибка, а не выбор.
  assert.throws(() => normalizeChoices([{ label: "Да" }, { label: "Да" }]), InlineChoiceError);

  const choices = normalizeChoices([{ label: "Поговорить" }, { label: "Позже", value: "later" }]);
  assert.deepEqual(choices, [
    { label: "Поговорить", value: "Поговорить" },
    { label: "Позже", value: "later" },
  ]);
});

test("токен непрозрачен, помещается в callback_data и не повторяется", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => newCallbackToken()));
  assert.equal(tokens.size, 200, "токены обязаны различаться");
  for (const token of tokens) {
    assert.ok(Buffer.byteLength(token, "utf8") <= CALLBACK_DATA_LIMIT);
    // Ни команды, ни идентификатора, ни текста: только случайность.
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  }

  const keyboard = inlineKeyboard([{ label: "Да", token: "tok-1" }, { label: "Нет", token: "tok-2" }]);
  assert.deepEqual(keyboard, {
    inline_keyboard: [[
      { text: "Да", callback_data: "tok-1" },
      { text: "Нет", callback_data: "tok-2" },
    ]],
  });

  const readable = inlineKeyboard([
    { label: "Отношения", token: "a" },
    { label: "Работа", token: "b" },
    { label: "Очень длинное направление разговора", token: "c" },
  ]);
  assert.deepEqual(readable.inline_keyboard, [
    [{ text: "Отношения", callback_data: "a" }, { text: "Работа", callback_data: "b" }],
    [{ text: "Очень длинное направление разговора", callback_data: "c" }],
  ]);
});

test("инструмент оставляет намерение в ходе и ничего не отправляет сам", async () => {
  const tools = new Map(factory().build(tool as never).map((entry) => [entry.name, entry]));
  assert.ok(tools.has("present_inline_choices"));

  const turn = {
    runId: "r1", recorded: true, isCancelled: async () => false,
    chatId: 42, messageId: 7,
  } as never;
  const runtime = { userId: 1, telegramId: 42, chatId: 42, conversationId: "c", purpose: "chat" };

  const result = await runInTurn(turn, async () =>
    await tools.get("present_inline_choices")!.execute(
      "call-1", { choices: [{ label: "Да" }, { label: "Нет" }] }, runtime as never,
    ));
  const details = result.details as { ok: boolean; attached_to: string };
  assert.equal(details.ok, true);
  assert.equal(details.attached_to, "final_message", "кнопки ждут финального сообщения");
  assert.deepEqual(
    (turn as { ui?: { inlineChoices?: { choices: unknown[]; oneShot: boolean } } }).ui?.inlineChoices,
    { choices: [{ label: "Да", value: "Да" }, { label: "Нет", value: "Нет" }], oneShot: true },
  );
});

test("вне хода кнопки не к чему приклеить, и инструмент это говорит", async () => {
  const tools = new Map(factory().build(tool as never).map((entry) => [entry.name, entry]));
  const runtime = { userId: 1, telegramId: 42, chatId: 42, conversationId: "c", purpose: "chat" };
  const result = await tools.get("present_inline_choices")!.execute(
    "call-1", { choices: [{ label: "Да" }] }, runtime as never,
  );
  assert.deepEqual(result.details, { ok: false, reason: "no_active_turn" });
});

test("негодные варианты возвращаются ошибкой, а не молча теряются", async () => {
  const tools = new Map(factory().build(tool as never).map((entry) => [entry.name, entry]));
  const turn = { runId: "r1", recorded: true, isCancelled: async () => false } as never;
  const runtime = { userId: 1, telegramId: 42, chatId: 42, conversationId: "c", purpose: "chat" };
  const result = await runInTurn(turn, async () =>
    await tools.get("present_inline_choices")!.execute("call-1", { choices: [] }, runtime as never));
  const details = result.details as { ok: boolean; reason: string };
  assert.equal(details.ok, false);
  assert.equal(details.reason, "choices_empty");
  assert.equal((turn as { ui?: unknown }).ui, undefined, "негодное намерение не сохраняется");
});
