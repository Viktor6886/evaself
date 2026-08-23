import assert from "node:assert/strict";
import test from "node:test";

import { CoreToolFactory } from "../dist/tools/core-tools.js";
import { toolRisk } from "../dist/agent-tools.js";
import { approvalRequiredFor } from "../dist/tools/approvals.js";
import { runInTurn } from "../dist/turns/turn-context.js";
import { withToolTurn } from "../dist/tools/tool-kit.js";
import { reactionStats } from "../dist/metrics.js";
import { renderTelegramText, TelegramClient } from "../dist/telegram.js";
import { formatEvaReply } from "../dist/telegram-format.js";
import { normalizeUpdate, reactionTargetForTurn } from "../dist/eva-workflow.js";
import { PostgresTelegramInbox } from "../dist/delivery/inbox.js";

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
    {
      runId: "run-1", recorded: true, isCancelled: async () => false,
      chatId: 42, messageId: 17, reactionTarget: { updateId: 1, telegramUserId: 7, chatId: 42, messageId: 17 },
    },
    async () => await reaction.execute({ emoji: "🔥" }, RUNTIME as never),
  );

  assert.deepEqual(reactions, [{ chatId: 42, messageId: 17, emoji: "🔥" }]);
});

test("реакция без хода не угадывает сообщение", async () => {
  const { reactions, reaction } = reactionTools();
  assert.deepEqual(await reaction.execute({ emoji: "🔥" }, RUNTIME as never), {
    ok: false, outcome: "skipped", reason: "no_reaction_target",
  });
  assert.deepEqual(reactions, []);
});

test("synthetic ход не использует сохранённый messageId сообщения Евы", async () => {
  const { reactions, reaction } = reactionTools();
  const result = await runInTurn({
    runId: "run-callback", recorded: true, isCancelled: async () => false,
    chatId: 42, messageId: 600, reactionTarget: null,
  }, async () => await reaction.execute({ emoji: "👍" }, RUNTIME as never));
  assert.deepEqual(result, {
    ok: false, outcome: "skipped", reason: "no_reaction_target",
  });
  assert.deepEqual(reactions, []);
});

test("useEmoji=false remains a structured safe skip", async () => {
  const { reactions, reaction } = reactionTools();
  const result = await runInTurn({
    runId: "run-no-emoji", recorded: true, isCancelled: async () => false,
    reactionTarget: { updateId: 2, telegramUserId: 7, chatId: 42, messageId: 19 },
  }, async () => await reaction.execute(
    { emoji: "👍" }, { ...RUNTIME, useEmoji: false } as never,
  ));
  assert.deepEqual(result, { ok: false, outcome: "skipped", reason: "emoji_disabled" });
  assert.deepEqual(reactions, []);
});

test("вариационный селектор emoji нормализуется до Telegram reaction", async () => {
  const { reactions, reaction } = reactionTools();
  const result = await runInTurn(
    {
      runId: "run-heart", recorded: true, isCancelled: async () => false,
      reactionTarget: { updateId: 3, telegramUserId: 7, chatId: 42, messageId: 18 },
    },
    async () => await reaction.execute({ emoji: "❤️" }, RUNTIME as never),
  );
  assert.deepEqual(reactions, [{ chatId: 42, messageId: 18, emoji: "❤" }]);
  assert.deepEqual(result, {
    ok: true, outcome: "succeeded", reason: "delivered", emoji: "❤",
  });
});

test("A is skipped before enqueue when newer real B was already accepted", async () => {
  const calls: unknown[] = [];
  const db = reactionDb([1]);
  const telegram = new TelegramClient({
    telegramBotToken: "1001:secret", telegramApiBaseUrl: "https://api.telegram.invalid",
    telegramStickerCatalog: {},
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, db as never);
  telegram.call = async (...args) => { calls.push(args); return {} as never; };
  const target = { updateId: 10, telegramUserId: 7, chatId: 42, messageId: 101 };

  assert.deepEqual(await telegram.setReaction(42, 101, "👍", target), {
    skipped: true, reason: "stale_reaction_target",
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(db.selectValues, [[7, 42, 10]]);
});

test("newer B accepted after enqueue is rechecked under lock before delivery", async () => {
  const calls: unknown[] = [];
  let envelope: { method: string; payload: Record<string, unknown> } | null = null;
  const db = reactionDb([0, 1]);
  const telegram = new TelegramClient({
    telegramBotToken: "1001:secret", telegramApiBaseUrl: "https://api.telegram.invalid",
    telegramStickerCatalog: {},
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, db as never);
  telegram.call = async (...args) => { calls.push(args); return {} as never; };
  telegram.setOutbox({
    send: async (value) => {
      envelope = { method: value.method, payload: value.payload };
      return { queued: true };
    },
  });
  const target = { updateId: 10, telegramUserId: 7, chatId: 42, messageId: 101 };

  assert.deepEqual(await telegram.setReaction(42, 101, "👍", target), { queued: true });
  assert.ok(envelope, "reaction was not durably enqueued");
  assert.deepEqual(await telegram.deliver(envelope!.method, envelope!.payload), {
    skipped: true, reason: "stale_reaction_target",
  });
  assert.deepEqual(calls, [], "reaction must not move to B or be sent to A");
  assert.deepEqual(db.events.slice(-2), ["lock:telegram-reaction:7:42", "freshness"]);
});

test("fresh target is delivered to exact A and internal target never reaches Telegram", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const db = reactionDb([0, 0]);
  const telegram = new TelegramClient({
    telegramBotToken: "1001:secret", telegramApiBaseUrl: "https://api.telegram.invalid",
    telegramStickerCatalog: {},
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, db as never);
  telegram.call = async (method, body) => { calls.push({ method, body }); return {} as never; };
  const target = { updateId: 10, telegramUserId: 7, chatId: 42, messageId: 101 };
  await telegram.setReaction(42, 101, "👍", target);
  assert.deepEqual(calls, [{
    method: "setMessageReaction",
    body: { chat_id: 42, message_id: 101, reaction: [{ type: "emoji", emoji: "👍" }], is_big: false },
  }]);
});

test("real inbox acceptance takes reaction lock; callback and poll never create targets", async () => {
  const events: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (/pg_advisory_xact_lock/u.test(sql)) events.push(`lock:${values[0]}`);
    if (/INSERT INTO telegram_updates/u.test(sql)) events.push(`insert:${values[0]}`);
    return { rows: [], rowCount: 1 };
  };
  const inbox = new PostgresTelegramInbox({
    withSystemScope: async <T>(_reason: string, work: () => Promise<T>) => await work(),
    transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) => await work({ query }),
  } as never);
  await inbox.enqueue({
    update_id: 1,
    message: { message_id: 101, chat: { id: 42 }, from: { id: 7, is_bot: false }, text: "A" },
  });
  assert.deepEqual(events, ["lock:telegram-reaction:7:42", "insert:1"]);
  events.length = 0;
  await inbox.enqueue({
    update_id: 2,
    callback_query: { id: "c", from: { id: 7 }, message: { message_id: 500, chat: { id: 42 } } },
  } as never);
  await inbox.enqueue({ update_id: 3, poll_answer: { poll_id: "p", user: { id: 7 }, option_ids: [0] } } as never);
  assert.deepEqual(events, ["insert:2", "insert:3"]);
});

test("агрегированный ход выбирает последнюю реальную реплику пользователя", () => {
  const message = (updateId: number, messageId: number, allowReaction = true) =>
    normalizeUpdate({
      update_id: updateId,
      message: {
        message_id: messageId, date: updateId, chat: { id: 42, type: "private" },
        from: { id: 7, is_bot: false }, text: `part ${updateId}`,
      },
    } as never, allowReaction)!;
  assert.deepEqual(
    reactionTargetForTurn([message(1, 101), message(2, 999, false), message(3, 103)]),
    { updateId: 3, telegramUserId: 7, chatId: 42, messageId: 103 },
  );
  assert.deepEqual(
    reactionTargetForTurn([message(1, 101), message(2, 999, false)]),
    { updateId: 1, telegramUserId: 7, chatId: 42, messageId: 101 },
  );
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
    {
      runId: "run-2", recorded: true, isCancelled: async () => false,
      reactionTarget: { updateId: 4, telegramUserId: 7, chatId: 42, messageId: 21 },
    },
    async () => await reaction.execute({ emoji: "👍" }, RUNTIME as never),
  );
  const after = reactionStats();
  assert.equal(after.attempted, before.attempted + 1);
  assert.equal(after.succeeded, before.succeeded + 1);

  const failing = reactionTools({ fail: true });
  const failure = await runInTurn(
    {
      runId: "run-3", recorded: true, isCancelled: async () => false,
      reactionTarget: { updateId: 5, telegramUserId: 7, chatId: 42, messageId: 22 },
    },
    async () => await failing.reaction.execute({ emoji: "👍" }, RUNTIME as never),
  );
  assert.deepEqual(failure, {
    ok: false, outcome: "failed", reason: "telegram_api_error",
  });
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
    chatId: 42, messageId: 555, reactionTarget: { updateId: 6, telegramUserId: 42, chatId: 42, messageId: 555 },
  };
  const scope = openTurnScope("conv-1", turn as never);
  try {
    // Ни одного `runInTurn` вокруг: ровно как у SDK.
    const result = await tools.get("set_reaction")!.execute(
      { emoji: "👍" }, runtime as never,
    ) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.deepEqual(reactions, [{ chatId: 42, messageId: 555, emoji: "👍" }]);
  } finally {
    closeTurnScope(scope);
  }

  // Ход закончился — адрес снят, и следующий вызов уже не найдёт чужое
  // сообщение.
  assert.deepEqual(
    await tools.get("set_reaction")!.execute({ emoji: "👍" }, runtime as never),
    { ok: false, outcome: "skipped", reason: "no_reaction_target" },
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
  const scope = openTurnScope("conv-A", {
    runId: "r1", recorded: true, isCancelled: async () => false,
    reactionTarget: { updateId: 7, telegramUserId: 1, chatId: 1, messageId: 10 },
  } as never);
  try {
    assert.deepEqual(
      await tools.get("set_reaction")!.execute({ emoji: "👍" }, {
        userId: 2, telegramId: 2, chatId: 2, conversationId: "conv-B",
        purpose: "chat", useEmoji: true,
      } as never),
      { ok: false, outcome: "skipped", reason: "no_reaction_target" },
    );
  } finally {
    closeTurnScope(scope);
  }
});

test("старый close не снимает scope нового пересекающегося хода", async () => {
  const { openTurnScope, closeTurnScope, turnOf } = await import("../dist/turns/turn-context.js");
  const old = openTurnScope("conv-overlap", {
    conversationId: "conv-overlap", runId: "old", recorded: true,
    isCancelled: async () => false, chatId: 1, messageId: 10,
  });
  const fresh = openTurnScope("conv-overlap", {
    conversationId: "conv-overlap", runId: "fresh", recorded: true,
    isCancelled: async () => false, chatId: 1, messageId: 20,
  });
  closeTurnScope(old);
  assert.equal(turnOf("conv-overlap")?.runId, "fresh");
  closeTurnScope(fresh);
  assert.equal(turnOf("conv-overlap"), undefined);
});

test("delayed tool callback keeps captured target after next turn opens", async () => {
  const { openTurnScope, closeTurnScope } = await import("../dist/turns/turn-context.js");
  const { reactions, reaction } = reactionTools();
  const oldTurn = {
    conversationId: "conv-1", runId: "old", recorded: true,
    isCancelled: async () => false, chatId: 42, messageId: 101,
    reactionTarget: { updateId: 8, telegramUserId: 42, chatId: 42, messageId: 101 },
  };
  const oldScope = openTurnScope("conv-1", oldTurn);
  const captured = withToolTurn(RUNTIME as never, oldTurn);
  const freshScope = openTurnScope("conv-1", {
    conversationId: "conv-1", runId: "fresh", recorded: true,
    isCancelled: async () => false, chatId: 42, messageId: 202,
    reactionTarget: { updateId: 9, telegramUserId: 42, chatId: 42, messageId: 202 },
  });
  try {
    await reaction.execute({ emoji: "👍" }, captured as never);
    assert.deepEqual(reactions, [{ chatId: 42, messageId: 101, emoji: "👍" }]);
  } finally {
    closeTurnScope(oldScope);
    closeTurnScope(freshScope);
  }
});

test("ALS другого conversation не перекрывает точный scope", async () => {
  const { openTurnScope, closeTurnScope, turnOf } = await import("../dist/turns/turn-context.js");
  const scope = openTurnScope("conv-B", {
    conversationId: "conv-B", runId: "B", recorded: true,
    isCancelled: async () => false, chatId: 2, messageId: 2,
  });
  try {
    await runInTurn({
      conversationId: "conv-A", runId: "A", recorded: true,
      isCancelled: async () => false, chatId: 1, messageId: 1,
    }, async () => assert.equal(turnOf("conv-B")?.runId, "B"));
  } finally {
    closeTurnScope(scope);
  }
});

function reactionDb(freshnessRows: number[]) {
  const events: string[] = [];
  const selectValues: unknown[][] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    if (/pg_advisory_xact_lock/u.test(sql)) {
      events.push(`lock:${values[0]}`);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM telegram_updates/u.test(sql)) {
      events.push("freshness");
      selectValues.push(values);
      return { rows: [], rowCount: freshnessRows.shift() ?? 0 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return {
    events, selectValues, query,
    withSystemScope: async <T>(_reason: string, work: () => Promise<T>) => await work(),
    transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) => await work({ query }),
  };
}
