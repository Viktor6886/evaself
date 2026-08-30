import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { assertCronExpression, cronFieldMatches, nextCronDate } from "../dist/background.js";
import { formatVoiceTranscriptEcho, normalizeUpdate } from "../dist/eva-workflow.js";
import { evaMemoryBlocks } from "../dist/letta.js";
import { ensureCoreMemoryBlocks } from "../dist/letta/memory-blocks.js";
import { RuntimeContextBuilder } from "../dist/runtime/runtime-context.js";

import {
  splitTelegramText,
  liveStepWords,
  nextLivePrefix,
  TelegramApiError,
  TelegramClient,
  webhookSecretMatches,
} from "../dist/telegram.js";

test("Telegram text is split without losing content", () => {
  const source = `${"слово ".repeat(900)}конец`.trim();
  const chunks = splitTelegramText(source, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), source.replace(/\s+/g, " "));
});

/** Клиент с подменённым `call`: наружу ничего не уходит, всё видно тесту. */
function liveClient() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  let nextMessageId = 500;
  telegram.call = async (method, body) => {
    calls.push({ method, body });
    return (method === "sendMessage" || method === "sendRichMessage"
      ? { message_id: nextMessageId++ }
      : true) as never;
  };
  return { telegram, calls };
}

function renderedCallText(call: { body: Record<string, unknown> }): string {
  return String((call.body.rich_message as { markdown?: string } | undefined)?.markdown ?? call.body.text);
}

/**
 * Показ ответа больше не занимает поле ввода.
 *
 * `sendMessageDraft` показывал черновик бота, но подменял кнопку отправки
 * на «•••»: пока Ева отвечала, человек не мог написать следующее
 * сообщение. Теперь первый содержательный срез уходит обычным
 * сообщением, а следующие правят его же.
 */
test("первый срез уходит одним сообщением, дальше правится оно же", async () => {
  const { telegram, calls } = liveClient();
  let sentMessageId: number | null = null;
  const live = telegram.startLiveMessage(123, {
    intervalMs: 0,
    onSent: (id) => { sentMessageId = id; },
  });

  live.push("Понимаю");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Три состояния подряд между правками: наружу уходит только последнее.
  live.push("Понимаю.");
  live.push("Понимаю. Рас");
  live.push("Понимаю. Расскажи");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await live.finish("Понимаю. Расскажи, что было дальше.");

  assert.deepEqual(calls.map((call) => call.method), [
    "sendRichMessage",
    "editMessageText",
    "editMessageText",
    "editMessageText",
  ]);
  // Состояния, пришедшие пока шла правка, схлопнулись в последнее:
  // «Понимаю. Рас» наружу не уходило, очередь правок не копится.
  assert.deepEqual(calls.map(renderedCallText), [
    "Понимаю ▉",
    "Понимаю. ▉",
    "Понимаю. Расскажи ▉",
    "Понимаю. Расскажи, что было дальше.",
  ]);
  // Тот же message_id до самого конца: второго ответа в чате нет.
  const messageId = calls[0]?.body.chat_id === 123 ? sentMessageId : null;
  assert.equal(typeof messageId, "number");
  for (const call of calls.slice(1)) assert.equal(call.body.message_id, messageId);
  assert.equal(live.messageId, messageId);
  assert.equal(calls.filter((call) => call.method === "sendRichMessage").length, 1);
});

test("правки не чаще заданного промежутка", async () => {
  const { telegram, calls } = liveClient();
  const live = telegram.startLiveMessage(123, { intervalMs: 60_000 });

  live.push("Первое состояние");
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.push("Второе состояние");
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Минута промежутка ещё не прошла: второе состояние ждёт, а не летит
  // следом. Иначе лимит чата выбирается на первых секундах ответа.
  assert.deepEqual(calls.map(renderedCallText), ["Первое состояние ▉"]);
  live.stop();
});

test("пауза после 429 не задерживает доставку ответа", async () => {
  // Telegram попросил подождать полминуты. Это касается показа —
  // украшения; готовый ответ ждать его не должен, иначе однократный
  // рейт-лимит превращается в задержку доставки на весь retry_after.
  const { telegram, calls } = liveClient();
  let finalizing = false;
  telegram.call = async (method, body) => {
    calls.push({ method, body });
    if (method === "sendRichMessage") return { message_id: 777 } as never;
    // Промежуточная правка упирается в лимит чата; итоговую доставку
    // Telegram принимает.
    if (!finalizing) throw new TelegramApiError("Telegram editMessageText: Too Many Requests", 30_000);
    return true as never;
  };
  const live = telegram.startLiveMessage(123, { intervalMs: 0 });

  live.push("первое состояние");
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.push("второе состояние");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Третье состояние приходит уже в паузе: показ засыпает на все
  // тридцать секунд, названные Telegram.
  live.push("третье состояние");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(live.shown, "первое состояние", "показ не встал в паузу");

  const started = Date.now();
  finalizing = true;
  const finished = await live.finish("итоговый ответ");
  const waited = Date.now() - started;

  assert.ok(waited < 1_000, `доставка ждала паузу показа: ${waited} мс`);
  assert.equal(finished.delivered, true);
  assert.equal(finished.messageId, 777);
});

test("отказ Telegram на показе не роняет ход и не создаёт шторма повторов", async () => {
  const { telegram, calls } = liveClient();
  telegram.call = async (method, body) => {
    calls.push({ method, body });
    throw new TelegramApiError("Telegram sendMessage: Too Many Requests", 30_000);
  };
  const live = telegram.startLiveMessage(123, { intervalMs: 0 });

  live.push("первое");
  await new Promise((resolve) => setTimeout(resolve, 30));
  live.push("второе");
  live.push("третье");
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Telegram попросил подождать тридцать секунд — значит ждём, а не
  // повторяем каждое состояние. Одна попытка, и ход продолжается.
  assert.equal(calls.length, 1);
  assert.equal(live.shown, "");
  const finished = await live.finish("итог");
  assert.equal(finished.delivered, false, "несостоявшийся показ не выдаёт себя за доставку");
});

test("отменённый ход не правит сообщение после остановки", async () => {
  const { telegram, calls } = liveClient();
  const live = telegram.startLiveMessage(123, { intervalMs: 0 });

  live.push("начало ответа");
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.stop();
  live.push("недописанный хвост");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(calls.map(renderedCallText), ["начало ответа ▉", "начало ответа"]);
});

test("если показывать было нечего, ответ уходит обычной отправкой", async () => {
  const { telegram, calls } = liveClient();
  const live = telegram.startLiveMessage(123, { intervalMs: 0 });

  const finished = await live.finish("готовый ответ");
  assert.equal(finished.delivered, false);
  assert.deepEqual(calls, []);
});

test("итоговый текст доводится durable-правкой, а не вторым сообщением", async () => {
  const { telegram, calls } = liveClient();
  const enqueued: Array<{ method: string; payload: Record<string, unknown> }> = [];
  telegram.setOutbox({
    send: async (envelope: {
      method: string;
      payload: Record<string, unknown>;
      onMetrics?: (metrics: { outboxInsertMs: number; telegramSendMs: number }) => void;
    }) => {
      enqueued.push({ method: envelope.method, payload: envelope.payload });
      envelope.onMetrics?.({ outboxInsertMs: 0, telegramSendMs: 0 });
      return { queued: true };
    },
  } as never);
  const live = telegram.startLiveMessage(123, { intervalMs: 0 });

  live.push("Начало");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finished = await live.finish("Начало и конец ответа.");

  assert.equal(finished.delivered, true);
  // Промежуточный показ идёт мимо outbox: повторять его после
  // перезапуска незачем, он уже неактуален.
  assert.deepEqual(calls.map((call) => call.method), ["sendRichMessage"]);
  // Итог — durable, и это правка того же сообщения.
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.method, "editMessageText");
  assert.equal(enqueued[0]?.payload.message_id, live.messageId);
  assert.match(
    String((enqueued[0]?.payload.rich_message as { markdown?: string })?.markdown),
    /Начало и конец ответа\./,
  );
});

test("«текст не изменился» — это доставленный ответ, а не отказ", async () => {
  const { telegram } = liveClient();
  telegram.call = async () => {
    throw new TelegramApiError("Telegram editMessageText: Bad Request: message is not modified");
  };
  // Итоговый текст уже показан целиком: править нечего. Для Telegram это
  // ошибка, для доставки — доставленный ответ.
  const result = await telegram.deliver("editMessageText", {
    chat_id: 1,
    message_id: 2,
    text: "тот же текст",
  });
  assert.deepEqual(result, {});
});

test("черновик Telegram больше не используется в обычном ходе", async () => {
  // Отдельная проверка на состав кода: пока метод существует хоть
  // где-то, он вернётся в первый же ход, а вместе с ним и «•••» вместо
  // кнопки отправки.
  const sources = await Promise.all(
    ["../dist/telegram.js", "../dist/eva-workflow.js"].map(async (file) =>
      await readFile(new URL(file, import.meta.url), "utf8")),
  );
  for (const source of sources) {
    assert.doesNotMatch(source, /"sendMessageDraft"|'sendMessageDraft'/);
  }
});

test("voice transcript echo is quoted without changing the transcript and is sent without parse mode", async () => {
  assert.equal(
    formatVoiceTranscriptEcho("  проверь _точный_ текст  "),
    '🎙️ "  проверь _точный_ текст  "',
  );

  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new TelegramClient(
    {
      telegramBotToken: "test-token",
      telegramApiBaseUrl: "https://api.telegram.invalid",
    } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (method, body) => {
    calls.push({ method, body });
    return true as never;
  };

  await telegram.sendPlainMessage(123, '🎙️ "проверь _точный_ текст"');
  assert.equal(calls[0]?.method, "sendMessage");
  assert.equal(calls[0]?.body.text, '🎙️ "проверь _точный_ текст"');
  assert.equal("parse_mode" in (calls[0]?.body ?? {}), false);
});

test("Telegram webhook secret comparison fails closed", () => {
  assert.equal(webhookSecretMatches("correct", "correct"), true);
  assert.equal(webhookSecretMatches("wrong", "correct"), false);
  assert.equal(webhookSecretMatches(undefined, "correct"), false);
  assert.equal(webhookSecretMatches("correct", ""), false);
});

test("Telegram update normalization recognizes voice and commands", () => {
  const command = normalizeUpdate({
    update_id: 42,
    message: {
      message_id: 5,
      chat: { id: 11 },
      from: { id: 11, first_name: "Виктор" },
      text: "/balance@EvaBot",
    },
  });
  assert.equal(command?.command, "/balance");
  assert.equal(command?.kind, "text");

  const voice = normalizeUpdate({
    update_id: 43,
    message: {
      message_id: 6,
      chat: { id: 11 },
      from: { id: 11, first_name: "Виктор" },
      voice: { file_id: "abc" },
    },
  });
  assert.equal(voice?.kind, "voice");

  const reply = normalizeUpdate({
    update_id: 44,
    message: {
      message_id: 8,
      chat: { id: 11 },
      from: { id: 11, first_name: "Виктор" },
      text: "Сделал",
      reply_to_message: {
        message_id: 77,
        chat: { id: 11 },
        text: "Напоминание",
      },
    },
  });
  assert.equal(reply?.replyToMessageId, 77);
});

test("time context uses the configured timezone", () => {
  const builder = new RuntimeContextBuilder({} as never, {
    defaultTimezone: "UTC",
  });
  const prompt = builder.wrapUserMessage({
    userId: 1,
    telegramId: 1,
    agentId: "agent",
    conversationId: "conversation",
    purpose: "chat",
    localTime: "2026-07-29T12:00:00+05:00",
    timezone: "Asia/Yekaterinburg",
    city: "Пермь",
    countryCode: "RU",
    responseLanguage: "ru",
    responseMode: "text",
    useEmoji: true,
    communicationStyle: null,
    profileHint: null,
    activeGoal: null,
    nextResult: null,
    nextStep: null,
    relevantMemory: [],
  }, "Привет");
  assert.match(prompt, /Asia\/Yekaterinburg/);
  assert.match(prompt, /Привет/);
  assert.match(prompt, /<EVA_RUNTIME_CONTEXT>/);
  assert.match(prompt, /<USER_MESSAGE>/);
  // Постоянные правила в блок не попадают: они в персоне и навыках.
  assert.doesNotMatch(prompt, /vector_protocol|self_reference|formatting:|layout:/);
});

test("runtime context marks a transcript as voice without changing its words", () => {
  const builder = new RuntimeContextBuilder({} as never, { defaultTimezone: "UTC" });
  const prompt = builder.wrapUserMessage({
    userId: 1,
    telegramId: 1,
    agentId: "agent",
    conversationId: "conversation",
    purpose: "chat",
    localTime: "2026-08-02T12:00:00Z",
    timezone: "UTC",
    city: null,
    countryCode: null,
    responseLanguage: "ru",
    responseMode: "text",
    useEmoji: true,
    communicationStyle: null,
    profileHint: null,
    activeGoal: null,
    nextResult: null,
    nextStep: null,
    relevantMemory: [],
  }, "Это расшифровка", { messageSource: "voice" });

  assert.match(prompt, /message_source: voice/);
  assert.match(prompt, /speech-to-text transcript of a voice message/);
  assert.match(prompt, /<USER_MESSAGE>\nЭто расшифровка\n<\/USER_MESSAGE>/);
});

test("активная программа приходит в ход компактными фактами, без команды модели", async () => {
  const builder = new RuntimeContextBuilder(
    {
      query: async () => ({
        rows: [{
          ...CONTEXT_ROW,
          program_key: "planning-30d", program_version: 1,
          program_phase_key: "mapping", program_step_key: "step-7",
          program_next_step_key: "step-8",
          program_next_action_hint: "выбрать три результата",
          program_resume_policy: "contextual",
        }],
      }),
    } as never,
    { defaultTimezone: "UTC", profileCompletionEnabled: false, now: () => new Date("2026-08-14T12:00:00Z") },
  );
  const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "продолжим" });
  assert.equal(context.activeProgram, "planning-30d@1");
  assert.equal(context.programStep, "step-7");

  const prompt = builder.wrapUserMessage(context, "продолжим");
  assert.match(prompt, /active_program: planning-30d@1/);
  assert.match(prompt, /program_phase: mapping/);
  assert.match(prompt, /program_next: step-8 — выбрать три результата/);
  assert.match(prompt, /program_resume: contextual/);
  // Факт, а не указание: решение продолжать остаётся за Letta.
  assert.doesNotMatch(prompt, /MUST|обязана|открой навык/i);
});

test("человек без программы получает прежний ход", async () => {
  const builder = contextBuilder(new Date("2026-08-14T12:00:00Z"));
  const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "привет" });
  assert.equal(context.activeProgram, null);
  const prompt = builder.wrapUserMessage(context, "привет");
  assert.doesNotMatch(prompt, /active_program|program_phase|program_step|program_next/);
});

test("выборка курсора берёт только активный запуск своего пользователя", async () => {
  // Пауза, завершение и отмена в каждый ход не тянутся: закрытая работа
  // не должна занимать контекст, пока человек к ней не вернулся.
  const statements: string[] = [];
  const builder = new RuntimeContextBuilder(
    {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [{ ...CONTEXT_ROW }] };
      },
    } as never,
    { defaultTimezone: "UTC", profileCompletionEnabled: false },
  );
  await builder.build({ userId: 1, conversationId: "c", userMessage: "привет" });
  // Курсор читается тем же запросом контекста, а не отдельным round trip.
  const sql = statements.find((text) => text.includes("goal_program_runs")) ?? "";
  assert.equal(statements.filter((text) => text.includes("goal_program_runs")).length, 1);
  assert.match(sql, /FROM goal_program_runs gpr/);
  assert.match(sql, /gpr\.user_id = u\.id/);
  assert.match(sql, /gpr\.status = 'active'/);
});

test("goal state and profile hints are removed when their feature flags are off", async () => {
  // Флаги режут состояние целей и подсказку профиля при сборке, а не при
  // упаковке: в блок не попадает то, чего в контексте нет.
  const builder = new RuntimeContextBuilder(
    {
      query: async () => ({
        rows: [{
          ...CONTEXT_ROW,
          active_goal_title: "Цель", next_result_title: "Результат", next_action: "Шаг",
          profile_field_key: "city", profile_title: "Город",
          profile_prompt_hint: "Скрытая подсказка", profile_status: "unknown",
        }],
      }),
    } as never,
    {
      defaultTimezone: "UTC",
      profileCompletionEnabled: false,
      vectorGoalsEnabled: false,
      now: () => new Date("2026-07-29T12:00:00Z"),
    },
  );
  const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "Привет" });
  const prompt = builder.wrapUserMessage(context, "Привет");
  assert.doesNotMatch(prompt, /active_goal|next_result|next_step/);
  assert.doesNotMatch(prompt, /Скрытая подсказка/);
  // Курсор программ живёт под тем же флагом, что и цели: выключены цели —
  // выключена и программа, а не половина состояния.
  assert.equal(context.activeProgram, null);
  assert.doesNotMatch(prompt, /active_program/);
});

test("cron supports wildcards, ranges, steps and Sunday alias", () => {
  assert.equal(cronFieldMatches("*/15", 30, 0, 59), true);
  assert.equal(cronFieldMatches("*/15", 31, 0, 59), false);
  assert.equal(cronFieldMatches("1-5", 4, 0, 7, true), true);
  assert.equal(cronFieldMatches("7", 0, 0, 7, true), true);
  assert.equal(cronFieldMatches("1,3,5", 2, 0, 7), false);
});

test("next cron date respects an IANA timezone", () => {
  const next = nextCronDate("0 9 * * *", "Asia/Yekaterinburg", new Date("2026-07-29T02:00:00Z"));
  assert.equal(next.toISOString(), "2026-07-29T04:00:00.000Z");
});

test("new Eva agents receive the structured memory blueprint", () => {
  const blocks = evaMemoryBlocks();
  assert.deepEqual(
    blocks.map((block) => block.label),
    [
      "persona",
      "human",
      "current_state",
      "therapeutic_framework",
    ],
  );
  assert.equal(blocks.length, 4);
  assert.equal(blocks.some((block) => block.label === "tools"), false);
  // Рамка работы всегда в контексте: она нужна раньше, чем Ева решит,
  // какой Skill открыть.
  const framework = blocks.find((block) => block.label === "therapeutic_framework")!;
  assert.match(framework.value, /AUTO/);
  assert.match(framework.value, /гипотез|Skill/i);
});

test("рамка работы различает устойчивую цель работы и цель одного ответа", () => {
  const framework = evaMemoryBlocks()
    .find((block) => block.label === "therapeutic_framework")!;
  // Проверяется поведенческий инвариант, а не формулировка: без этой
  // пары слабая модель считает целью последнюю реплику человека.
  assert.match(framework.value, /ACTIVE OBJECTIVE/);
  assert.match(framework.value, /TURN OBJECTIVE/);
  // Незакрытая работа, временный переход и уважение паузы.
  assert.match(framework.value, /ACTIVE WORK/);
  assert.match(framework.value, /return_to/);
  assert.match(framework.value, /paused/);
  assert.ok(
    framework.value.length <= (framework.limit ?? Number.POSITIVE_INFINITY),
    "рамка не помещается в собственный предел блока",
  );
  // Место чекпойнта — current_state, а не пятый обязательный блок.
  const current = evaMemoryBlocks().find((block) => block.label === "current_state")!;
  assert.match(String(current.description), /ACTIVE WORK/);
});

test("непрерывность не заводит пятый обязательный блок и не выбрасывает чужие", () => {
  // Инвариант — вложенность, а не равенство: ядро обязано присутствовать,
  // но дополнительные и общие блоки Letta остаются как есть.
  const labels = new Set(evaMemoryBlocks().map((block) => block.label));
  assert.equal(labels.size, 4);
  assert.equal(labels.has("active_work"), false);

  const withExtras = ensureCoreMemoryBlocks(
    [
      { label: "project", value: "чужой блок" },
      { label: "human", value: "известное" },
      { label: "shared_notes", value: "общий блок" },
    ],
    "персона",
    "человек",
  );
  const kept = withExtras.map((block) => block.label);
  for (const core of ["persona", "human", "current_state", "therapeutic_framework"]) {
    assert.ok(kept.includes(core), `${core} отсутствует`);
  }
  assert.ok(kept.includes("project"));
  assert.ok(kept.includes("shared_notes"));
  assert.equal(
    withExtras.find((block) => block.label === "human")?.value,
    "известное",
    "существующее значение блока не подменяется стартовым",
  );
});

function toolFactory() {
  return new AgentToolFactory(
    { searxngUrl: "http://search" } as never,
    {} as never,
    {} as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
}

test("Agent SDK registers every migrated external tool", () => {
  const names = new Set(
    toolFactory().forConversation("conversation-1").map((tool) => tool.name),
  );
  for (const expected of [
    "save_note",
    "get_notes",
    "save_budget_record",
    "get_budget_records",
    "save_task",
    "get_tasks",
    "set_reaction",
    "web_search",
    "PERPLEXITY_SEARCH",
    "get_goal_context",
    "upsert_goal",
    "confirm_goal",
    "upsert_goal_result",
    "record_work_block",
    "record_goal_review",
  ]) {
    assert.equal(names.has(expected), true, `${expected} is not registered`);
  }
});

test("задачи и напоминания Евы — единственная система задач", () => {
  // Todoist был вторым списком задач поверх собственного: выключен по
  // умолчанию, дублировал save_task/get_tasks и приносил девять
  // инструментов, включая удаление всех задач разом.
  const names = new Set(toolFactory().forConversation("c").map((tool) => tool.name));
  for (const own of ["save_task", "get_tasks", "update_task", "delete_tasks"]) {
    assert.equal(names.has(own), true, own);
  }
  assert.equal([...names].some((name) => name.startsWith("TODOIST_")), false);
});

test("cron lookups stay fast for sparse expressions", () => {
  // A naive minute-by-minute scan that rebuilds an Intl.DateTimeFormat each
  // step took ~45 s for this expression and blocked the whole event loop —
  // reachable from save_task with any cron the model chose.
  const started = Date.now();
  const next = nextCronDate("0 0 1 1 *", "Europe/Amsterdam", new Date("2026-02-01T00:00:00Z"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `sparse cron search took ${elapsed} ms`);
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(next);
  assert.match(local, /^01\/01, 00:00$/);
});

test("an impossible cron fails fast instead of scanning a year", () => {
  const started = Date.now();
  assert.throws(() => nextCronDate("0 0 30 2 *", "UTC", new Date("2026-02-01T00:00:00Z")));
  assert.ok(Date.now() - started < 1_000, "an impossible cron must not spin");
});

test("assertCronExpression rejects what the scheduler could never run", () => {
  assert.throws(() => assertCronExpression("0 0 30 2 *", "UTC"), /запуск|поле/);
  assert.throws(() => assertCronExpression("0 0 *", "UTC"), /пять полей/);
  assert.throws(() => assertCronExpression("99 * * * *", "UTC"), /поле/);
  assert.throws(() => assertCronExpression("0 9 * * *", "Mars/Olympus"));
  assert.doesNotThrow(() => assertCronExpression("0 9 * * 1-5", "Europe/Amsterdam"));
  assert.doesNotThrow(() => assertCronExpression("*/15 * * * *", "UTC"));
});

test("cron results are stable across a DST transition", () => {
  // Europe/Amsterdam moves the clock on 2026-03-29; a 09:00 local job must
  // stay at 09:00 local rather than drifting an hour.
  const before = nextCronDate("0 9 * * *", "Europe/Amsterdam", new Date("2026-03-20T12:00:00Z"));
  const after = nextCronDate("0 9 * * *", "Europe/Amsterdam", new Date("2026-03-29T12:00:00Z"));
  const local = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(date);
  assert.equal(local(before), "09:00");
  assert.equal(local(after), "09:00");
  // …and the underlying UTC instants really do differ by the DST offset:
  // 08:00 UTC under CET before the switch, 07:00 UTC under CEST after it.
  assert.equal(before.getUTCHours(), 8);
  assert.equal(after.getUTCHours(), 7);
});

const CONTEXT_ROW = {
  user_id: "1", telegram_id: "2", language_code: "ru", language_mode: "fixed",
  preferred_language: "ru", last_message_language: "ru", timezone: "Asia/Yekaterinburg",
  city: null, country_code: null, agent_id: "a", conversation_id: "c", purpose: "chat",
  response_mode: "text", use_emoji: false, communication_style: null,
  profile_field_key: null, profile_title: null, profile_prompt_hint: null, profile_status: null,
  active_goal_title: null, next_result_title: null, next_action: null, llm_quality_mode: "auto",
  program_key: null, program_version: null, program_phase_key: null,
  program_step_key: null, program_next_step_key: null,
  program_next_action_hint: null, program_resume_policy: null,
};

function contextBuilder(now: Date) {
  return new RuntimeContextBuilder(
    { query: async () => ({ rows: [{ ...CONTEXT_ROW }] }) } as never,
    { defaultTimezone: "UTC", profileCompletionEnabled: false, vectorGoalsEnabled: false, now: () => now },
  );
}

test("ход знает день недели и промежуток с прошлого сообщения человека", async () => {
  // Человек написал «пошёл делать» и через девять секунд «сделал». Без
  // промежутка модель достраивает время по смыслу слов и спрашивает,
  // как всё прошло, будто прошёл вечер.
  const now = new Date("2026-08-14T12:00:09Z");
  const builder = contextBuilder(now);
  const context = await builder.build({
    userId: 1, conversationId: "c", userMessage: "сделал",
    previousUserMessageAt: new Date("2026-08-14T12:00:00Z"),
  });

  assert.equal(context.localDate, "пятница, 14 августа 2026");
  assert.equal(context.sincePreviousMessage, "9 секунд");
  const prompt = builder.wrapUserMessage(context, "сделал");
  assert.match(prompt, /local_date: пятница, 14 августа 2026/);
  assert.match(prompt, /since_previous_user_message: 9 секунд/);
  // Промежутка одного мало: «девять секунд» модель читает как оценку и
  // рассуждает от неё вольно. Две отметки на часах — это две точки, и
  // помещается между ними поездка или нет, видно без арифметики.
  assert.equal(context.previousMessageLocalTime, "14 августа, 17:00");
  assert.equal(context.sincePreviousMessageSeconds, 9);
  assert.match(prompt, /previous_user_message_local_time: 14 августа, 17:00/);
  assert.match(prompt, /since_previous_user_message_seconds: 9/);
  // Что делать с промежутком, Ева знает из персоны — в ходе только факт.
  assert.doesNotMatch(prompt, /since_previous_user_message_note/);
});

test("первое сообщение промежутка не выдумывает", async () => {
  const builder = contextBuilder(new Date("2026-08-14T12:00:00Z"));
  const context = await builder.build({
    userId: 1, conversationId: "c", userMessage: "привет", previousUserMessageAt: null,
  });
  assert.equal(context.sincePreviousMessage, null);
  assert.equal(context.previousMessageLocalTime, null);
  assert.equal(context.sincePreviousMessageSeconds, null);
  const prompt = builder.wrapUserMessage(context, "привет");
  assert.doesNotMatch(prompt, /since_previous_user_message/);
  assert.doesNotMatch(prompt, /previous_user_message_local_time/);
});

test("длинные промежутки называются старшими единицами", async () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const cases: Array<[string, string]> = [
    ["2026-08-14T10:45:00Z", "1 час 15 минут"],
    ["2026-08-11T10:00:00Z", "3 дня 2 часа"],
    ["2026-08-14T11:59:59.5Z", "меньше секунды"],
  ];
  for (const [previous, expected] of cases) {
    const context = await contextBuilder(now).build({
      userId: 1, conversationId: "c", userMessage: "я вернулся",
      previousUserMessageAt: new Date(previous),
    });
    assert.equal(context.sincePreviousMessage, expected, previous);
  }
});

test("постоянные правила не приходят с каждым сообщением", async () => {
  // Женский род, форма ответа, разметка Telegram и протокол целей — это
  // то, кто Ева и как она пишет. Оно живёт в персоне и попадает в
  // контекст один раз, а не с каждым ходом.
  const builder = contextBuilder(new Date("2026-08-14T12:00:00Z"));
  const russian = await builder.build({ userId: 1, conversationId: "c", userMessage: "привет" });
  const prompt = builder.wrapUserMessage(russian, "привет");
  for (const standing of [
    /self_reference/, /output_protocol/, /formatting:/, /layout:/, /reactions:/,
    /vector_protocol/, /«поняла»/,
  ]) {
    assert.doesNotMatch(prompt, standing, String(standing));
  }
  const block = /<EVA_RUNTIME_CONTEXT>\n([\s\S]*?)\n<\/EVA_RUNTIME_CONTEXT>/.exec(prompt)?.[1] ?? "";
  assert.ok(block.length <= 1_500, `служебный блок разросся до ${block.length} символов`);
});

test("остаток до напоминания считает сервер, а не модель", async () => {
  // Ева говорила «до будильника пять с половиной часов», когда до него
  // оставалось три с половиной: остаток она считала в уме. Теперь и
  // момент, и остаток приходят готовыми.
  const now = new Date("2026-08-15T00:56:00+05:00");
  const builder = new RuntimeContextBuilder(
    {
      query: async (sql: string) => sql.includes("FROM tasks")
        ? { rows: [{ title: "Выехать в Пермь", scheduled_at: new Date("2026-08-15T04:30:00+05:00") }] }
        : { rows: [{ ...CONTEXT_ROW }] },
    } as never,
    { defaultTimezone: "UTC", profileCompletionEnabled: false, vectorGoalsEnabled: false, now: () => now },
  );
  const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "убрался в гараже" });

  assert.deepEqual(context.upcomingReminders, ["15 августа, 04:30 (через 3 часа 34 минуты): «Выехать в Пермь»"]);
  const prompt = builder.wrapUserMessage(context, "убрался в гараже");
  assert.match(prompt, /upcoming_reminders:/);
  assert.match(prompt, /через 3 часа 34 минуты/);
  // Само правило «не пересчитывай» постоянное и живёт в персоне.
  assert.doesNotMatch(prompt, /upcoming_reminders_note/);
});

test("сообщение о сделанном сверяется с промежутком, а не принимается на веру", async () => {
  const builder = contextBuilder(new Date("2026-08-15T00:20:40+05:00"));
  const context = await builder.build({
    userId: 1, conversationId: "c", userMessage: "все помыл",
    previousUserMessageAt: new Date("2026-08-15T00:20:10+05:00"),
  });
  assert.equal(context.sincePreviousMessage, "30 секунд");
  const prompt = builder.wrapUserMessage(context, "все помыл");
  // В ход приходит факт; правило сверки — постоянное, оно в персоне.
  assert.match(prompt, /since_previous_user_message: 30 секунд/);
});

/**
 * Плавность показа — это «мельче и чаще», а не «медленнее».
 *
 * Прежде за раз появлялось до пятнадцати слов раз в 800 мс: строка
 * возникала вспышкой, и текст прыгал вместо того, чтобы течь.
 */
test("шаг показа мельче строки и не растёт со временем", () => {
  // Первые правки короче: начало ответа — тот момент, который и
  // читается «резко», когда только что было пусто.
  assert.equal(liveStepWords(0), 5);
  assert.equal(liveStepWords(1), 9);
  // Дальше — обычный темп, и он постоянный: рывки модели не должны
  // становиться рывками показа.
  for (const updates of [2, 3, 10, 100]) {
    assert.equal(liveStepWords(updates), 14, `правка ${updates}`);
  }
});

test("шаг остаётся заметно меньше прежних пятнадцати слов", () => {
  // Ради этого всё и делалось: кусок не должен быть целой строкой.
  const steps = [0, 1, 2, 5, 50].map(liveStepWords);
  assert.ok(Math.max(...steps) < 15, `шаг вырос до ${Math.max(...steps)}`);
  assert.ok(Math.min(...steps) >= 3, "слишком мелкий шаг — это уже посимвольная печать");
});

test("adaptive live prefix keeps words, links and code intact", () => {
  const words = Array.from({ length: 30 }, (_, index) => `слово${index + 1}`).join(" ");
  const prefix = nextLivePrefix("", words, 8);
  assert.equal(prefix.split(/\s+/u).length, 8);
  assert.ok(words.startsWith(prefix));
  assert.equal(nextLivePrefix("", "До [ссылки с пробелом](https://example.test/a) после", 2),
    "До [ссылки с пробелом](https://example.test/a)");
  assert.equal(nextLivePrefix("", "До `кода с пробелом` после", 2),
    "До `кода с пробелом`");
});

/**
 * Что продуктовый слой отдаёт Letta.
 *
 * Регистрация инструментов — единственное, чем Evaself участвует в их
 * наборе: выбирает и вызывает их Letta. Поэтому проверяется наличие
 * инструмента и его ответ, а не то, когда он будет вызван.
 */
test("продуктовые инструменты зарегистрированы и отвечают", async () => {
  const runtime = {
    userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-1",
    purpose: "chat" as const, timezone: "Europe/Amsterdam",
    responseMode: "text" as const, useEmoji: true,
  };
  const db = {
    getAgentRuntimeContext: async () => runtime,
    getQuotaStatus: async () => [],
    incrementUsage: async () => 0,
    query: async () => ({ rows: [], rowCount: 0 }),
    withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    transaction: async <T>(work: (client: unknown) => Promise<T>) =>
      await work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const factory = new AgentToolFactory(
    { searxngUrl: "http://search", vectorGoalsEnabled: true } as never,
    db as never, { setReaction: async () => {} } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const tools = new Map(factory.forConversation("conv-1").map((tool) => [tool.name, tool]));

  // Продуктовые области, которые Ева обслуживает своими инструментами.
  for (const name of [
    "save_task", "get_tasks", "upsert_goal", "confirm_goal",
    "upsert_user_profile_field", "get_user_time_context",
    "get_psychological_test_results", "update_response_mode",
    // Путь в интернет целиком: найти адреса и прочитать страницу.
    "web_search", "web_read",
  ]) {
    assert.ok(tools.has(name), `инструмент ${name} не зарегистрирован`);
  }

  // Часовой пояс — продуктовые данные, и Ева берёт их отсюда, а не из
  // собственных представлений о времени.
  const time = await tools.get("get_user_time_context")!.execute("call-1", {});
  const timeDetails = time.details as { timezone: string; local_date: string };
  assert.equal(timeDetails.timezone, "Europe/Amsterdam");
  assert.match(timeDetails.local_date, /^\d{4}-\d{2}-\d{2}$/);

  // Психометрия ещё не подключена: заглушка честно говорит об этом и не
  // придумывает результатов.
  const tests = await tools.get("get_psychological_test_results")!.execute("call-2", {});
  assert.deepEqual(tests.details, { status: "not_implemented", results: [] });
});

/** Навыки лежат там, где их находит нативный механизм Letta. */
test("психологические навыки доступны нативному механизму Letta", async (context) => {
  const { EVA_PROJECT_SKILLS, readProjectSkills } = await import("../dist/letta/skills-audit.js");
  // Образ сервиса каталога навыков не несёт: он монтируется отдельно.
  // Проверять там нечего, и выдавать это за проверку нельзя.
  const found = await readProjectSkills(new URL("../../skills/", import.meta.url).pathname);
  if (!found.available) {
    context.skip("каталог навыков вне образа сервиса; проверяется на репозитории");
    return;
  }
  // Тот же разбор, что использует самопроверка рантайма: второй сканер
  // каталога разошёлся бы с первым на первом же изменении.
  assert.deepEqual(found.problems, [], "навык без name или description нативный механизм не откроет");
  const names = new Set(found.skills.map((entry) => entry.name));
  for (const required of EVA_PROJECT_SKILLS) {
    assert.ok(names.has(required), `навык ${required} отсутствует`);
  }
});

test("психологические навыки доступны нативному механизму Letta", async (context) => {
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../../skills/", import.meta.url);
  // Образ сервиса каталога навыков не несёт: он монтируется в App Server
  // отдельно. Проверять там нечего, и выдавать это за проверку нельзя.
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    context.skip("каталог навыков вне образа сервиса; проверяется на репозитории");
    return;
  }
  for (const required of [
    "therapeutic-conversation", "cbt", "act", "motivational-interviewing",
    "schema-therapy", "emotion-regulation", "behavioral-activation",
    "relationships-boundaries", "goals-values", "journaling-reflection",
    "memory-hygiene", "subscription-status", "crisis-response",
  ]) {
    assert.ok(entries.includes(required), `навык ${required} отсутствует`);
  }

  // Нативный механизм читает frontmatter: без `name` и `description`
  // навык не будет ни найден, ни открыт.
  for (const name of entries) {
    const body = await readFile(new URL(`${name}/SKILL.md`, root), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(body);
    assert.ok(frontmatter, `${name}: нет frontmatter`);
    assert.match(frontmatter[1]!, /^name: .+$/mu, `${name}: нет name`);
    assert.match(frontmatter[1]!, /^description: .+$/mu, `${name}: нет description`);
  }
});

/**
 * Размер служебного блока — наблюдаемая величина, а не обещание.
 *
 * Возврат prompt middleware выглядит одинаково с любой формулировкой в
 * документации: постоянные правила снова оказываются в каждом ходе.
 * Число видно сразу — p95 и счётчик ходов, подошедших к потолку.
 */
test("размер служебного блока измеряется и виден в метриках", async () => {
  const {
    RUNTIME_CONTEXT_CEILING, recordRuntimeContextSize, runtimeContextSizeStats,
  } = await import("../dist/runtime/runtime-context.js");

  assert.ok(RUNTIME_CONTEXT_CEILING >= 1_500 && RUNTIME_CONTEXT_CEILING <= 2_000,
    `потолок ${RUNTIME_CONTEXT_CEILING} вне 1500–2000`);

  const before = runtimeContextSizeStats();
  for (const size of [400, 450, 500, 460, 470]) recordRuntimeContextSize(size);
  const after = runtimeContextSizeStats();
  assert.equal(after.samples, before.samples + 5);
  // Окно общее на процесс: в нём уже лежат размеры блоков, собранных
  // выше по файлу. Проверяется поведение окна, а не конкретные числа.
  assert.ok(after.p50 > 0, `p50 ${after.p50}`);
  assert.ok(after.p95 >= after.p50, `p95 ${after.p95} < p50 ${after.p50}`);
  assert.ok(after.max >= 500, `max ${after.max}`);
  assert.equal(after.nearCeilingTotal, before.nearCeilingTotal);

  // Ход, подошедший к потолку, обязан быть посчитан: это сигнал, что в
  // контекст снова тащат постоянные правила.
  recordRuntimeContextSize(RUNTIME_CONTEXT_CEILING);
  assert.equal(runtimeContextSizeStats().nearCeilingTotal, before.nearCeilingTotal + 1);
});
