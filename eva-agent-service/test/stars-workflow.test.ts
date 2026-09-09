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

function workflow(apply: (input: never) => Promise<unknown>) {
  let lettaCalls = 0;
  /** Апдейты, дошедшие до тела хода: владельца им проставляет только оно. */
  const attached: number[] = [];
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
    attachTelegramUpdateToUser: async (updateId: number) => { attached.push(updateId); },
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
  return { instance, lettaCalls: () => lettaCalls, attached };
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

/**
 * Платёж в окне объединения.
 *
 * Окно отвечает на последнее сообщение, а предыдущие идут в тот же
 * промпт. Для платежа это означало потерю денег: оплата за секунду до
 * сообщения становилась «предыдущей репликой» и не применялась вовсе.
 */
const SECOND_PAYMENT = {
  ...UPDATE,
  update_id: 902,
  message: {
    ...UPDATE.message,
    message_id: 78,
    successful_payment: {
      ...UPDATE.message.successful_payment,
      invoice_payload: "66666666-7777-8888-9999-000000000000",
      telegram_payment_charge_id: "charge-902",
    },
  },
};

const TEXT_UPDATE = {
  update_id: 903,
  message: {
    message_id: 79,
    date: 1_777_777_800,
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false, language_code: "ru" },
    text: "спасибо, оплатил",
  },
};

test("два платежа в одном окне применяются оба", async () => {
  const applied: string[] = [];
  const { instance } = workflow(async (input: { chargeId: string }) => {
    applied.push(input.chargeId);
    return { state: "applied", plan: "plus", days: 30 };
  });

  assert.deepEqual(
    await instance.processAggregated([UPDATE, SECOND_PAYMENT]),
    { status: "completed" },
  );
  assert.deepEqual(applied, ["charge-901", "charge-902"]);
});

test("платёж перед сообщением не теряется, а сообщение доходит до разговора", async () => {
  const applied: string[] = [];
  const { instance, attached } = workflow(async (input: { chargeId: string }) => {
    applied.push(input.chargeId);
    return { state: "applied", plan: "plus", days: 30 };
  });

  // Разговорная половина хода требует полного стенда квот и Letta,
  // которого у этого набора нет: дальше владельца апдейта она не уходит.
  // Здесь важно другое — деньги приняты, и сообщение начало свой
  // собственный ход, а не растворилось в окне вместе с платежом.
  await assert.rejects(() => instance.processAggregated([UPDATE, TEXT_UPDATE]));
  assert.deepEqual(applied, ["charge-901"]);
  assert.ok(attached.includes(903), "сообщение после оплаты не начало своего хода");
});
