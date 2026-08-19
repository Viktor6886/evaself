import assert from "node:assert/strict";
import test from "node:test";

import { CoreToolFactory } from "../dist/tools/core-tools.js";
import { toolRisk } from "../dist/agent-tools.js";
import { approvalRequiredFor } from "../dist/tools/approvals.js";
import { runInTurn } from "../dist/turns/turn-context.js";
import { reactionStats } from "../dist/metrics.js";
import { renderTelegramText, TelegramClient } from "../dist/telegram.js";
import { formatEvaReply } from "../dist/telegram-format.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({ name, label, description, parameters, execute });

function reactionTools(options: { fail?: boolean } = {}) {
  const reactions: Array<{ chatId: number; messageId: number; emoji: string }> = [];
  const db = {
    // Свежайшее сообщение человека — уже следующего хода: пока Ева
    // отвечала, он успел написать ещё раз.
    query: async () => ({ rows: [{ message_id: "999" }] }),
  };
  const telegram = {
    setReaction: async (chatId: number, messageId: number, emoji: string) => {
      if (options.fail) throw new Error("Telegram отказал");
      reactions.push({ chatId, messageId, emoji });
    },
  };
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never,
    db as never,
    telegram as never,
    { search: async () => ({ hits: [], degraded: false }) } as never,
  );
  const tools = new Map(factory.build(tool as never).map((entry) => [entry.name, entry]));
  return { reactions, reaction: tools.get("set_reaction")! };
}

const RUNTIME = {
  userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-1",
  purpose: "chat" as const, timezone: "UTC", responseMode: "text" as const, useEmoji: true,
};

/**
 * Реакция принадлежит своему ходу.
 *
 * Пока поле ввода блокировалось черновиком, «последнее сообщение
 * человека» и «сообщение этого хода» совпадали. Теперь человек пишет во
 * время ответа, и выборка из базы ставит реакцию на чужой ход.
 */
test("реакция ставится на сообщение своего хода, а не на пришедшее следом", async () => {
  const { reactions, reaction } = reactionTools();

  await runInTurn(
    { runId: "run-1", recorded: true, isCancelled: async () => false, chatId: 42, messageId: 17 },
    async () => await reaction.execute({ emoji: "🔥" }, RUNTIME as never),
  );

  assert.deepEqual(reactions, [{ chatId: 42, messageId: 17, emoji: "🔥" }]);
});

test("реакция без хода не угадывает сообщение", async () => {
  const { reactions, reaction } = reactionTools();
  await assert.rejects(
    () => reaction.execute({ emoji: "🔥" }, RUNTIME as never),
    /Нет сообщения этого хода/,
  );
  assert.deepEqual(reactions, []);
});

test("реакция не требует подтверждения человека", () => {
  // Обратимое действие в том же чате: пока оно числилось внешним
  // последствием, каждая поддержка эмодзи упиралась в approval.
  assert.equal(toolRisk("set_reaction"), "low_risk_write");
  assert.equal(approvalRequiredFor(toolRisk("set_reaction")), false);
  // Для сравнения: удаление подтверждения по-прежнему требует.
  assert.equal(approvalRequiredFor(toolRisk("delete_notes")), true);
});

test("реакции считаются метрикой, а текст сообщений — нет", async () => {
  const before = reactionStats();
  const { reaction } = reactionTools();
  await runInTurn(
    { runId: "run-2", recorded: true, isCancelled: async () => false, chatId: 42, messageId: 21 },
    async () => await reaction.execute({ emoji: "👍" }, RUNTIME as never),
  );
  const after = reactionStats();
  assert.equal(after.attempted, before.attempted + 1);
  assert.equal(after.succeeded, before.succeeded + 1);

  const failing = reactionTools({ fail: true });
  await runInTurn(
    { runId: "run-3", recorded: true, isCancelled: async () => false, chatId: 42, messageId: 22 },
    async () => await assert.rejects(() => failing.reaction.execute({ emoji: "👍" }, RUNTIME as never)),
  );
  assert.equal(reactionStats().failed, after.failed + 1);
  assert.doesNotMatch(JSON.stringify(reactionStats()), /[а-яё]/i);
});

/**
 * Живая правка и итоговая отправка обязаны рисовать одно и то же.
 *
 * Оформление у Евы содержательное: цитата — это вывод, спойлер —
 * необязательная деталь. Если поток и доставка рисуют текст по-разному,
 * ответ на глазах меняет смысл.
 */
test("цитата, спойлер и жирный выглядят одинаково в потоке и в доставке", async () => {
  const answer = [
    "**Главное:** договор продлён.",
    "",
    "> Продление до марта подтверждено.",
    "",
    ">> Подробности: стороны согласовали ту же ставку, пересмотр в апреле.",
    "",
    "||Мелочь: копия ушла на почту.||",
  ].join("\n");

  const live = renderTelegramText(answer);
  assert.equal(live.parse_mode, "HTML");
  assert.equal(live.text, formatEvaReply(answer));
  assert.match(String(live.text), /<blockquote>/);
  assert.match(String(live.text), /<blockquote expandable>/);
  assert.match(String(live.text), /<tg-spoiler>/);
  assert.match(String(live.text), /<b>/);

  const calls: Array<Record<string, unknown>> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "t", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (_method, body) => { calls.push(body); return { message_id: 1 } as never; };
  await telegram.sendMessage(42, answer);

  assert.equal(calls.length, 1, "ответ разошёлся на несколько сообщений");
  assert.equal(calls[0]?.parse_mode, "HTML");
  assert.equal(calls[0]?.text, live.text, "поток и доставка рисуют по-разному");
});

/**
 * Инструмент, вызванный вне асинхронного контекста хода.
 *
 * Так это и происходит в production: инструменты регистрируются при
 * ОТКРЫТИИ сессии, а вызывает их SDK позже — из обработчика сокета, куда
 * AsyncLocalStorage не дотягивается. Ева отвечала «нет сообщения этого
 * хода для реакции» на любую просьбу поставить реакцию, хотя сообщение
 * было.
 */
test("реакция находит свой ход, даже когда контекст не доехал до инструмента", async () => {
  const { openTurnScope, closeTurnScope } = await import("../dist/turns/turn-context.js");
  const reactions: Array<{ chatId: number; messageId: number; emoji: string }> = [];
  const telegram = {
    setReaction: async (chatId: number, messageId: number, emoji: string) => {
      reactions.push({ chatId, messageId, emoji });
    },
  };
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never,
    { withUserScope: async <T>(_s: unknown, w: () => Promise<T>) => await w() } as never,
    telegram as never,
  );
  const tools = new Map(factory.build(tool as never).map((entry) => [entry.name, entry]));
  const runtime = {
    userId: 1, telegramId: 42, chatId: 42, conversationId: "conv-1",
    purpose: "chat", useEmoji: true,
  };

  const turn = {
    runId: "r1", recorded: true, isCancelled: async () => false,
    chatId: 42, messageId: 555,
  };
  openTurnScope("conv-1", turn as never);
  try {
    // Ни одного `runInTurn` вокруг: ровно как у SDK.
    const result = await tools.get("set_reaction")!.execute(
      { emoji: "👍" }, runtime as never,
    ) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.deepEqual(reactions, [{ chatId: 42, messageId: 555, emoji: "👍" }]);
  } finally {
    closeTurnScope("conv-1");
  }

  // Ход закончился — адрес снят, и следующий вызов уже не найдёт чужое
  // сообщение.
  await assert.rejects(
    () => tools.get("set_reaction")!.execute({ emoji: "👍" }, runtime as never),
    /сообщения этого хода/i,
  );
  assert.equal(reactions.length, 1);
});

test("ход одного разговора не виден инструменту другого", async () => {
  const { openTurnScope, closeTurnScope } = await import("../dist/turns/turn-context.js");
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never,
    { withUserScope: async <T>(_s: unknown, w: () => Promise<T>) => await w() } as never,
    { setReaction: async () => {} } as never,
  );
  const tools = new Map(factory.build(tool as never).map((entry) => [entry.name, entry]));
  openTurnScope("conv-A", {
    runId: "r1", recorded: true, isCancelled: async () => false, chatId: 1, messageId: 10,
  } as never);
  try {
    await assert.rejects(
      () => tools.get("set_reaction")!.execute({ emoji: "👍" }, {
        userId: 2, telegramId: 2, chatId: 2, conversationId: "conv-B",
        purpose: "chat", useEmoji: true,
      } as never),
      /сообщения этого хода/i,
    );
  } finally {
    closeTurnScope("conv-A");
  }
});
