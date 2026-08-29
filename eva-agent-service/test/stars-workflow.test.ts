/**
 * Состоявшийся платёж должен быть отдельной детерминированной операцией:
 * без Letta и с настоящим retry через durable inbox при отказе.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EvaWorkflow } from "../dist/eva-workflow.js";

const UPDATE = {
  update_id: 901,
  message: {
    message_id: 77,
    date: 1_777_777_777,
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false, language_code: "ru" },
    successful_payment: {
      currency: "XTR",
      total_amount: 1,
      invoice_payload: "11111111-2222-3333-4444-555555555555",
      telegram_payment_charge_id: "charge-901",
    },
  },
};

function workflow(apply: () => Promise<unknown>) {
  let lettaCalls = 0;
  const db = {
    withQueryMetrics: async (work: () => Promise<unknown>) => ({
      result: await work(), queryCount: 0,
    }),
    withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work(),
    upsertUser: async () => ({
      id: 7,
      language_code: "ru",
      language_mode: "auto",
      preferred_language: null,
      last_message_language: null,
      state: "active",
      is_blocked: false,
    }),
    bindScopeUserId() {},
    attachTelegramUpdateToUser: async () => {},
  };
  const telegram = {
    withDeliveryContext: async (_key: string, work: () => Promise<unknown>) => await work(),
    getDeliveryMetrics: () => ({ outboxInsertMs: 0, telegramSendMs: 0 }),
    sendMessage: async () => [],
  };
  const letta = {
    promptVersion: "test",
    findAgentByTelegramId: async () => { lettaCalls += 1; return null; },
  };
  const instance = new EvaWorkflow(
    { lockTtlSeconds: 60 } as never,
    db as never,
    letta as never,
    {} as never,
    { run: async (_id: number, work: () => Promise<unknown>) => await work() } as never,
    telegram as never,
    {} as never,
    {} as never,
    { debug() {}, info() {}, warn() {}, error() {} },
    undefined,
    undefined,
    undefined,
    undefined,
    { apply } as never,
  );
  return { instance, lettaCalls: () => lettaCalls };
}

test("ошибка выдачи подписки остаётся retryable и не зависит от Letta", async () => {
  const transient = new Error("database temporarily unavailable");
  const { instance, lettaCalls } = workflow(async () => { throw transient; });

  await assert.rejects(() => instance.processQueued(UPDATE), transient);
  assert.equal(lettaCalls(), 0, "платёж не должен открывать или синхронизировать агента");
});

test("успешный платёж завершается без обращения к Letta", async () => {
  const { instance, lettaCalls } = workflow(async () => ({
    state: "applied", plan: "plus", days: 30,
  }));

  assert.deepEqual(await instance.processQueued(UPDATE), { status: "completed" });
  assert.equal(lettaCalls(), 0);
});
