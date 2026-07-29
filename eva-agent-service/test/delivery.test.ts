import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TelegramInboxWorker,
  type InboxRecord,
  type InboxResult,
  type TelegramInbox,
} from "../dist/delivery/inbox.js";
import type { OutboxEnvelope } from "../dist/delivery/outbox.js";
import { TelegramClient, type TelegramUpdate } from "../dist/telegram.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("inbox worker retries a failed update and then completes it", async () => {
  const update: TelegramUpdate = {
    update_id: 77,
    message: {
      message_id: 3,
      chat: { id: 10 },
      from: { id: 10, first_name: "Eva" },
      text: "hello",
    },
  };
  const states: string[] = [];
  let attempts = 0;
  let completed: InboxResult | null = null;
  const inbox: TelegramInbox = {
    enqueue: async () => ({ accepted: true, duplicate: false }),
    claim: async () => {
      if (completed || attempts >= 2) return null;
      attempts += 1;
      return {
        updateId: 77,
        payload: update,
        attempts,
        chatId: 10,
        telegramUserId: 10,
      };
    },
    complete: async (_id, result) => {
      completed = result;
      states.push("completed");
    },
    fail: async () => {
      states.push("retry");
      return { dead: false };
    },
  };
  let processorCalls = 0;
  const worker = new TelegramInboxWorker(
    inbox,
    async () => {
      processorCalls += 1;
      if (processorCalls === 1) throw new Error("temporary");
      return { status: "completed", usageCharged: true };
    },
    logger,
    { pollMs: 10_000, leaseSeconds: 30, maxAttempts: 3 },
  );

  await worker.tick();

  assert.equal(processorCalls, 2);
  assert.deepEqual(states, ["retry", "completed"]);
  assert.deepEqual(completed, { status: "completed", usageCharged: true });
});

test("inbox worker marks a poison update dead and notifies once", async () => {
  let claimed = false;
  let deadNotifications = 0;
  const record: InboxRecord = {
    updateId: 88,
    payload: { update_id: 88 },
    attempts: 5,
    chatId: null,
    telegramUserId: null,
  };
  const inbox: TelegramInbox = {
    enqueue: async () => ({ accepted: true, duplicate: false }),
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return record;
    },
    complete: async () => undefined,
    fail: async () => ({ dead: true }),
  };
  const worker = new TelegramInboxWorker(
    inbox,
    async () => {
      throw new Error("poison");
    },
    logger,
    {
      pollMs: 10_000,
      leaseSeconds: 30,
      maxAttempts: 5,
      onDead: async () => {
        deadNotifications += 1;
      },
    },
  );

  await worker.tick();
  await worker.tick();

  assert.equal(deadNotifications, 1);
});

test("Telegram replies get deterministic outbox keys for one durable update", async () => {
  const envelopes: OutboxEnvelope[] = [];
  const telegram = new TelegramClient({
    telegramBotToken: "not-used-by-the-fake-outbox",
    telegramApiBaseUrl: "https://api.telegram.invalid",
  } as never, logger);
  telegram.setOutbox({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { queued: true };
    },
  });

  await telegram.withDeliveryContext("telegram-update:42", async () => {
    await telegram.sendMessage(123, "one");
    await telegram.sendMessage(123, "two");
  });
  await telegram.withDeliveryContext("telegram-update:42", async () => {
    await telegram.sendMessage(123, "one");
    await telegram.sendMessage(123, "two");
  });

  assert.deepEqual(
    envelopes.map((item) => item.idempotencyKey),
    [
      "telegram-update:42:000:sendMessage",
      "telegram-update:42:001:sendMessage",
      "telegram-update:42:000:sendMessage",
      "telegram-update:42:001:sendMessage",
    ],
  );
});
