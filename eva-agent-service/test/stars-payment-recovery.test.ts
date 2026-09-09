/**
 * Восстановление платежей, которые прежний обработчик ошибочно пометил
 * завершёнными после отказа выдачи подписки.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresTelegramInbox } from "../dist/delivery/inbox.js";

test("неприменённые терминальные платежи возвращаются в durable очередь", async () => {
  const calls: Array<{
    sql: string;
    options?: { crossUser?: boolean };
  }> = [];
  const fake = {
    withSystemScope: async (
      _reason: string,
      work: () => Promise<unknown>,
      options?: { crossUser?: boolean },
    ) => {
      calls.push({ sql: "scope", options });
      return await work();
    },
    query: async (sql: string) => {
      calls.push({ sql });
      return { rows: [], rowCount: 2 };
    },
  };

  const recovered = await new PostgresTelegramInbox(fake as never)
    .recoverUnappliedStarPayments();

  assert.equal(recovered, 2);
  assert.equal(calls[0]?.options?.crossUser, true);
  const sql = calls[1]?.sql ?? "";
  assert.match(sql, /message_kind = 'payment'/u);
  assert.match(sql, /status = 'completed'/u);
  assert.doesNotMatch(sql, /'dead'/u);
  assert.match(sql, /telegram_payment_charge_id/u);
  assert.match(sql, /NOT EXISTS/u);
  assert.match(sql, /provider = 'telegram_stars'/u);
  assert.match(sql, /SET status = 'queued'/u);
});
