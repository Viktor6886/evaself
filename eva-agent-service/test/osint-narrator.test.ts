/**
 * Итог OSINT-исследования рассказывает сама Ева.
 *
 * Служебный ход идёт в основном диалоге человека под его блокировкой;
 * в инструкции только id исследования — ни запроса, ни идентификаторов.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LettaOsintNarrator, osintCompletionInstruction } from "../dist/osint/narrator.js";

const ID = "0b7c2f5e-6a1d-4c3b-9e8f-1a2b3c4d5e6f";

function narrator(reply: string, link: { conversation_id: string | null; telegram_id: number } | null) {
  const calls: Record<string, unknown[]> = { query: [], lock: [], turn: [], build: [] };
  const db = {
    query: async (sql: string, values: unknown[]) => {
      calls.query.push({ sql, values });
      return { rows: link ? [link] : [] };
    },
  };
  const letta = {
    runTurn: async (conversationId: string, prompt: string) => {
      calls.turn.push({ conversationId, prompt });
      return { reply } as never;
    },
  };
  const runtimeContext = {
    build: async (input: unknown) => { calls.build.push(input); return {} as never; },
    wrapUserMessage: (_context: unknown, message: string, options: { internalOperationType?: string }) =>
      `${options.internalOperationType}|${message}`,
  };
  const lock = {
    run: async (telegramId: number, work: () => Promise<unknown>, claim: unknown) => {
      calls.lock.push({ telegramId, claim });
      return await work();
    },
  };
  return { calls, narrator: new LettaOsintNarrator(db as never, letta as never, runtimeContext as never, lock as never) };
}

test("инструкция называет только исследование и отчёт", () => {
  const text = osintCompletionInstruction(ID);
  assert.ok(text.includes(ID) && text.includes("osint_get_report"));
  assert.match(text, /Не сохраняй сведения о третьих лицах в память/);
  assert.match(text, /Не ставь напоминаний/);
});

test("пересказ — ход в основном диалоге под блокировкой человека", async () => {
  const { calls, narrator: subject } = narrator("  Нашла два профиля.  ", { conversation_id: "conv-chat", telegram_id: 777 });
  const text = await subject.narrate({ userId: 5, investigationId: ID, signal: new AbortController().signal });
  assert.equal(text, "Нашла два профиля.");
  const [query] = calls.query as Array<{ sql: string; values: unknown[] }>;
  assert.match(query!.sql, /a\.user_id = \$1/);
  assert.deepEqual(query!.values, [5]);
  assert.deepEqual(calls.lock, [{ telegramId: 777, claim: { userId: 5, conversationId: "conv-chat" } }]);
  const [turn] = calls.turn as Array<{ conversationId: string; prompt: string }>;
  assert.equal(turn!.conversationId, "conv-chat");
  assert.ok(turn!.prompt.startsWith("osint_report|[OSINT: ИССЛЕДОВАНИЕ ЗАВЕРШЕНО]"));
});

test("нет диалога или пустой ответ — пересказа нет, будет шаблон", async () => {
  const none = narrator("текст", null);
  assert.equal(await none.narrator.narrate({ userId: 5, investigationId: ID, signal: new AbortController().signal }), null);
  assert.equal(none.calls.turn.length, 0);
  const empty = narrator("   ", { conversation_id: "conv-chat", telegram_id: 777 });
  assert.equal(await empty.narrator.narrate({ userId: 5, investigationId: ID, signal: new AbortController().signal }), null);
});
