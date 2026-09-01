/**
 * Ева читает тариф, но не правит его.
 *
 * Человек спрашивает «сколько у меня осталось» в разговоре, и ответ
 * должен браться из базы, а не из памяти модели: названный по памяти
 * остаток человек проверит и не простит. При этом менять тариф, цену
 * или лимит инструмент не может — это решение владельца, а не модели.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CoreToolFactory } from "../dist/tools/core-tools.js";

/** Тот же построитель инструментов, что и в рантайме, только поменьше. */
const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({ name, label, description, parameters, execute });

function tools(rows: Array<Record<string, unknown>>, quotas: Array<Record<string, unknown>>) {
  const statements: string[] = [];
  const db = {
    withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    query: async (text: string) => { statements.push(text); return { rows }; },
    getQuotaStatus: async () => quotas,
  };
  const built = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: "/nonexistent" } as never,
    db as never,
    {} as never,
  ).build(tool as never);
  return { statements, list: built };
}

const runtime = { userId: 7, telegramId: 42, timezone: "Europe/Moscow" } as never;

test("инструмент отдаёт тариф, остаток и срок", async () => {
  const ends = new Date(Date.now() + 3 * 86_400_000);
  const { list } = tools(
    [{ plan: "plus", status: "active", current_period_end: ends }],
    [
      { metric: "messages", period: "day", limit_value: 500, used: 20, remaining: 480 },
      { metric: "voice_minutes", period: "day", limit_value: -1, used: 3, remaining: null },
    ],
  );
  const entry = list.find((item: { name: string }) => item.name === "get_subscription_status");
  assert.ok(entry, "инструмент не зарегистрирован");
  const result = await entry.execute({}, runtime) as Record<string, unknown>;
  assert.equal(result.plan, "plus");
  assert.equal(result.subscription_status, "active");
  assert.equal(result.days_left, 3, "дни считает сервер, а не модель");
  const limits = result.limits as Array<Record<string, unknown>>;
  assert.equal(limits.length, 2);
  // Безлимит — это null, а не ноль: перепутать их значит сказать
  // человеку, что у него ничего не осталось.
  assert.equal(limits[1]?.remaining, null);
});

test("без подписки — бесплатный тариф, а не пустота", async () => {
  const { list } = tools([], [{ metric: "messages", period: "day", limit_value: 10, used: 10, remaining: 0 }]);
  const entry = list.find((item: { name: string }) => item.name === "get_subscription_status");
  const result = await entry.execute({}, runtime) as Record<string, unknown>;
  assert.equal(result.plan, "free");
  assert.equal(result.subscription_status, "none");
  assert.equal(result.days_left, null);
});

test("инструмент ничего не меняет: только чтение", async () => {
  const { statements, list } = tools([], []);
  const entry = list.find((item: { name: string }) => item.name === "get_subscription_status");
  await entry.execute({}, runtime);
  for (const sql of statements) {
    assert.doesNotMatch(
      sql, /\b(INSERT|UPDATE|DELETE)\b/iu,
      "инструмент чтения не должен писать в базу",
    );
  }
});
