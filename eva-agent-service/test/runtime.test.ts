import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { assertCronExpression, cronFieldMatches, nextCronDate } from "../dist/background.js";
import { formatVoiceTranscriptEcho, normalizeUpdate } from "../dist/eva-workflow.js";
import { evaMemoryBlocks } from "../dist/letta.js";
import { normalizeLavaEvent } from "../dist/payments.js";
import { RuntimeContextBuilder } from "../dist/runtime/runtime-context.js";

/**
 * Текст персоны или `null`, если каталог `library` вне образа сервиса.
 *
 * Персона монтируется в контейнер отдельно, а сборка образа её не
 * копирует: внутри сборки файла нет. Отсутствие файла — это «здесь
 * нечего проверять», а не провал проверки.
 */
async function personaText(): Promise<string | null> {
  try {
    return await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch {
    return null;
  }
}
import {
  progressiveTelegramDrafts,
  splitTelegramText,
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

test("Telegram progressive drafts reveal only complete words", () => {
  assert.deepEqual(
    progressiveTelegramDrafts("Тут, Виктор. Была пауза, но я на месте. Что нужно?", 4),
    [
      "Тут, Виктор. Была пауза,",
      "Тут, Виктор. Была пауза, но я на месте.",
    ],
  );
  assert.deepEqual(progressiveTelegramDrafts("Короткий ответ", 4), ["Короткий ответ"]);
});

test("Telegram starts an empty draft before an answer", async () => {
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

  const draft = await telegram.startMessageDraft(123);
  draft?.stop();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "sendMessageDraft");
  assert.equal(calls[0]?.body.chat_id, 123);
  assert.equal(calls[0]?.body.text, "");
  assert.equal(typeof calls[0]?.body.draft_id, "number");
});

/**
 * Черновик, догоняющий поток модели.
 *
 * Промежуточные состояния схлопываются, наружу уходит последнее, и чаще
 * заданного промежутка Telegram не трогается: обновление на каждый срез
 * выбрало бы лимит чата на первых секундах ответа и вернуло 429 уже на
 * доставке. Часы здесь виртуальные — проверяется правило, а не выдержка.
 */
test("потоковый черновик схлопывает срезы и держит промежуток", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (_method, body) => {
    calls.push(body);
    return true as never;
  };

  const clock = 1_000;
  const stream = telegram.startStreamingDraft(
    123,
    { chatId: 123, draftId: 7, stop() {} },
    { intervalMs: 1_000, now: () => clock },
  );

  stream.push("Понимаю");
  stream.push("Понимаю.");
  stream.push("Понимаю. Расскажи");
  await stream.finish();

  // Первый срез уходит сразу — ради него всё и затевалось: человек
  // видит начало ответа, не дожидаясь конца хода. Остальные схлопнулись
  // в одно состояние, и оно последнее.
  assert.deepEqual(calls.map((body) => body.text), ["Понимаю", "Понимаю. Расскажи"]);
  assert.equal(calls[0]?.draft_id, 7);
  assert.equal(stream.shown, "Понимаю. Расскажи");
  assert.equal(stream.updates, 2);
});

test("потоковый черновик досылает последнее состояние, не дожидаясь промежутка", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (_method, body) => {
    calls.push(body);
    return true as never;
  };

  const started = Date.now();
  const stream = telegram.startStreamingDraft(
    123,
    { chatId: 123, draftId: 9, stop() {} },
    { intervalMs: 60_000 },
  );
  stream.push("Первое состояние");
  await stream.finish();
  stream.push("после конца");
  await stream.finish();

  // Минута промежутка не задержала доставку: `finish` досылает сразу.
  assert.ok(Date.now() - started < 5_000, "досылка ждала промежутка");
  assert.deepEqual(calls.map((body) => body.text), ["Первое состояние"]);
});

/**
 * Пустой черновик держится собственным таймером и раз в двадцать секунд
 * пишет в тот же `draft_id` пустой текст. Пока показывать было нечего,
 * в этом и был весь смысл; с потоком он стирал бы показанное — и ровно
 * на длинных ходах, ради которых поток и сделан.
 */
test("потоковый черновик снимает пустой keepalive и держит показанный текст", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (_method, body) => {
    calls.push(body);
    return true as never;
  };

  // Настоящий черновик со своим таймером — та самая пара, которая и
  // сталкивалась в чате.
  const draft = await telegram.startMessageDraft(555);
  assert.ok(draft, "черновик не открылся");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.text, "", "первый черновик обязан быть пустым");

  const stream = telegram.startStreamingDraft(555, draft, { intervalMs: 0, keepAliveMs: 15 });
  stream.push("Первые слова ответа");
  await stream.finish();

  // Дальше keepalive повторяет показанное, а не пустоту.
  await new Promise((resolve) => setTimeout(resolve, 60));
  stream.stop();
  const empties = calls.slice(1).filter((body) => body.text === "");
  assert.deepEqual(empties, [], `пустой черновик стёр показанный текст: ${JSON.stringify(calls)}`);
  assert.equal(calls.at(-1)?.text, "Первые слова ответа");
});

test("остановленный показ не досылает срез после отмены хода", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let release: (() => void) | null = null;
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async (_method, body) => {
    calls.push(body);
    return true as never;
  };

  // Черновик резолвится не сразу: между решением отправить и самой
  // отправкой ход успевает отмениться.
  const opening = new Promise<{ chatId: number; draftId: number; stop(): void }>((resolve) => {
    release = () => resolve({ chatId: 555, draftId: 4, stop() {} });
  });
  const stream = telegram.startStreamingDraft(555, opening, { intervalMs: 0 });
  stream.push("недописанный ответ");
  stream.stop();
  release!();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls, [], `отменённый ход дописал черновик: ${JSON.stringify(calls)}`);
});

test("отказ Telegram на черновике не роняет ход", async () => {
  const telegram = new TelegramClient(
    { telegramBotToken: "test-token", telegramApiBaseUrl: "https://api.telegram.invalid" } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  telegram.call = async () => { throw new Error("429 Too Many Requests"); };

  const stream = telegram.startStreamingDraft(123, { chatId: 123, draftId: 3, stop() {} }, {
    intervalMs: 0,
  });
  stream.push("текст");
  // Показ — украшение: его отказ не должен прерывать ход, ответ уйдёт
  // обычным durable-сообщением.
  await stream.finish();
  assert.equal(stream.shown, "");
});

test("voice transcript echo matches Hermes and is sent without parse mode", async () => {
  assert.equal(
    formatVoiceTranscriptEcho("  проверь _точный_ текст  "),
    '🎙️ "проверь _точный_ текст"',
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

test("Lava webhook normalizer accepts the old nested shape", () => {
  const event = normalizeLavaEvent({
    eventType: "payment.success",
    product: { id: "plus-month" },
    buyer: { email: "owner@example.test" },
    invoice: { id: "inv-1", amount: 990, currency: "rub", status: "completed" },
    metadata: { telegram_id: "123" },
  });
  assert.equal(event.productId, "plus-month");
  assert.equal(event.paymentId, "inv-1");
  assert.equal(event.telegramId, 123);
  assert.equal(event.amountMinor, 99_000);
  assert.equal(event.currency, "RUB");
});

test("Lava webhook does not invent a successful status or reinterpret explicit minor units", () => {
  const event = normalizeLavaEvent({
    eventType: "payment.success",
    product: { id: "plus-month" },
    contractId: "contract-1",
    amount_minor: 99_000,
  });
  assert.equal(event.paymentId, "contract-1");
  assert.equal(event.amountMinor, 99_000);
  assert.equal(event.currency, "");
  assert.equal(event.status, "");
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
  // Что делать с промежутком, Ева знает из персоны — в ходе только факт.
  assert.doesNotMatch(prompt, /since_previous_user_message_note/);
});

test("первое сообщение промежутка не выдумывает", async () => {
  const builder = contextBuilder(new Date("2026-08-14T12:00:00Z"));
  const context = await builder.build({
    userId: 1, conversationId: "c", userMessage: "привет", previousUserMessageAt: null,
  });
  assert.equal(context.sincePreviousMessage, null);
  const prompt = builder.wrapUserMessage(context, "привет");
  assert.doesNotMatch(prompt, /since_previous_user_message/);
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

test("персона несёт то, что ушло из хода", async (context) => {
  // Образ сервиса каталога `library` не несёт: он монтируется отдельно.
  // Внутри сборки читать нечего, и выдавать это за проверку нельзя.
  const persona = await personaText();
  if (persona === null) {
    context.skip("персона вне образа сервиса; проверяется на репозитории");
    return;
  }
  for (const carried of [
    "женском роде", "set_reaction", "Telegram", "промежуток с прошлого сообщения",
    "goals-values",
  ]) {
    assert.ok(persona.includes(carried), `персона потеряла «${carried}»`);
  }
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
  const persona = await personaText();
  if (persona !== null) assert.ok(persona.includes("не подтверждай выполнение и не хвали"));
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
    "memory-hygiene", "crisis-response",
  ]) {
    assert.ok(entries.includes(required), `навык ${required} отсутствует`);
  }

  // Нативный механизм читает frontmatter: без `name` и `description`
  // навык не будет ни найден, ни открыт.
  for (const name of entries) {
    const body = await readFile(new URL(`${name}/SKILL.md`, root), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(body);
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
