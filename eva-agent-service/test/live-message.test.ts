import assert from "node:assert/strict";
import test from "node:test";

import { LiveMessageWatch } from "../dist/turns/live-message.js";

/**
 * База, повторяющая настоящую строку приёма апдейта.
 *
 * Главное в ней — `user_id: null`. Внутренний пользователь при приёме
 * ещё не опознан, и запись хранит только `telegram_user_id`. Проверка,
 * искавшая по `user_id`, не совпадала никогда: уступка живому сообщению
 * не срабатывала ни разу с тех пор, как была написана.
 */
function inbox(rows: Array<Record<string, unknown>>) {
  const seen: Array<{ sql: string; values: unknown[] }> = [];
  return {
    seen,
    query: async (sql: string, values: unknown[] = []) => {
      seen.push({ sql, values });
      const [telegramId, statuses, since] = values as [number, string[], string];
      const matched = rows.filter((row) =>
        row.telegram_user_id === telegramId
        && statuses.includes(String(row.status))
        && new Date(String(row.received_at)) >= new Date(since));
      return { rows: matched, rowCount: matched.length };
    },
  };
}

const NOW = new Date("2026-09-06T21:00:00Z");
const LATER = new Date("2026-09-06T21:00:30Z");

test("непринятое сообщение видно по telegram_user_id, а не по user_id", async () => {
  const db = inbox([
    { update_id: 1, user_id: null, telegram_user_id: 77, status: "queued", received_at: LATER },
  ]);
  const watch = new LiveMessageWatch(db as never);
  assert.equal(await watch.waiting(77, NOW), true);
  // Ровно та ошибка, из-за которой уступка не работала: по `user_id`
  // строка не нашлась бы, потому что он пуст.
  assert.match(db.seen[0]!.sql, /telegram_user_id = \$1/);
  assert.doesNotMatch(db.seen[0]!.sql, /WHERE user_id/);
});

test("сообщение, уже взятое воркером, тоже считается ожидающим", async () => {
  // Так выглядит сообщение, которое стоит в очереди за блокировкой
  // нашего же фонового хода. Не считать его — значит не уступить тому,
  // кто ждёт дольше всех.
  const db = inbox([
    { user_id: null, telegram_user_id: 77, status: "processing", received_at: LATER },
  ]);
  assert.equal(await new LiveMessageWatch(db as never).waiting(77, NOW), true);
});

test("обработанное сообщение ожиданием не считается", async () => {
  const db = inbox([
    { user_id: null, telegram_user_id: 77, status: "completed", received_at: LATER },
  ]);
  assert.equal(await new LiveMessageWatch(db as never).waiting(77, NOW), false);
});

test("застрявшая строка прошлого не останавливает фоновую работу навсегда", async () => {
  // Без границы по времени `processing` от упавшего воркера означал бы
  // «человек пишет» вечно, и задача не выполнилась бы никогда.
  const db = inbox([
    {
      user_id: null, telegram_user_id: 77, status: "processing",
      received_at: new Date("2026-09-06T20:00:00Z"),
    },
  ]);
  assert.equal(await new LiveMessageWatch(db as never).waiting(77, NOW), false);
});

test("чужое сообщение своей работы не отменяет", async () => {
  const db = inbox([
    { user_id: null, telegram_user_id: 88, status: "queued", received_at: LATER },
  ]);
  assert.equal(await new LiveMessageWatch(db as never).waiting(77, NOW), false);
});

test("сорванная проверка уступкой не считается", async () => {
  // Потерять ход из-за отказа базы хуже, чем один раз не уступить.
  const db = { query: async () => { throw new Error("база недоступна"); } };
  assert.equal(await new LiveMessageWatch(db as never).waiting(77, NOW), false);
});
