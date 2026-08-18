import assert from "node:assert/strict";
import test from "node:test";

import {
  batchSummary,
  messageBatchTiming,
  timelineDetail,
  timelineLines,
} from "../dist/turns/message-timeline.js";
import { RuntimeContextBuilder } from "../dist/runtime/runtime-context.js";

const CONTEXT_ROW = {
  user_id: "1", telegram_id: "2", language_code: "ru", language_mode: "fixed",
  preferred_language: "ru", last_message_language: "ru", timezone: "Asia/Yekaterinburg",
  city: null, country_code: null, agent_id: "a", conversation_id: "c", purpose: "chat",
  response_mode: "text", use_emoji: false, communication_style: null,
  profile_field_key: null, profile_title: null, profile_prompt_hint: null, profile_status: null,
  active_goal_title: null, next_result_title: null, next_action: null, llm_quality_mode: "auto",
};

function contextBuilder(now: Date, timezone = "Asia/Yekaterinburg") {
  return new RuntimeContextBuilder(
    { query: async () => ({ rows: [{ ...CONTEXT_ROW, timezone }] }) } as never,
    { defaultTimezone: "UTC", profileCompletionEnabled: false, vectorGoalsEnabled: false, now: () => now },
  );
}

/** Секунды epoch, как их присылает Telegram. */
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

test("секунда между сообщениями остаётся секундой, а не исчезает в окне", () => {
  // «пошли кушать» и через секунду «покушали». Пока окно отдавало одно
  // число — сколько сообщений, — эти две реплики выглядели как рассказ
  // о состоявшемся обеде.
  const batch = messageBatchTiming([
    { messageId: 11, date: at("2026-08-18T12:00:00Z") },
    { messageId: 12, date: at("2026-08-18T12:00:01Z") },
  ], new Date("2026-08-18T12:00:05Z"));

  assert.equal(batch.messages.length, 2);
  assert.equal(batch.messages[0]?.elapsedFromPreviousMs, null);
  assert.equal(batch.messages[1]?.elapsedFromPreviousMs, 1_000);
  assert.equal(batch.spanMs, 1_000);
  assert.equal(batchSummary(batch), "2 сообщения подряд, разброс — 1 секунда");
  assert.deepEqual(timelineLines(batch, "Asia/Yekaterinburg"), [
    "1 · 17:00:00 · начало серии",
    "2 · 17:00:01 · +1 секунда",
  ]);
});

test("получасовой промежуток внутри окна виден отдельной строкой", () => {
  const batch = messageBatchTiming([
    { messageId: 1, date: at("2026-08-18T09:00:00Z") },
    { messageId: 2, date: at("2026-08-18T09:30:00Z") },
  ], new Date("2026-08-18T09:30:01Z"));

  assert.equal(batch.messages[1]?.elapsedFromPreviousMs, 1_800_000);
  assert.equal(batch.spanMs, 1_800_000);
  assert.match(timelineLines(batch, "UTC")[1] ?? "", /\+30 минут/);
});

test("одно сообщение не описывается окном", () => {
  const batch = messageBatchTiming([{ messageId: 5, date: at("2026-08-18T09:00:00Z") }], new Date());
  assert.equal(batchSummary(batch), null);
  assert.deepEqual(timelineLines(batch, "UTC"), []);
  assert.equal(batch.spanMs, 0);
});

test("сообщение без отметки и отметка назад не ломают порядок", () => {
  const now = new Date("2026-08-18T09:00:10Z");
  const batch = messageBatchTiming([
    { messageId: 1, date: at("2026-08-18T09:00:05Z") },
    { messageId: 2 },
    { messageId: 3, date: at("2026-08-18T08:59:00Z") },
  ], now);

  assert.deepEqual(
    batch.messages.map((item) => item.elapsedFromPreviousMs),
    [null, 0, 0],
  );
  assert.equal(batch.lastAt.toISOString(), "2026-08-18T09:00:05.000Z");
});

test("запись окна в журнале хода несёт метаданные и ни слова текста", () => {
  const batch = messageBatchTiming([
    { messageId: 11, date: at("2026-08-18T12:00:00Z") },
    { messageId: 12, date: at("2026-08-18T12:00:01Z") },
  ], new Date("2026-08-18T12:00:02Z"));
  const detail = timelineDetail(batch);

  assert.equal(detail.messages, 2);
  assert.equal(detail.span_ms, 1_000);
  assert.deepEqual(detail.items, [
    { order: 1, message_id: 11, at: "2026-08-18T12:00:00.000Z", elapsed_from_previous_ms: null },
    { order: 2, message_id: 12, at: "2026-08-18T12:00:01.000Z", elapsed_from_previous_ms: 1_000 },
  ]);
  assert.doesNotMatch(JSON.stringify(detail), /кушать|text|caption/i);
});

test("ход видит окно сообщений и считает промежуток от отправки, а не от обработки", async () => {
  // Между отправкой и ходом стоит durable inbox: если считать от
  // момента обработки, промежуток растёт вместе с очередью.
  const builder = contextBuilder(new Date("2026-08-18T12:05:00Z"));
  const batch = messageBatchTiming([
    { messageId: 11, date: at("2026-08-18T12:00:00Z") },
    { messageId: 12, date: at("2026-08-18T12:00:01Z") },
  ], new Date("2026-08-18T12:05:00Z"));
  const context = await builder.build({
    userId: 1,
    conversationId: "c",
    userMessage: "покушали",
    previousUserMessageAt: new Date("2026-08-18T11:30:00Z"),
    currentMessageAt: batch.firstAt,
    messageBatch: batch,
  });

  assert.equal(context.sincePreviousMessage, "30 минут");
  assert.equal(context.messageBatch, "2 сообщения подряд, разброс — 1 секунда");
  const prompt = builder.wrapUserMessage(context, "пошли кушать\nпокушали");
  assert.match(prompt, /message_batch: 2 сообщения подряд, разброс — 1 секунда/);
  assert.match(prompt, /message_times:/);
  assert.match(prompt, /2 · 17:00:01 · \+1 секунда/);
});

test("ход называет день недели, месяц, год и то же мгновение в UTC", async () => {
  const builder = contextBuilder(new Date("2026-08-18T12:00:00Z"));
  const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "привет" });

  assert.equal(context.weekday, "вторник");
  assert.equal(context.month, "август");
  assert.equal(context.year, 2026);
  assert.equal(context.utcTime, "2026-08-18T12:00:00Z");
  assert.equal(context.localTime, "2026-08-18T17:00:00+05:00");
  const prompt = builder.wrapUserMessage(context, "привет");
  assert.match(prompt, /weekday: вторник/);
  assert.match(prompt, /month: август/);
  assert.match(prompt, /year: 2026/);
  assert.match(prompt, /utc_time: 2026-08-18T12:00:00Z/);
});

test("полночь и смена года считаются по местному времени человека", async () => {
  // В Екатеринбурге уже первое января, в UTC ещё тридцать первое
  // декабря. «Какой сегодня день» — вопрос про местное время.
  const builder = contextBuilder(new Date("2025-12-31T19:00:00Z"));
  const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "с новым годом" });

  assert.equal(context.localDate, "четверг, 1 января 2026");
  assert.equal(context.year, 2026);
  assert.equal(context.utcTime, "2025-12-31T19:00:00Z");
});

test("перевод стрелок меняет смещение, а не мгновение", async () => {
  // Второе воскресенье марта в Нью-Йорке: 01:59 EST и через две минуты
  // 03:01 EDT. Между отметками две минуты, а не час две.
  const before = contextBuilder(new Date("2026-03-08T06:59:00Z"), "America/New_York");
  const after = contextBuilder(new Date("2026-03-08T07:01:00Z"), "America/New_York");
  const contextBefore = await before.build({ userId: 1, conversationId: "c", userMessage: "до" });
  const contextAfter = await after.build({
    userId: 1,
    conversationId: "c",
    userMessage: "после",
    previousUserMessageAt: new Date("2026-03-08T06:59:00Z"),
    currentMessageAt: new Date("2026-03-08T07:01:00Z"),
  });

  assert.equal(contextBefore.localTime, "2026-03-08T01:59:00-05:00");
  assert.equal(contextAfter.localTime, "2026-03-08T03:01:00-04:00");
  assert.equal(contextAfter.sincePreviousMessage, "2 минуты");
  assert.equal(contextBefore.localDate, "воскресенье, 8 марта 2026");
  assert.equal(contextAfter.localDate, "воскресенье, 8 марта 2026");
});
