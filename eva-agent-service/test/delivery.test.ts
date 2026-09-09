import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TelegramInboxWorker,
  type InboxRecord,
  type InboxResult,
  type TelegramInbox,
} from "../dist/delivery/inbox.js";
import type { OutboxEnvelope } from "../dist/delivery/outbox.js";
import { TelegramApiError, TelegramClient, type TelegramUpdate } from "../dist/telegram.js";

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

test("delivery metrics separate outbox insert from Telegram send", async () => {
  const telegram = new TelegramClient({
    telegramBotToken: "fake",
    telegramApiBaseUrl: "https://api.telegram.invalid",
  } as never, logger);
  telegram.setOutbox({
    send: async (envelope) => {
      envelope.onMetrics?.({ outboxInsertMs: 1.5 });
      envelope.onMetrics?.({ telegramSendMs: 4.25 });
      return { ok: true };
    },
  });

  let metrics = { outboxInsertMs: 0, telegramSendMs: 0 };
  await telegram.withDeliveryContext("metric-test", async () => {
    await telegram.sendMessage(123, "готово");
    metrics = telegram.getDeliveryMetrics();
  });
  assert.deepEqual(metrics, { outboxInsertMs: 1.5, telegramSendMs: 4.25 });
});

test("delivery contexts assign command and crisis priority classes", async () => {
  const telegram = new TelegramClient({
    telegramBotToken: "fake",
    telegramApiBaseUrl: "https://api.telegram.invalid",
  } as never, logger);
  const envelopes: OutboxEnvelope[] = [];
  telegram.setOutbox({
    send: async (envelope) => { envelopes.push(envelope); return { queued: true }; },
  });

  await telegram.withDeliveryContext("telegram-command:1", async () => {
    await telegram.sendMessage(1, "command response");
  });
  await telegram.sendMessage(3, "crisis page", {}, "crisis");

  assert.deepEqual(envelopes.map((item) => item.priority), [
    "command", "crisis",
  ]);
});

test("typing stays queued while reactions use confirmed delivery", async () => {
  const telegram = new TelegramClient({
    telegramBotToken: "fake",
    telegramApiBaseUrl: "https://api.telegram.invalid",
  } as never, logger);
  const envelopes: OutboxEnvelope[] = [];
  const confirmed: OutboxEnvelope[] = [];
  telegram.setOutbox({
    send: async (envelope) => { envelopes.push(envelope); return { queued: true }; },
    sendConfirmed: async (envelope) => { confirmed.push(envelope); return true; },
  });

  await telegram.sendChatAction(7);
  await telegram.setReaction(7, 11, "👍");

  assert.deepEqual(envelopes.map((item) => [item.method, item.priority]), [["sendChatAction", "status"]]);
  assert.deepEqual(confirmed.map((item) => [item.method, item.priority]), [["setMessageReaction", "status"]]);
});

test("reaction and reply of one turn keep causal outbox order", async () => {
  const telegram = new TelegramClient({
    telegramBotToken: "fake",
    telegramApiBaseUrl: "https://api.telegram.invalid",
  } as never, logger);
  const envelopes: OutboxEnvelope[] = [];
  const order: string[] = [];
  telegram.setOutbox({
    send: async (envelope) => { envelopes.push(envelope); order.push(`queued:${envelope.method}`); return { queued: true }; },
    sendConfirmed: async (envelope) => { order.push(`confirmed:${envelope.method}`); return true; },
  });

  await telegram.withDeliveryContext("telegram-update:77", async () => {
    await telegram.setReaction(7, 11, "👍");
    await telegram.sendMessage(7, "reply");
  });

  assert.deepEqual(order, ["confirmed:setMessageReaction", "queued:sendMessage"]);
  assert.deepEqual(envelopes.map((item) => [item.method, item.priority, item.idempotencyKey]), [
    ["sendMessage", "reply", "telegram-update:77:001:sendMessage"],
  ]);
});

test("Telegram Retry-After is not mistaken for an HTML parse failure", async () => {
  const telegram = new TelegramClient({
    telegramBotToken: "fake",
    telegramApiBaseUrl: "https://api.telegram.invalid",
  } as never, logger);
  const envelopes: OutboxEnvelope[] = [];
  telegram.setOutbox({
    send: async (envelope) => {
      envelopes.push(envelope);
      throw new TelegramApiError("Telegram sendMessage: Too Many Requests", 2_000);
    },
  });

  await assert.rejects(
    () => telegram.sendMessage(7, "**formatted**"),
    (error: unknown) => error instanceof TelegramApiError && error.retryAfterMs === 2_000,
  );
  assert.equal(envelopes.length, 1, "429 must not trigger an immediate plain-text retry");
});

test("Telegram 400 preserves safe error_code and description", async () => {
  const telegram = new TelegramClient({
    telegramBotToken: "fake",
    telegramApiBaseUrl: "https://api.telegram.test",
  } as never, logger);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error_code: 400,
    description: "Bad Request: message can't be reacted",
  }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      () => telegram.call("setMessageReaction", {
        chat_id: 7,
        message_id: 11,
        reaction: [{ type: "emoji", emoji: "❤" }],
        is_big: false,
      }),
      (error: unknown) => error instanceof TelegramApiError
        && error.errorCode === 400
        && error.description === "Bad Request: message can't be reacted",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
