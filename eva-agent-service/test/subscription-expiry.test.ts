/**
 * Предупреждение о конце подписки.
 *
 * Подписка кончается тихо: доступ перестаёт работать, и человек узнаёт об
 * этом, упёршись в лимит посреди разговора. Проверяется здесь не то, что
 * сообщение отправляется, а то, что оно отправляется ровно один раз:
 * получить одно и то же предупреждение трижды хуже, чем не получить его
 * вовсе.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPIRY_NOTICE_DAYS,
  SubscriptionExpiryNotices,
} from "../dist/payments/expiry-notices.js";

/** Поддельная база, которая уважает отметку: без неё проверка пуста. */
function db(candidates: Array<Record<string, unknown>>) {
  const marked = new Set<string>();
  const asked: unknown[][] = [];
  return {
    marked,
    asked,
    db: {
      withSystemScope: async (_label: string, work: () => Promise<unknown>) => await work(),
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes("UPDATE subscriptions")) {
          const key = `${String(values[0])}:${String(values[1])}`;
          if (marked.has(key)) return { rows: [], rowCount: 0 };
          marked.add(key);
          return { rows: [], rowCount: 1 };
        }
        asked.push(values);
        return {
          rows: candidates.filter((row) => !marked.has(
            `${String(row.subscription_id)}:${String(row.days_left)}`,
          )),
        };
      },
    } as never,
  };
}

const candidate = (id: string, daysLeft: number) => ({
  subscription_id: id, user_id: "7", telegram_id: "42", chat_id: "42",
  plan: "plus", days_left: daysLeft,
});

test("предупреждают за три дня, за сутки и в день окончания", () => {
  assert.deepEqual([...EXPIRY_NOTICE_DAYS], [3, 1, 0]);
});

test("каждое предупреждение уходит ровно один раз", async () => {
  const sent: number[] = [];
  const fake = db([candidate("1", 3), candidate("2", 1), candidate("3", 0)]);
  const notices = new SubscriptionExpiryNotices({
    db: fake.db,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    notify: async ({ daysLeft }) => { sent.push(daysLeft); },
  });

  assert.deepEqual(await notices.run(), { sent: 3 });
  assert.deepEqual(sent.sort(), [0, 1, 3]);

  // Повторный проход — норма: планировщик тикает чаще, чем меняются
  // подписки. Второе сообщение человеку при этом не уходит.
  assert.deepEqual(await notices.run(), { sent: 0 });
  assert.equal(sent.length, 3, "повторное предупреждение ушло человеку");
});

test("выборка спрашивает только те дни, о которых предупреждаем", async () => {
  const fake = db([]);
  await new SubscriptionExpiryNotices({
    db: fake.db,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    notify: async () => undefined,
  }).run();
  assert.deepEqual(fake.asked[0]?.[0], [...EXPIRY_NOTICE_DAYS]);
});

test("недоставленное предупреждение не повторяется", async () => {
  // Отметка ставится до отправки намеренно: неудачная доставка обидна,
  // но три одинаковых сообщения подряд человек воспримет как поломку, а
  // о конце подписки узнает из следующего предупреждения или из лимита.
  const fake = db([candidate("1", 1)]);
  const notices = new SubscriptionExpiryNotices({
    db: fake.db,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    notify: async () => { throw new Error("Telegram недоступен"); },
  });
  assert.deepEqual(await notices.run(), { sent: 0 });
  assert.equal(fake.marked.size, 1, "отметка обязана остаться");
  assert.deepEqual(await notices.run(), { sent: 0 });
});
