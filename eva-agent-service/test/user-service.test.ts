/**
 * Раздел «Пользователи».
 *
 * Проверяется то, что тихо ломается в проде: согласованность двух полей
 * блокировки, форма поискового запроса, устойчивость переписки к
 * недоступной Letta и то, что личный текст не утекает в места, где ему
 * быть не должно.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { UserService } from "../dist/admin/user-service.js";

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * Пул, который ничего не выполняет, но запоминает запросы и отдаёт
 * заранее заданные строки. Логику SQL проверяем текстом запроса, поведение
 * сервиса — возвращаемыми значениями.
 */
function fakePool(responses: unknown[][] = []) {
  const calls: Recorded[] = [];
  let index = 0;
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = responses[index] ?? [];
      index += 1;
      return { rows };
    },
  };
}

function fakeAgent(result: unknown, fail = false) {
  return {
    request: async () => {
      if (fail) throw new Error("App Server недоступен");
      return result;
    },
  };
}

const build = (pool: unknown, agent: unknown = fakeAgent({ messages: [] })) =>
  new UserService(pool, agent);

// ---------------------------------------------------------------------
// идентификатор
// ---------------------------------------------------------------------
test("нечисловой и неположительный идентификатор отвергаются", async () => {
  const service = build(fakePool());
  for (const bad of ["abc", "", "0", "-5", "1; DROP TABLE users", null, undefined]) {
    await assert.rejects(
      async () => await service.get(bad),
      /Некорректный идентификатор/,
      `значение ${JSON.stringify(bad)} должно быть отвергнуто`,
    );
  }
});

test("идентификатор за пределами безопасного целого отвергается", async () => {
  const service = build(fakePool());
  await assert.rejects(
    async () => await service.get("9007199254740993"),
    /Некорректный идентификатор/,
  );
});

// ---------------------------------------------------------------------
// список
// ---------------------------------------------------------------------
test("числовой запрос ищет и по telegram_id, нечисловой — нет", async () => {
  const numeric = fakePool([[{ total: "1" }], []]);
  await build(numeric).list({ query: "12345" });
  assert.match(numeric.calls[0].sql, /telegram_id::text = \$2/);

  const text = fakePool([[{ total: "0" }], []]);
  await build(text).list({ query: "аня" });
  assert.doesNotMatch(
    text.calls[0].sql,
    /telegram_id/,
    "по нечисловой строке искать в telegram_id незачем",
  );
});

test("поиск подставляется параметром, а не склейкой строк", async () => {
  const pool = fakePool([[{ total: "0" }], []]);
  await build(pool).list({ query: "'; DROP TABLE users --" });
  assert.ok(
    pool.calls[0].params.includes("%'; DROP TABLE users --%"),
    "значение должно уходить параметром",
  );
  assert.doesNotMatch(pool.calls[0].sql, /DROP TABLE/);
});

// Неразбираемое значение откатывается к умолчанию, разбираемое, но вне
// диапазона — прижимается к границе: 0 и -3 дают 1, а не 50.
test("лимит списка ограничен сверху и снизу", async () => {
  for (const [asked, expected] of [[5000, 200], [0, 1], [-3, 1], ["не число", 50], [17, 17]]) {
    const pool = fakePool([[{ total: "0" }], []]);
    const result = await build(pool).list({ limit: asked as number });
    assert.equal(result.limit, expected, `limit=${JSON.stringify(asked)}`);
  }
});

test("фильтр по блокировке различает false и «не задан»", async () => {
  const off = fakePool([[{ total: "0" }], []]);
  await build(off).list({ blocked: false });
  assert.match(off.calls[0].sql, /is_blocked = \$1/);

  const absent = fakePool([[{ total: "0" }], []]);
  await build(absent).list({});
  assert.doesNotMatch(absent.calls[0].sql, /is_blocked/);
});

// ---------------------------------------------------------------------
// блокировка
// ---------------------------------------------------------------------
test("блокировка выставляет оба поля одним запросом", async () => {
  const pool = fakePool([[{ id: 1, state: "blocked", is_blocked: true }]]);
  await build(pool).setBlocked("1", true);
  const { sql } = pool.calls[0];
  assert.equal(pool.calls.length, 1, "два поля должны меняться одним UPDATE");
  assert.match(sql, /is_blocked = \$2/);
  assert.match(sql, /state = CASE WHEN \$2 THEN 'blocked' ELSE 'active' END/);
});

test("разблокировка возвращает состояние active", async () => {
  const pool = fakePool([[{ id: 1, state: "active", is_blocked: false }]]);
  const row = await build(pool).setBlocked("1", false);
  assert.equal(row.state, "active");
  assert.equal(pool.calls[0].params[1], false);
});

test("несуществующий пользователь при блокировке даёт 404", async () => {
  await assert.rejects(
    async () => await build(fakePool([[]])).setBlocked("42", true),
    /не найден/,
  );
});

// ---------------------------------------------------------------------
// правка полей
// ---------------------------------------------------------------------
test("состояние blocked нельзя выставить правкой полей", async () => {
  await assert.rejects(
    async () => await build(fakePool()).update("1", { state: "blocked" }),
    /блокировка выполняется отдельным действием/,
  );
});

test("смена состояния снимает флаг блокировки, чтобы поля не разошлись", async () => {
  const pool = fakePool([[{ id: 1 }]]);
  await build(pool).update("1", { state: "paused" });
  assert.match(pool.calls[0].sql, /is_blocked = false/);
});

test("неизвестный часовой пояс отвергается до записи", async () => {
  const pool = fakePool([[{ id: 1 }]]);
  await assert.rejects(
    async () => await build(pool).update("1", { timezone: "Europe/Атлантида" }),
    /Неизвестный часовой пояс/,
  );
  assert.equal(pool.calls.length, 0, "запись не должна начинаться");
});

test("настоящий часовой пояс принимается и помечается источником", async () => {
  const pool = fakePool([[{ id: 1 }]]);
  await build(pool).update("1", { timezone: "Asia/Yekaterinburg" });
  assert.ok(pool.calls[0].params.includes("Asia/Yekaterinburg"));
  assert.ok(pool.calls[0].params.includes("admin"), "источник должен быть отмечен");
});

test("пустой запрос на изменение отвергается", async () => {
  await assert.rejects(
    async () => await build(fakePool()).update("1", {}),
    /Нечего изменять/,
  );
});

test("language_mode принимает только auto и fixed", async () => {
  await assert.rejects(
    async () => await build(fakePool()).update("1", { language_mode: "любой" }),
    /только 'auto' или 'fixed'/,
  );
});

// ---------------------------------------------------------------------
// заметки
// ---------------------------------------------------------------------
test("пустая заметка и заметка из пробелов отвергаются", async () => {
  const service = build(fakePool());
  for (const bad of ["", "   ", "\n\t"]) {
    await assert.rejects(
      async () => await service.addNote("1", { id: null, username: "o" }, bad),
      /не может быть пустой/,
    );
  }
});

test("некорректный Idempotency-Key отвергается", async () => {
  await assert.rejects(
    async () => await build(fakePool()).addNote(
      "1", { id: null, username: "o" }, "текст", "коротко",
    ),
    /Некорректный Idempotency-Key/,
  );
});

test("повтор по ключу возвращает уже созданную заметку, а не ошибку", async () => {
  // Первый запрос ничего не вернул (конфликт), второй нашёл существующую.
  const pool = fakePool([[], [{ id: "n1", note: "текст" }]]);
  const row = await build(pool).addNote(
    "1", { id: null, username: "owner" }, "текст", "key-12345678",
  );
  assert.equal(row.id, "n1");
});

test("без ключа отсутствие строки означает отсутствие пользователя", async () => {
  await assert.rejects(
    async () => await build(fakePool([[]])).addNote(
      "1", { id: null, username: "owner" }, "текст",
    ),
    /не найден/,
  );
});

// ---------------------------------------------------------------------
// переписка
// ---------------------------------------------------------------------
test("недоступная Letta не рушит запрос: список диалогов всё равно приходит", async () => {
  const pool = fakePool([
    [{ telegram_id: "555", username: "u", first_name: "И" }],
    [{ conversation_id: "c1" }],
  ]);
  const result = await build(pool, fakeAgent(null, true)).conversation("1", "50");
  assert.deepEqual(result.messages, []);
  assert.match(result.messages_error, /недоступен/);
  assert.equal(result.conversations.length, 1, "диалоги читаются из PostgreSQL");
});

test("сообщения достаются из ответа рантайма", async () => {
  const pool = fakePool([
    [{ telegram_id: "555", username: "u", first_name: "И" }],
    [],
    [],
  ]);
  const agent = fakeAgent({ messages: [{ role: "user", content: "привет" }] });
  const result = await build(pool, agent).conversation("1", "10");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages_error, null);
});

test("лимит переписки ограничен сверху", async () => {
  const pool = fakePool([
    [{ telegram_id: "555" }],
    [],
    [],
  ]);
  let requested = "";
  const agent = {
    request: async (path: string) => {
      requested = path;
      return { messages: [] };
    },
  };
  await build(pool, agent).conversation("1", "100000");
  assert.match(requested, /limit=200$/, "выше 200 сообщений за раз не отдаём");
});

// ---------------------------------------------------------------------
// приватность
// ---------------------------------------------------------------------
test("карточка не читает текстовые поля кризисных событий", async () => {
  const pool = fakePool([
    [{ id: 1 }], [], [], [], [], [],
  ]);
  await build(pool).get("1");
  const crisis = pool.calls.find((call) => /FROM crisis_events/.test(call.sql));
  assert.ok(crisis, "запрос к crisis_events должен быть");
  for (const column of ["trigger_text", "response_text", "notes"]) {
    assert.doesNotMatch(
      crisis.sql,
      new RegExp(column),
      `${column} — прямая речь человека, в карточке ей не место`,
    );
  }
});
