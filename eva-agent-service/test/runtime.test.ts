import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { cronFieldMatches, nextCronDate } from "../dist/background.js";
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

test("Agent SDK registers every migrated external tool", () => {
  const factory = new AgentToolFactory(
    { searxngUrl: "http://search", todoistApiUrl: "https://api.todoist.test", todoistApiToken: "", todoistProjectId: "" } as never,
    {} as never,
    {} as never,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const names = new Set(factory.forConversation("conversation-1").map((tool) => tool.name));
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
