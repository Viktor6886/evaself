import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { assertCronExpression, cronFieldMatches, nextCronDate } from "../dist/background.js";
import { normalizeUpdate } from "../dist/eva-workflow.js";
import { evaMemoryBlocks } from "../dist/letta.js";
import { normalizeLavaEvent } from "../dist/payments.js";
import { RuntimeContextBuilder } from "../dist/runtime/runtime-context.js";
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
  assert.match(prompt, /vector_protocol/);
});

test("VECTOR and profile hints are removed when their feature flags are off", () => {
  const builder = new RuntimeContextBuilder({} as never, {
    defaultTimezone: "UTC",
    profileCompletionEnabled: false,
    vectorGoalsEnabled: false,
  });
  const prompt = builder.wrapUserMessage({
    userId: 1,
    telegramId: 1,
    agentId: "agent",
    conversationId: "conversation",
    purpose: "chat",
    localTime: "2026-07-29T12:00:00Z",
    timezone: "UTC",
    city: null,
    countryCode: null,
    responseLanguage: "ru",
    responseMode: "text",
    useEmoji: true,
    communicationStyle: null,
    profileHint: "Скрытая подсказка",
    activeGoal: "Цель",
    nextResult: "Результат",
    nextStep: "Шаг",
    relevantMemory: [],
  }, "Привет");
  assert.doesNotMatch(prompt, /vector_protocol/);
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
      "goals_and_commitments",
      "relationships_and_patterns",
      "progress_and_hypotheses",
    ],
  );
  assert.equal(blocks.length, 6);
  assert.equal(blocks.some((block) => block.label === "tools"), false);
});

function toolFactory(todoistApiToken = "") {
  return new AgentToolFactory(
    {
      searxngUrl: "http://search",
      todoistApiUrl: "https://api.todoist.test",
      todoistApiToken,
      todoistProjectId: "",
    } as never,
    {} as never,
    {} as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
}

test("Agent SDK registers every migrated external tool", () => {
  // Todoist tools are covered separately: they appear only with a token.
  const names = new Set(
    toolFactory("todoist-token").forConversation("conversation-1").map((tool) => tool.name),
  );
  for (const expected of [
    "save_note",
    "get_notes",
    "save_budget_record",
    "get_budget_records",
    "save_task",
    "save_task_to_nocodb",
    "get_tasks_from_nocodb",
    "set_reaction",
    "web_search",
    "PERPLEXITY_SEARCH",
    "LIGHTRAG_INSERT",
    "LIGHTRAG_QUERY",
    "TODOIST_CREATE_TASK",
    "TODOIST_UPDATE_TASK",
    "TODOIST_CLOSE_TASK",
    "TODOIST_DELETE_TASK",
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

test("Todoist tools appear only once a token is configured", () => {
  const without = new Set(toolFactory().forConversation("c").map((tool) => tool.name));
  const withToken = new Set(
    toolFactory("todoist-token").forConversation("c").map((tool) => tool.name),
  );
  for (const name of [
    "TODOIST_CREATE_TASK",
    "TODOIST_UPDATE_TASK",
    "TODOIST_CLOSE_TASK",
    "TODOIST_DELETE_TASK",
  ]) {
    // Advertising a tool that always fails on the first call only teaches
    // the model a dead end.
    assert.equal(without.has(name), false, `${name} must not be offered without a token`);
    assert.equal(withToken.has(name), true, `${name} must be offered with a token`);
  }
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
