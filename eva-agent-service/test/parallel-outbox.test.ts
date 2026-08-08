/**
 * Параллельная доставка Telegram: приоритеты, порядок внутри чата,
 * лимиты и пауза, назначенная самим Telegram.
 *
 * Проверяется поведение, а не наличие полей: доставка запускается на
 * поддельной базе, повторяющей настоящие запросы, транспорт отвечает
 * 429 с `retry_after`, а порядок сообщений одного чата сверяется по
 * фактически отправленному.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresTelegramOutbox } from "../dist/delivery/outbox.js";
import { priorityOfMethod, PRIORITY_VALUE, priorityValue } from "../dist/delivery/priority.js";
import { parseRetryAfter, waitExceedsBudget, withJitter } from "../dist/delivery/retry-after.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------
// Приоритеты
// ---------------------------------------------------------------------

test("ступени очереди идут по убыванию важности", () => {
  const order = ["crisis", "reply", "command", "reminder", "status"] as const;
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(
      PRIORITY_VALUE[order[index - 1]!] < PRIORITY_VALUE[order[index]!],
      `${order[index - 1]} должен идти раньше ${order[index]}`,
    );
  }
});

test("служебные методы сами уходят в конец очереди, остальное — ответ человеку", () => {
  assert.equal(priorityOfMethod("sendChatAction"), "status");
  assert.equal(priorityOfMethod("setMessageReaction"), "status");
  assert.equal(priorityOfMethod("sendMessage"), "reply");
  assert.equal(priorityOfMethod("sendVoice"), "reply");
  // Явно названная ступень сильнее вывода по методу.
  assert.equal(priorityValue("crisis", "sendChatAction"), PRIORITY_VALUE.crisis);
});

// ---------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------

test("пауза читается из тела Telegram, из числа и из даты", () => {
  assert.equal(parseRetryAfter({ body: { parameters: { retry_after: 12 } } }), 12);
  assert.equal(parseRetryAfter({ body: { retry_after: "7" } }), 7);
  assert.equal(parseRetryAfter({ header: "120" }), 120);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(
    parseRetryAfter({ header: "Thu, 01 Jan 2026 00:00:30 GMT", now }),
    30,
    "HTTP-date не разобран",
  );
  // Отсутствие просьбы и просьба «ноль секунд» — разные ответы.
  assert.equal(parseRetryAfter({ body: { ok: false } }), null);
  assert.equal(parseRetryAfter({ body: { parameters: { retry_after: 0 } } }), 0);
  // Числовая форма проверяется раньше даты: «120» — это секунды.
  assert.notEqual(parseRetryAfter({ header: "120" }), null);
});

test("разброс только удлиняет паузу и не превращает её в ноль", () => {
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    const value = withJitter(10, 0.15, random);
    assert.ok(value >= 10, `пауза сократилась до ${value}`);
    assert.ok(value <= 11.5, `разброс слишком велик: ${value}`);
  }
  assert.equal(withJitter(0), 0);
});

test("слишком долгая пауза — повод идти к резерву", () => {
  assert.equal(waitExceedsBudget(31, 30), true);
  assert.equal(waitExceedsBudget(30, 30), false);
});

// ---------------------------------------------------------------------
// Поддельная база, повторяющая настоящие запросы outbox
// ---------------------------------------------------------------------

interface OutboxRecord {
  id: string;
  chat_id: string;
  telegram_method: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  priority: number;
  available_at: number;
  locked_by: string | null;
}

interface Probe {
  rows: OutboxRecord[];
  sent: Array<{ id: string; chat: string }>;
  now: number;
}

function outboxHarness(probe: Probe, options: Record<string, unknown> = {}) {
  const query = async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const text = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("UPDATE telegram_outbox SET status = 'dead'")) return { rows: [] };

    if (text.includes("SELECT t.id, t.telegram_method")) {
      const busy = new Set((values[3] as string[]).map(String));
      const ready = probe.rows.filter(
        (row) =>
          row.attempts < Number(values[1])
          && ["pending", "retry"].includes(row.status)
          && row.available_at <= probe.now
          && !busy.has(row.chat_id),
      );
      // Настоящий запрос не берёт строку, если у чата есть более раннее
      // незавершённое сообщение. Поддельный обязан вести себя так же —
      // иначе тест проверял бы подделку, а не порядок доставки.
      const eligible = ready.filter((row) =>
        !probe.rows.some(
          (earlier) =>
            earlier.chat_id === row.chat_id
            && ["pending", "sending", "retry"].includes(earlier.status)
            && (earlier.priority < row.priority
              || (earlier.priority === row.priority && Number(earlier.id) < Number(row.id))),
        ),
      );
      eligible.sort(
        (left, right) =>
          left.priority - right.priority
          || left.available_at - right.available_at
          || Number(left.id) - Number(right.id),
      );
      return { rows: eligible.slice(0, Number(values[2])) };
    }

    if (text.startsWith("UPDATE telegram_outbox SET status = 'sending'")) {
      for (const id of values[0] as string[]) {
        const row = probe.rows.find((item) => item.id === String(id));
        if (row) {
          row.status = "sending";
          row.attempts += 1;
          row.locked_by = String(values[1]);
        }
      }
      return { rows: [] };
    }

    if (text.startsWith("UPDATE telegram_outbox SET status = 'retry', attempts = GREATEST")) {
      const row = probe.rows.find((item) => item.id === String(values[0]));
      if (row && row.locked_by === String(values[2])) {
        row.status = "retry";
        row.attempts = Math.max(0, row.attempts - 1);
        row.available_at = probe.now + Number(values[1]) * 1000;
        row.locked_by = null;
      }
      return { rows: [] };
    }

    if (text.startsWith("UPDATE telegram_outbox SET status = 'sent'")) {
      const row = probe.rows.find((item) => item.id === String(values[0]));
      if (row) row.status = "sent";
      return { rows: [] };
    }

    if (text.startsWith("UPDATE telegram_outbox SET status = $2")) {
      const row = probe.rows.find((item) => item.id === String(values[0]));
      if (row) {
        row.status = String(values[1]);
        if (row.status === "retry") row.available_at = probe.now + Number(values[2]) * 1000;
        if (values[4] === true) row.attempts = Math.max(0, row.attempts - 1);
        row.locked_by = null;
      }
      return { rows: [] };
    }

    throw new Error(`поддельная база не знает запроса: ${text.slice(0, 60)}`);
  };

  const db = withTenantScopes({
    query,
    transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) =>
      await work({ query }),
  }) as never;

  const transport = {
    deliver: async (method: string, payload: Record<string, unknown>) => {
      const chat = String(payload.chat_id ?? "");
      const row = probe.rows.find(
        (item) => item.status === "sending" && item.chat_id === chat && item.telegram_method === method,
      );
      probe.sent.push({ id: row?.id ?? "?", chat });
      return { message_id: 1 };
    },
  };

  return new PostgresTelegramOutbox(db, transport as never, logger as never, {
    pollMs: 1000,
    leaseSeconds: 60,
    maxAttempts: 5,
    ...options,
  });
}

function row(partial: Partial<OutboxRecord> & { id: string; chat_id: string }): OutboxRecord {
  return {
    telegram_method: "sendMessage",
    payload: { chat_id: Number(partial.chat_id) },
    status: "pending",
    attempts: 0,
    priority: 20,
    available_at: 0,
    locked_by: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------
// Параллельная доставка
// ---------------------------------------------------------------------

test("сообщения разных чатов доставляются, порядок внутри чата сохраняется", async () => {
  const probe: Probe = {
    now: 1000,
    sent: [],
    rows: [
      row({ id: "1", chat_id: "100" }),
      row({ id: "2", chat_id: "100" }),
      row({ id: "3", chat_id: "100" }),
      row({ id: "4", chat_id: "200" }),
    ],
  };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 4, limits: null } });
  await outbox.tick();

  assert.equal(probe.sent.length, 4, "доставлено не всё");
  const chat100 = probe.sent.filter((item) => item.chat === "100").map((item) => item.id);
  assert.deepEqual(chat100, ["1", "2", "3"], "части одного ответа переставлены местами");
  assert.ok(probe.rows.every((item) => item.status === "sent"));
});

test("ошибка одной delivery не снимает concurrency guard, пока работают соседние", async () => {
  const probe: Probe = {
    now: 1000,
    sent: [],
    rows: [
      row({ id: "1", chat_id: "100" }),
      row({ id: "2", chat_id: "200" }),
      row({ id: "3", chat_id: "300" }),
    ],
  };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 2, limits: null } });
  let active = 0;
  let maximum = 0;
  let started = 0;
  const internal = outbox as unknown as {
    deliverGuarded: (record: OutboxRecord) => Promise<void>;
  };
  internal.deliverGuarded = async (record) => {
    active += 1;
    started += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, record.id === "1" ? 5 : 25));
      if (record.id === "1") throw new Error("database delivery failure");
    } finally {
      active -= 1;
      record.status = "sent";
    }
  };

  await outbox.tick();
  assert.equal(started, 3, "ошибка остановила разбор оставшейся очереди");
  assert.ok(maximum <= 2, `concurrency превышена: ${maximum}`);
  assert.equal(active, 0, "tick завершился раньше соседней delivery");
});

test("кризисное сообщение обгоняет очередь, служебное пропускает всех", async () => {
  const probe: Probe = {
    now: 1000,
    sent: [],
    rows: [
      row({ id: "1", chat_id: "100", priority: PRIORITY_VALUE.status }),
      row({ id: "2", chat_id: "100", priority: PRIORITY_VALUE.reminder }),
      row({ id: "3", chat_id: "100", priority: PRIORITY_VALUE.crisis }),
    ],
  };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 1, limits: null } });
  await outbox.tick();

  assert.deepEqual(
    probe.sent.map((item) => item.id),
    ["3", "2", "1"],
    "очередь разобрана не по приоритету",
  );
});

test("занятый лимит откладывает доставку и не тратит попытку", async () => {
  const probe: Probe = { now: 5000, sent: [], rows: [row({ id: "1", chat_id: "100" })] };
  const limits = {
    reserve: async () => 2000,
    penalize: async () => {},
  };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 2, limits } });
  await outbox.tick();

  const kept = probe.rows[0]!;
  assert.equal(probe.sent.length, 0, "сообщение ушло вопреки лимиту");
  assert.equal(kept.status, "retry");
  assert.equal(kept.attempts, 0, "лимит израсходовал попытку, хотя разговора с Telegram не было");
  assert.equal(kept.available_at, 7000, "пауза не учтена");
});

test("429 с retry_after откладывает доставку на названный срок и не тратит попытку", async () => {
  const probe: Probe = { now: 0, sent: [], rows: [row({ id: "1", chat_id: "100" })] };
  const paused: number[] = [];
  const limits = {
    reserve: async () => 0,
    penalize: async (_chat: number, milliseconds: number) => {
      paused.push(milliseconds);
    },
  };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 1, limits } });
  const internal = outbox as unknown as { transport: { deliver: () => Promise<unknown> } };
  internal.transport = {
    deliver: async () => {
      const error = new Error("Too Many Requests") as Error & { retryAfterMs?: number };
      error.retryAfterMs = 25_000;
      throw error;
    },
  };

  await outbox.tick();

  const kept = probe.rows[0]!;
  assert.equal(kept.status, "retry", "после 429 сообщение должно ждать, а не умирать");
  assert.equal(kept.attempts, 0, "429 израсходовал попытку, хотя Telegram не отказал, а назначил время");
  assert.ok(kept.available_at >= 25_000, `пауза короче назначенной: ${kept.available_at}`);
  assert.equal(paused.length, 1, "пауза не передана общему лимиту");
  assert.ok(paused[0]! >= 25_000, "общий limiter получил слишком короткую паузу");
});

test("исчерпанные попытки убивают сообщение, но 429 к ним не относится", async () => {
  const probe: Probe = {
    now: 0,
    sent: [],
    rows: [row({ id: "1", chat_id: "100", attempts: 4 })],
  };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 1, limits: null } });
  const internal = outbox as unknown as { transport: { deliver: () => Promise<unknown> } };
  internal.transport = {
    deliver: async () => {
      throw new Error("сеть недоступна");
    },
  };
  await outbox.tick();
  assert.equal(probe.rows[0]!.status, "dead", "последняя попытка не закрыла сообщение");
});

test("ошибка доставки не запускает повторный ход", async () => {
  // Ход и доставка разделены намеренно: outbox знает только про строку
  // и Telegram. Если бы он умел звать ход, отказ сети превращался бы в
  // повторный запрос к модели и второй ответ человеку.
  const probe: Probe = { now: 0, sent: [], rows: [row({ id: "1", chat_id: "100" })] };
  const outbox = outboxHarness(probe, { parallel: { concurrency: 1, limits: null } });
  const internal = outbox as unknown as {
    transport: { deliver: () => Promise<unknown> };
  };
  internal.transport = {
    deliver: async () => {
      throw new Error("Bad Gateway");
    },
  };
  await outbox.tick();

  const source = PostgresTelegramOutbox.toString();
  assert.ok(!/runTurn|eva-workflow|letta/i.test(source), "outbox знает о ходе");
  assert.equal(probe.rows[0]!.status, "retry");
  assert.equal(probe.sent.length, 0);
});
