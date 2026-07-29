/**
 * The classifier is a triage signal for a human operator, so both directions
 * matter: a missed disclosure means nobody is paged, and a false positive at
 * 3am trains the operator to ignore the alerts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CrisisMonitor, detectCrisis, safetyDirective } from "../dist/crisis.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test("explicit suicidal intent is classified as critical", () => {
  for (const message of [
    "я хочу покончить с собой",
    "Я решил уйти из жизни",
    "i want to kill myself",
    "думаю про это давно, планирую умереть",
  ]) {
    const signal = detectCrisis(message);
    assert.ok(signal, `not detected: ${message}`);
    assert.equal(signal.severity, "critical", message);
  }
});

test("self-harm and passive ideation are high, not critical", () => {
  assert.equal(detectCrisis("я снова режу себя")?.severity, "high");
  assert.equal(detectCrisis("не хочу больше жить")?.severity, "high");
  assert.equal(detectCrisis("i don't want to live")?.severity, "high");
});

test("acute danger from someone else is recorded too", () => {
  assert.equal(detectCrisis("меня бьют дома")?.severity, "medium");
});

test("ordinary idiom and everyday complaints do not fire", () => {
  for (const message of [
    "убил весь день на этот отчёт",
    "я умираю от смеха",
    "эта задача меня убивает",
    "хочу убить время до поезда",
    "я так устал на работе, ничего не успеваю",
    "мне нужно закрыть счёты с банком",
    "посоветуй книгу про смысл жизни",
  ]) {
    assert.equal(detectCrisis(message), null, `false positive: ${message}`);
  }
});

test("empty and whitespace input is safe", () => {
  assert.equal(detectCrisis(""), null);
  assert.equal(detectCrisis("   \n "), null);
  assert.equal(detectCrisis(undefined as never), null);
});

test("the highest matching severity wins and markers are reported", () => {
  const signal = detectCrisis("не хочу жить, я решил покончить с собой");
  assert.equal(signal?.severity, "critical");
  assert.ok(signal.markers.length >= 2);
  assert.ok(signal.markers.includes("suicide_intent"));
});

test("the safety directive never leaks internal wording into the reply", () => {
  const directive = safetyDirective({ severity: "critical", markers: ["suicide_intent"] });
  assert.match(directive, /КОНТРОЛЬ БЕЗОПАСНОСТИ/);
  assert.match(directive, /экстренн/);
  // The marker names are operator vocabulary; they must not reach the model.
  assert.doesNotMatch(directive, /suicide_intent/);
});

/** Minimal fakes: only what CrisisMonitor actually touches. */
function harness(options: { insertFails?: boolean; ownerTelegramId?: number | null } = {}) {
  const inserted: unknown[][] = [];
  const sent: Array<{ chatId: number; text: string }> = [];
  const db = {
    query(_sql: string, values: unknown[] = []) {
      if (options.insertFails) throw new Error("db is down");
      inserted.push(values);
      return Promise.resolve({ rows: [{ id: "77" }] });
    },
  };
  const telegram = {
    sendMessage(chatId: number, text: string) {
      sent.push({ chatId, text });
      return Promise.resolve([]);
    },
  };
  const monitor = new CrisisMonitor(
    db as never,
    telegram as never,
    silentLogger,
    options.ownerTelegramId === undefined ? 555 : options.ownerTelegramId,
  );
  return { monitor, inserted, sent };
}

test("a critical signal is persisted and pages the owner", async () => {
  const { monitor, inserted, sent } = harness();
  const signal = await monitor.inspect({
    userId: 7,
    telegramId: 42,
    text: "я хочу покончить с собой",
  });

  assert.equal(signal?.severity, "critical");
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0]?.slice(0, 3), [7, "critical", "eva-runtime"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, 555);
  assert.match(sent[0]!.text, /critical/);
  assert.match(sent[0]!.text, /42/);
  // The person's own words stay in the database, not in a Telegram push.
  assert.doesNotMatch(sent[0]!.text, /покончить/);
});

test("a medium signal is recorded but does not wake the owner", async () => {
  const { monitor, inserted, sent } = harness();
  await monitor.inspect({ userId: 7, telegramId: 42, text: "меня бьют дома" });
  assert.equal(inserted.length, 1);
  assert.equal(sent.length, 0);
});

test("nothing is recorded when no rule matches", async () => {
  const { monitor, inserted, sent } = harness();
  assert.equal(await monitor.inspect({ userId: 7, telegramId: 42, text: "как дела?" }), null);
  assert.equal(inserted.length, 0);
  assert.equal(sent.length, 0);
});

test("a database failure still returns the signal and still pages", async () => {
  // The conversation must continue even when recording fails: a person in
  // crisis cannot be left without an answer because Postgres is down.
  const { monitor, sent } = harness({ insertFails: true });
  const signal = await monitor.inspect({
    userId: 7,
    telegramId: 42,
    text: "i want to kill myself",
  });
  assert.equal(signal?.severity, "critical");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /не записано/);
});

test("the owner is not paged about their own message", async () => {
  const { monitor, inserted, sent } = harness({ ownerTelegramId: 42 });
  await monitor.inspect({ userId: 7, telegramId: 42, text: "я хочу покончить с собой" });
  assert.equal(inserted.length, 1);
  assert.equal(sent.length, 0);
});

test("with no owner configured the event is still recorded", async () => {
  const { monitor, inserted, sent } = harness({ ownerTelegramId: null });
  await monitor.inspect({ userId: 7, telegramId: 42, text: "я хочу покончить с собой" });
  assert.equal(inserted.length, 1);
  assert.equal(sent.length, 0);
});
