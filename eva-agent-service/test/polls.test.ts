/**
 * Нативные опросы Telegram.
 *
 * Сторожится главное: пределы Bot API проверяются до отправки; повтор
 * того же вызова инструмента не создаёт второй опрос; тексты вариантов
 * в разговор приходят из серверной записи, а не из апдейта; чужой
 * голос и чужой опрос ходом не становятся; повторный тот же выбор
 * второго хода не заводит.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EvaWorkflow, normalizeUpdate } from "../dist/eva-workflow.js";
import {
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_QUESTION_LENGTH,
  PollError,
  namedOptions,
  normalizePoll,
  sameAnswer,
} from "../dist/telegram/polls.js";
import { CoreToolFactory } from "../dist/tools/core-tools.js";
import { telegramPollOf } from "../dist/telegram.js";
import { runInTurn } from "../dist/turns/turn-context.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (
    args: Record<string, unknown>,
    runtime: unknown,
    toolCallId: string,
  ) => Promise<unknown>,
) => ({
  name, label, description, parameters,
  execute: async (callId: string, args: Record<string, unknown>, runtime: unknown) =>
    ({ details: await execute(args, runtime, callId) }),
});

const runtime = { userId: 1, telegramId: 42, chatId: 42, conversationId: "c", purpose: "chat" };

/** Фейк базы с той же семантикой ключей, что у миграции 062. */
function pollDb() {
  const polls: Array<{
    id: string; userId: number; chatId: number; conversationId: string;
    toolCallId: string; pollId: string | null; messageId: number | null;
    question: string; options: string[]; isAnonymous: boolean;
  }> = [];
  const answers = new Map<string, number[]>();
  let nextId = 1;
  return {
    polls,
    answers,
    withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    createPoll: async (input: Record<string, unknown>) => {
      const existing = polls.find((poll) =>
        poll.userId === input.userId && poll.toolCallId === input.toolCallId);
      if (existing) return { id: existing.id, pollId: existing.pollId, created: false };
      const row = {
        id: `p${nextId++}`,
        userId: input.userId as number,
        chatId: input.chatId as number,
        conversationId: input.conversationId as string,
        toolCallId: input.toolCallId as string,
        pollId: null as string | null,
        messageId: null as number | null,
        question: input.question as string,
        options: input.options as string[],
        isAnonymous: input.isAnonymous as boolean,
      };
      polls.push(row);
      return { id: row.id, pollId: null, created: true };
    },
    bindPoll: async (input: Record<string, unknown>) => {
      const row = polls.find((poll) => poll.id === input.id && poll.userId === input.userId);
      if (row && row.pollId === null) {
        row.pollId = input.pollId as string;
        row.messageId = input.messageId as number | null;
      }
    },
    findPollByTelegramId: async (pollId: string) => {
      const row = polls.find((poll) => poll.pollId === pollId);
      return row ?? null;
    },
    findUserByTelegramId: async (telegramId: number) =>
      telegramId === 42 ? { id: 1 } : telegramId === 43 ? { id: 2 } : null,
    recordPollAnswer: async (input: { userId: number; pollId: string; optionIds: number[] }) => {
      const key = `${input.pollId}:${input.userId}`;
      const previous = answers.get(key);
      if (previous && sameAnswer(previous, input.optionIds)) return { status: "duplicate" };
      answers.set(key, input.optionIds);
      return { status: "recorded" };
    },
  };
}

function workflowWith(db: unknown): EvaWorkflow {
  return new EvaWorkflow(
    {} as never, db as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never,
    { debug() {}, info() {}, warn() {}, error() {} } as never,
  );
}

test("пределы Bot API проверяются до отправки", () => {
  assert.throws(() => normalizePoll({ question: " ", options: ["а", "б"] }), PollError);
  assert.throws(
    () => normalizePoll({ question: "я".repeat(MAX_QUESTION_LENGTH + 1), options: ["а", "б"] }),
    PollError,
  );
  assert.throws(() => normalizePoll({ question: "Как ты?", options: ["а"] }), PollError);
  assert.throws(
    () => normalizePoll({
      question: "Как ты?",
      options: Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => `в${index}`),
    }),
    PollError,
  );
  assert.throws(
    () => normalizePoll({ question: "Как ты?", options: ["а", "б".repeat(MAX_OPTION_LENGTH + 1)] }),
    PollError,
  );
  // Одинаковые варианты неразличимы в ответе: номер придёт, а смысл — нет.
  assert.throws(() => normalizePoll({ question: "Как ты?", options: ["Да", "Да"] }), PollError);

  const poll = normalizePoll({ question: " Как ты? ", options: [" Хорошо ", "Устал"] });
  assert.deepEqual(poll, {
    question: "Как ты?",
    options: ["Хорошо", "Устал"],
    isAnonymous: false,
    allowsMultiple: false,
  });
});

test("варианты называются по серверной записи, а не по апдейту", () => {
  const options = ["Хорошо", "Устал", "Тревожно"];
  assert.deepEqual(namedOptions(options, [2, 0]), ["Тревожно", "Хорошо"]);
  // Номера вне списка — мусор клиента, а не выбор.
  assert.deepEqual(namedOptions(options, [7, -1, 1.5 as number]), []);
  assert.deepEqual(namedOptions(options, [1, 1]), ["Устал"]);
  assert.ok(sameAnswer([1, 0], [0, 1]));
  assert.ok(!sameAnswer([0], [0, 1]));
});

test("инструмент заводит запись до отправки и связывает опрос после неё", async () => {
  const db = pollDb();
  const sent: Array<Record<string, unknown>> = [];
  const telegram = {
    sendPoll: async (chatId: number, poll: Record<string, unknown>) => {
      sent.push({ chatId, ...poll });
      return { message_id: 555, poll: { id: "tg-poll-1" } };
    },
  };
  const tools = new Map(new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never,
    db as never,
    telegram as never,
  ).build(tool as never).map((entry) => [entry.name, entry]));
  assert.ok(tools.has("send_poll"), "инструмент опроса зарегистрирован");

  const turn = { runId: "r1", recorded: true, isCancelled: async () => false, chatId: 42 } as never;
  const result = await runInTurn(turn, async () => await tools.get("send_poll")!.execute(
    "call-1",
    { question: "Что разберём первым?", options: ["Сон", "Работу"] },
    runtime as never,
  ));
  assert.deepEqual(result.details, {
    ok: true, options: 2, anonymous: false, answers_linked: true,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.isAnonymous, false, "по умолчанию опрос неанонимный");
  assert.equal(db.polls[0]!.pollId, "tg-poll-1");
  assert.equal(db.polls[0]!.messageId, 555);

  // Повтор того же вызова после обрыва: второго опроса в чате не появляется.
  const again = await runInTurn(turn, async () => await tools.get("send_poll")!.execute(
    "call-1",
    { question: "Что разберём первым?", options: ["Сон", "Работу"] },
    runtime as never,
  ));
  assert.deepEqual(again.details, { ok: true, repeated: true, answers_linked: true });
  assert.equal(sent.length, 1, "повтор вызова не отправляет второй опрос");
  assert.equal(db.polls.length, 1);
});

test("негодный опрос возвращается ошибкой и в Telegram не уходит", async () => {
  const db = pollDb();
  let calls = 0;
  const telegram = { sendPoll: async () => { calls += 1; return {}; } };
  const tools = new Map(new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never, db as never, telegram as never,
  ).build(tool as never).map((entry) => [entry.name, entry]));
  const turn = { runId: "r1", recorded: true, isCancelled: async () => false, chatId: 42 } as never;
  const result = await runInTurn(turn, async () => await tools.get("send_poll")!.execute(
    "call-1", { question: "Как ты?", options: ["Одно"] }, runtime as never,
  ));
  assert.deepEqual(result.details, {
    ok: false, reason: "options_too_few", note: "Вариантов должно быть не меньше 2",
  });
  assert.equal(calls, 0);
  assert.equal(db.polls.length, 0, "негодный опрос записи не оставляет");
});

test("отложенная доставка честно говорит, что голос связать будет нечем", async () => {
  const db = pollDb();
  const telegram = { sendPoll: async () => ({ queued: true }) };
  const tools = new Map(new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never, db as never, telegram as never,
  ).build(tool as never).map((entry) => [entry.name, entry]));
  const turn = { runId: "r1", recorded: true, isCancelled: async () => false, chatId: 42 } as never;
  const result = await runInTurn(turn, async () => await tools.get("send_poll")!.execute(
    "call-1", { question: "Как ты?", options: ["Хорошо", "Устал"] }, runtime as never,
  ));
  assert.deepEqual(result.details, { ok: true, answers_linked: false });
  assert.equal(telegramPollOf({ queued: true }), null);
  assert.equal(db.polls[0]!.pollId, null);
});

test("голос в опросе становится сообщением человека по серверной записи", async () => {
  const db = pollDb();
  db.polls.push({
    id: "p1", userId: 1, chatId: 42, conversationId: "c", toolCallId: "call-1",
    pollId: "tg-poll-1", messageId: 555, question: "Что разберём первым?",
    options: ["Сон", "Работу"], isAnonymous: false,
  });
  const workflow = workflowWith(db) as unknown as {
    resolvePollAnswer(answer: unknown): Promise<{ message?: { text?: string; chat: { id: number } } } | null>;
  };

  const update = await workflow.resolvePollAnswer({
    poll_id: "tg-poll-1", user: { id: 42 }, option_ids: [1],
  });
  assert.ok(update?.message);
  assert.equal(update!.message!.text, "Ответ в опросе «Что разберём первым?»: Работу");
  assert.equal(update!.message!.chat.id, 42, "чат берётся из записи опроса, а не из апдейта");

  // Тот же апдейт пришёл второй раз — второго хода нет.
  assert.equal(
    await workflow.resolvePollAnswer({ poll_id: "tg-poll-1", user: { id: 42 }, option_ids: [1] }),
    null,
  );
  // Человек передумал: это новый выбор и новый ход.
  const changed = await workflow.resolvePollAnswer({
    poll_id: "tg-poll-1", user: { id: 42 }, option_ids: [0],
  });
  assert.equal(changed?.message?.text, "Ответ в опросе «Что разберём первым?»: Сон");
  // Голос отозван: сказать разговору нечего.
  assert.equal(
    await workflow.resolvePollAnswer({ poll_id: "tg-poll-1", user: { id: 42 }, option_ids: [] }),
    null,
  );
});

test("анонимный опрос не приписывается человеку даже с автором в апдейте", async () => {
  const db = pollDb();
  db.polls.push({
    id: "p1", userId: 1, chatId: 42, conversationId: "c", toolCallId: "call-1",
    pollId: "tg-anon", messageId: 555, question: "Как ты?",
    options: ["Хорошо", "Устал"], isAnonymous: true,
  });
  const workflow = workflowWith(db) as unknown as {
    resolvePollAnswer(answer: unknown): Promise<unknown | null>;
  };
  // Telegram сегодня автора анонимного опроса не называет, но правило
  // держится нашей записью, а не поведением чужой стороны.
  assert.equal(
    await workflow.resolvePollAnswer({ poll_id: "tg-anon", user: { id: 42 }, option_ids: [0] }),
    null,
  );
  assert.equal(db.answers.size, 0, "анонимный голос не записывается на человека");
});

test("запасной ключ повтора привязан к ходу, а не к тексту вопроса", async () => {
  const db = pollDb();
  const sent: unknown[] = [];
  const telegram = {
    sendPoll: async () => {
      sent.push(1);
      return { message_id: 1, poll: { id: `tg-${sent.length}` } };
    },
  };
  const tools = new Map(new CoreToolFactory(
    { routerUrl: "", routerApiKey: "" } as never, db as never, telegram as never,
  ).build(tool as never).map((entry) => [entry.name, entry]));
  const args = { question: "Как неделя?", options: ["Хорошо", "Тяжело"] };

  // SDK не назвал вызов. Тот же вопрос на следующей неделе — новый ход и
  // новый опрос, а не молчаливый отказ.
  for (const runId of ["r1", "r2"]) {
    const turn = { runId, recorded: true, isCancelled: async () => false, chatId: 42 } as never;
    await runInTurn(turn, async () =>
      await tools.get("send_poll")!.execute("", args, runtime as never));
  }
  assert.equal(sent.length, 2, "второй ход отправляет свой опрос");

  // Повтор в том же ходе — это тот же вызов после обрыва.
  const turn = { runId: "r2", recorded: true, isCancelled: async () => false, chatId: 42 } as never;
  const repeat = await runInTurn(turn, async () =>
    await tools.get("send_poll")!.execute("", args, runtime as never));
  assert.deepEqual(repeat.details, { ok: true, repeated: true, answers_linked: true });
  assert.equal(sent.length, 2);
});

test("чужой опрос и чужой голос ходом не становятся", async () => {
  const db = pollDb();
  db.polls.push({
    id: "p1", userId: 1, chatId: 42, conversationId: "c", toolCallId: "call-1",
    pollId: "tg-poll-1", messageId: 555, question: "Что разберём первым?",
    options: ["Сон", "Работу"], isAnonymous: false,
  });
  const workflow = workflowWith(db) as unknown as {
    resolvePollAnswer(answer: unknown): Promise<unknown | null>;
  };

  // Опрос, которого Ева не создавала.
  assert.equal(
    await workflow.resolvePollAnswer({ poll_id: "чужой", user: { id: 42 }, option_ids: [0] }),
    null,
  );
  // Голос другого человека: владелец опроса записан на сервере.
  assert.equal(
    await workflow.resolvePollAnswer({ poll_id: "tg-poll-1", user: { id: 43 }, option_ids: [0] }),
    null,
  );
  // Анонимный опрос автора не называет — связывать нечего.
  assert.equal(
    await workflow.resolvePollAnswer({ poll_id: "tg-poll-1", option_ids: [0] }),
    null,
  );
  assert.equal(db.answers.size, 0, "чужие голоса не записываются");
});

test("кнопка и опрос разбираются и на пути параллельного диспетчера", async () => {
  const db = pollDb();
  const asked: string[] = [];
  const workflow = new EvaWorkflow(
    {} as never,
    {
      ...db,
      findUserByTelegramId: async () => ({ id: 1 }),
      claimCallbackToken: async () => {
        asked.push("callback");
        return { status: "unknown" };
      },
      findPollByTelegramId: async (pollId: string) => {
        asked.push(`poll:${pollId}`);
        return null;
      },
    } as never,
    {} as never, {} as never, {} as never,
    { answerCallbackQuery: async () => { asked.push("answered"); } } as never,
    {} as never, {} as never,
    { debug() {}, info() {}, warn() {}, error() {} } as never,
  );

  // Параллельный диспетчер входит через processAggregated, а не через
  // processQueued: разбор должен работать и здесь, иначе включение
  // параллельного приёма молча ломает кнопки и опросы.
  assert.deepEqual(
    await workflow.processAggregated([
      { update_id: 1, callback_query: { id: "q1", from: { id: 42 }, data: "tok" } } as never,
    ]),
    { status: "ignored" },
  );
  assert.deepEqual(
    await workflow.processAggregated([
      { update_id: 2, poll_answer: { poll_id: "tg-1", user: { id: 42 }, option_ids: [0] } } as never,
    ]),
    { status: "ignored" },
  );
  assert.deepEqual(asked, ["answered", "callback", "poll:tg-1"]);
});

test("callback и poll answer не наследуют reaction target сообщения Евы", async () => {
  const db = pollDb();
  db.polls.push({
    id: "p1", userId: 1, chatId: 42, conversationId: "c", toolCallId: "call-1",
    pollId: "tg-poll", messageId: 700, question: "Как ты?",
    options: ["Хорошо", "Устал"], isAnonymous: false,
  });
  const workflow = new EvaWorkflow(
    {} as never,
    {
      ...db,
      claimCallbackToken: async () => ({
        status: "claimed", chatId: 42, messageId: 600,
        value: "Первый вариант", oneShot: false,
      }),
    } as never,
    {} as never, {} as never, {} as never,
    {
      answerCallbackQuery: async () => {},
      clearInlineKeyboard: async () => {},
    } as never,
    {} as never, {} as never,
    { debug() {}, info() {}, warn() {}, error() {} } as never,
  ) as unknown as {
    resolveSpecial(update: unknown): Promise<{
      update: Parameters<typeof normalizeUpdate>[0]; allowReaction: boolean;
    } | null>;
  };

  const callback = await workflow.resolveSpecial({
    update_id: 1,
    callback_query: { id: "q", from: { id: 42 }, data: "token" },
  });
  const poll = await workflow.resolveSpecial({
    update_id: 2,
    poll_answer: { poll_id: "tg-poll", user: { id: 42 }, option_ids: [0] },
  });
  assert.equal(callback?.allowReaction, false);
  assert.equal(poll?.allowReaction, false);
  assert.equal(callback?.update.message?.message_id, 600, "ID бота остаётся только связью хода");
  assert.equal(poll?.update.message?.message_id, 700, "ID опроса остаётся только связью хода");
  assert.equal(
    normalizeUpdate(callback!.update, callback!.allowReaction)?.reactionTarget,
    null,
  );
  assert.equal(normalizeUpdate(poll!.update, poll!.allowReaction)?.reactionTarget, null);
});

test("голос в опросе не подмешивается в объединённый ход обычных сообщений", async () => {
  const { aggregatable } = await import("../dist/turns/aggregator.js");
  assert.equal(
    aggregatable({ update_id: 1, poll_answer: { poll_id: "tg-1", user: { id: 42 } } } as never),
    false,
  );
  assert.equal(
    aggregatable({ update_id: 2, callback_query: { id: "q", from: { id: 42 }, data: "t" } } as never),
    false,
  );
  // Обычное сообщение объединяется по-прежнему.
  assert.equal(
    aggregatable({
      update_id: 3,
      message: { message_id: 1, chat: { id: 42 }, from: { id: 42 }, text: "привет" },
    } as never),
    true,
  );
});
