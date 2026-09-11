import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_WINDOW_MINUTES,
  ProactiveWindowPlanner,
  windowOccurrence,
} from "../dist/jobs/proactive/windows.js";
import { decideProactive, initiativeSlotKey } from "../dist/jobs/proactive/policy.js";
import { ProactiveService } from "../dist/jobs/proactive/service.js";
import { PublicRepository } from "../dist/public/routes.js";

const logger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
};

/** Полночь тех суток, для которых считается окно. */
const DAY_START = new Date("2026-08-16T19:00:00Z"); // 00:00 17 августа в Екатеринбурге

const WINDOW = {
  id: "7",
  startMinute: 11 * 60,
  endMinute: 12 * 60,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
};

// ---------------------------------------------------------------------
// Выбор минуты
// ---------------------------------------------------------------------

test("минута выбирается внутри окна и не выходит за его границы", () => {
  // Правый край исключается: окно 11:00–12:00 даёт минуты с 11:00 по
  // 11:59. Иначе «до двенадцати» и «с двенадцати» делили бы одну минуту.
  for (const value of [0, 0.5, 0.999999, 1]) {
    const occurrence = windowOccurrence(
      WINDOW, "2026-08-17", "Asia/Yekaterinburg", DAY_START, () => value,
    );
    assert.ok(occurrence, `random=${value}`);
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Yekaterinburg", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(occurrence.scheduledFor);
    assert.ok(local >= "11:00" && local <= "11:59", `random=${value} дал ${local}`);
  }
});

test("минута действительно разная, а не одна и та же каждый день", () => {
  // Смысл случайности не в разнообразии ради разнообразия: сообщение,
  // приходящее ровно в 11:00 каждый день, читается как будильник.
  const minutes = new Set<string>();
  let seed = 0;
  for (let day = 1; day <= 20; day += 1) {
    seed += 0.137;
    const occurrence = windowOccurrence(
      WINDOW, `2026-08-${String(day).padStart(2, "0")}`,
      "UTC", new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00Z`), () => seed % 1,
    );
    minutes.add(occurrence!.scheduledFor.toISOString().slice(11, 16));
  }
  assert.ok(minutes.size > 5, `минут получилось всего ${minutes.size}`);
});

test("в невыбранный день недели окно не срабатывает", () => {
  // 2026-08-17 — понедельник.
  const weekend = { ...WINDOW, weekdays: [6, 7] };
  assert.equal(windowOccurrence(weekend, "2026-08-17", "UTC", DAY_START, () => 0.5), null);
  assert.ok(windowOccurrence(
    weekend, "2026-08-15", "UTC", new Date("2026-08-15T00:00:00Z"), () => 0.5,
  ));
});

test("конец окна приходит вместе с минутой", () => {
  const occurrence = windowOccurrence(WINDOW, "2026-08-17", "UTC", DAY_START, () => 0.5)!;
  assert.equal(occurrence.validUntil.toISOString(), "2026-08-17T12:00:00.000Z");
  assert.ok(occurrence.scheduledFor < occurrence.validUntil);
  assert.equal(occurrence.slotKey, initiativeSlotKey("2026-08-17", "7"));
});

test("переход на летнее время не съедает окно", () => {
  // В ночь на 29 марта 2026 Амстердам переводит стрелки в 02:00 — часа
  // 02:00–03:00 в этот день не существует. Окно, посчитанное
  // арифметикой над UTC, попало бы в несуществующее время; прибавление
  // к началу суток отдаёт ближайшее существующее.
  const night = { ...WINDOW, startMinute: 2 * 60, endMinute: 3 * 60 };
  const occurrence = windowOccurrence(
    night, "2026-03-29", "Europe/Amsterdam",
    new Date("2026-03-28T22:00:00Z"), () => 0.5,
  );
  assert.ok(occurrence, "окно обязано дать время, а не исчезнуть");
  assert.ok(!Number.isNaN(occurrence.scheduledFor.getTime()));
});

test("узкое окно отвергается тем же порогом, что и в схеме", () => {
  assert.equal(MIN_WINDOW_MINUTES, 15);
});

// ---------------------------------------------------------------------
// Планировщик: минута выбирается один раз
// ---------------------------------------------------------------------

class FakeWindowDatabase {
  rows: Record<string, unknown>[] = [];
  planned: Record<string, unknown>[] = [];

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();
    if (text.includes("FROM proactive_windows w")) return { rows: this.rows };
    if (text.startsWith("INSERT INTO proactive_messages")) {
      const [userId, slotKey] = values;
      // Повторяет уникальный слот и `ON CONFLICT DO NOTHING`.
      if (this.planned.some((row) => row.user_id === userId && row.slot_key === slotKey)) {
        return { rows: [], rowCount: 0 };
      }
      this.planned.push({
        user_id: userId, slot_key: slotKey, local_date: values[2],
        timezone: values[3], scheduled_for: values[4], valid_until: values[5],
        window_id: values[6],
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Неожиданный запрос: ${text.slice(0, 80)}`);
  };

  withSystemScope = async <T>(_label: string, work: () => Promise<T>): Promise<T> => await work();
  withUserScope = async <T>(_scope: unknown, work: () => Promise<T>): Promise<T> => await work();
}

function windowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "7", user_id: "42", start_minute: 11 * 60, end_minute: 12 * 60,
    weekdays: [1, 2, 3, 4, 5, 6, 7], timezone: "UTC", local_date: "2026-08-17",
    ...overrides,
  };
}

test("выбранная минута переживает перезапуск, а не катается заново", async () => {
  // Бросок на каждом заходе означал бы, что минута всё время впереди
  // (и сообщение не придёт никогда) либо всё время позади (и оно
  // придёт на каждом заходе).
  const fake = new FakeWindowDatabase();
  fake.rows = [windowRow()];
  let seed = 0;
  const planner = new ProactiveWindowPlanner(
    fake as never, logger as never, () => { seed += 0.31; return seed % 1; },
  );

  assert.equal(await planner.plan(undefined, DAY_START), 1);
  const first = fake.planned[0]!.scheduled_for;

  // Второй заход того же дня: выборка ЕЩЁ отдаёт окно (в фейке она это
  // делает всегда), но слот уже занят — и записи не будет.
  assert.equal(await planner.plan(undefined, DAY_START), 0);
  assert.equal(fake.planned.length, 1);
  assert.equal(fake.planned[0]!.scheduled_for, first);
});

test("несколько окон одного дня не мешают друг другу", async () => {
  // Слот различает окно, а не только дату: иначе второе окно дня
  // упёрлось бы в слот первого и не сработало никогда.
  const fake = new FakeWindowDatabase();
  fake.rows = [
    windowRow({ id: "7", start_minute: 11 * 60, end_minute: 12 * 60 }),
    windowRow({ id: "8", start_minute: 17 * 60, end_minute: 18 * 60 }),
  ];
  const planner = new ProactiveWindowPlanner(fake as never, logger as never, () => 0.5);
  assert.equal(await planner.plan(undefined, DAY_START), 2);
  assert.equal(new Set(fake.planned.map((row) => row.slot_key)).size, 2);
});

test("день, который человек не выбирал, строки не оставляет", async () => {
  const fake = new FakeWindowDatabase();
  // 2026-08-17 — понедельник, а окно только на выходные.
  fake.rows = [windowRow({ weekdays: [6, 7] })];
  const planner = new ProactiveWindowPlanner(fake as never, logger as never, () => 0.5);
  assert.equal(await planner.plan(undefined, DAY_START), 0);
  assert.equal(fake.planned.length, 0);
});

// ---------------------------------------------------------------------
// Диспетчер: наступившее окно
// ---------------------------------------------------------------------

class FakeScheduledDatabase {
  messages: Record<string, unknown>[] = [
    { id: "m1", status: "scheduled", updated_at: 0 },
  ];

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();
    if (text.startsWith("UPDATE proactive_messages SET status = 'planned'")) {
      const row = this.messages.find((item) => item.id === values[0]);
      if (!row || row.status !== "scheduled") return { rows: [] };
      row.status = "planned";
      return { rows: [{ id: row.id }] };
    }
    // Закрытие ещё не начатой строки: решение «не писать» пришло до
    // того, как за работу взялись.
    if (text.startsWith("UPDATE proactive_messages SET status = 'skipped'")) {
      const row = this.messages.find((item) => item.id === values[0]);
      if (row && row.status === "scheduled") {
        row.status = "skipped";
        row.reason = values[1];
      }
      return { rows: [] };
    }
    // Итог начатой работы.
    if (text.startsWith("UPDATE proactive_messages SET status = $2")) {
      const row = this.messages.find((item) => item.id === values[0]);
      if (row) {
        row.status = values[1];
        row.reason = values[2];
        row.message_text = values[4];
      }
      return { rows: [] };
    }
    throw new Error(`Неожиданный запрос: ${text.slice(0, 80)}`);
  };

  withSystemScope = async <T>(_label: string, work: () => Promise<T>): Promise<T> => await work();
  withUserScope = async <T>(_scope: unknown, work: () => Promise<T>): Promise<T> => await work();
}

function scheduledCandidate(overrides: Record<string, unknown> = {}) {
  return {
    userId: 42, telegramId: 4242, chatId: 4242, agentId: "a", conversationId: "c",
    timezone: "UTC",
    lastUserMessageAt: new Date("2026-08-17T06:00:00Z"),
    lastProactiveAt: null, unansweredProactive: 0,
    consent: true, frequency: "normal" as const, awaitingReply: false,
    messageId: "m1",
    scheduledFor: new Date("2026-08-17T11:20:00Z"),
    validUntil: new Date("2026-08-17T12:00:00Z"),
    windowLabel: null,
    ...overrides,
  };
}

function scheduledService(text: string | null = "Вспомнила про твой разговор.") {
  const fake = new FakeScheduledDatabase();
  const delivered: { text: string; idempotencyKey: string }[] = [];
  const service = new ProactiveService(
    fake as never,
    { compose: async () => ({ text }) } as never,
    {
      deliver: async (input: { text: string; idempotencyKey: string }) => {
        delivered.push(input);
        return { outboxId: "outbox-1" };
      },
    } as never,
    logger as never,
  );
  return { fake, service, delivered };
}

test("наступившее окно отправляет одно сообщение", async () => {
  const layer = scheduledService();
  const outcome = await layer.service.handleScheduled(scheduledCandidate(), {
    now: new Date("2026-08-17T11:20:30Z"),
  });
  assert.deepEqual(outcome, { status: "sent", outboxId: "outbox-1" });
  assert.equal(layer.delivered.length, 1);
  assert.equal(layer.fake.messages[0]!.status, "sent");
  assert.equal(layer.fake.messages[0]!.message_text, "Вспомнила про твой разговор.");
});

test("пропущенное окно не догоняется", async () => {
  // Сервис пролежал до вечера. «Доброе утро» в три часа дня человек
  // воспримет не как заботу, а как сбой.
  const layer = scheduledService();
  const outcome = await layer.service.handleScheduled(scheduledCandidate(), {
    now: new Date("2026-08-17T15:00:00Z"),
  });
  assert.deepEqual(outcome, { status: "skipped", reason: "window_missed" });
  assert.equal(layer.delivered.length, 0);
  assert.equal(layer.fake.messages[0]!.status, "skipped");
});

test("две реплики в одну минуту отправляют одно сообщение", async () => {
  const layer = scheduledService();
  const now = new Date("2026-08-17T11:20:30Z");
  const [first, second] = await Promise.all([
    layer.service.handleScheduled(scheduledCandidate(), { now }),
    layer.service.handleScheduled(scheduledCandidate(), { now }),
  ]);
  const outcomes = [first.status, second.status].sort();
  assert.deepEqual(outcomes, ["sent", "skipped"]);
  assert.equal(layer.delivered.length, 1);
});

test("окно не перебивает незакрытый разговор", async () => {
  const layer = scheduledService();
  const outcome = await layer.service.handleScheduled(
    scheduledCandidate({ awaitingReply: true }),
    { now: new Date("2026-08-17T11:20:30Z") },
  );
  assert.deepEqual(outcome, { status: "skipped", reason: "awaiting_reply" });
  assert.equal(layer.delivered.length, 0);
});

test("молчание в окно — валидный исход", async () => {
  // Окно означает «можно писать», а не «обязана написать».
  const layer = scheduledService(null);
  const outcome = await layer.service.handleScheduled(scheduledCandidate(), {
    now: new Date("2026-08-17T11:20:30Z"),
  });
  assert.deepEqual(outcome, { status: "skipped", reason: "empty_message" });
  assert.equal(layer.delivered.length, 0);
});

test("тихие часы не отменяют окно, выбранное человеком", () => {
  // Человек выбрал этот час осознанно. Подменять его выбор общим
  // правилом «после десяти не писать» значило бы отменить настройку.
  const night = new Date("2026-08-17T23:30:00Z");
  const context = {
    timezone: "UTC", lastUserMessageAt: new Date("2026-08-17T20:00:00Z"),
    lastProactiveAt: null, unansweredProactive: 0,
    consent: true, frequency: "normal" as const, awaitingReply: false,
  };
  assert.deepEqual(decideProactive("initiative", context, night), { send: true });
  assert.deepEqual(
    decideProactive("checkin_morning", context, night),
    { send: false, reason: "quiet_hours" },
  );
});

test("выключенное согласие останавливает окно немедленно", async () => {
  const layer = scheduledService();
  const outcome = await layer.service.handleScheduled(
    scheduledCandidate({ consent: false }),
    { now: new Date("2026-08-17T11:20:30Z") },
  );
  assert.deepEqual(outcome, { status: "skipped", reason: "consent_withheld" });
  assert.equal(layer.delivered.length, 0);
});

test("окно, у которого день уже прошёл, минуты не получает", () => {
  // Пропущенное окно не догоняется. Минута в прошлом означала бы
  // сообщение, ушедшее в ту же секунду, — а «доброе утро» в три часа
  // дня человек воспринимает не как заботу, а как сбой.
  const afternoon = new Date("2026-08-17T09:00:00Z"); // 14:00 в Екатеринбурге
  assert.equal(
    windowOccurrence(WINDOW, "2026-08-17", "Asia/Yekaterinburg", afternoon, () => 0.5),
    null,
  );
});

test("окно, заведённое посреди себя, пишет в оставшуюся часть", () => {
  // Человек нажал «Сохранить» в 11:30 на окно 11:00–12:00. Минута из
  // прошедшей половины означала бы сообщение через секунду после
  // нажатия кнопки — это отклик на нажатие, а не инициатива.
  const midway = new Date("2026-08-17T06:30:00Z"); // 11:30 в Екатеринбурге
  for (const value of [0, 0.5, 0.999]) {
    const occurrence = windowOccurrence(
      WINDOW, "2026-08-17", "Asia/Yekaterinburg", midway, () => value,
    );
    assert.ok(occurrence, `random=${value}`);
    assert.ok(
      occurrence.scheduledFor > midway,
      `минута обязана быть впереди: ${occurrence.scheduledFor.toISOString()}`,
    );
    assert.ok(occurrence.scheduledFor < occurrence.validUntil);
  }
});

// ---------------------------------------------------------------------
// Окно остаётся собой между сохранениями
// ---------------------------------------------------------------------

/** База, в которой живут окна и уже выбранные на сегодня минуты. */
class FakeWindowStore {
  windows: Record<string, unknown>[] = [];
  messages: Record<string, unknown>[] = [];
  private nextId = 1;

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.includes("FROM users WHERE telegram_id")) {
      return { rows: [{ id: 7, city: null, timezone: "UTC", language_mode: "auto", preferred_language: null }] };
    }
    if (text.includes("FROM user_preferences WHERE user_id")) {
      return { rows: [{ heartbeat_enabled: true }] };
    }
    if (text.startsWith("SELECT id::text, start_minute, end_minute, weekdays, enabled FROM proactive_windows")) {
      return { rows: this.windows.map((row) => ({ ...row })) };
    }
    if (text.startsWith("SELECT id::text, start_minute, end_minute, weekdays, enabled, label")) {
      return { rows: this.windows.map((row) => ({ ...row })) };
    }
    if (text.startsWith("UPDATE proactive_windows SET start_minute")) {
      const row = this.windows.find((item) => item.id === values[0]);
      if (row) {
        row.start_minute = values[2];
        row.end_minute = values[3];
        row.weekdays = values[4];
        row.enabled = values[5];
        row.label = values[6];
      }
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO proactive_windows")) {
      const row = {
        id: String(this.nextId++), start_minute: values[1], end_minute: values[2],
        weekdays: values[3], enabled: values[4], label: values[5],
      };
      this.windows.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (text.startsWith("UPDATE proactive_messages SET status = 'skipped', reason = 'window_removed'")) {
      const kept = values[1] as string[];
      for (const row of this.messages) {
        if (row.status === "scheduled" && row.window_id && !kept.includes(String(row.window_id))) {
          row.status = "skipped";
          row.reason = "window_removed";
        }
      }
      return { rows: [] };
    }
    if (text.startsWith("DELETE FROM proactive_windows")) {
      const kept = values[1] as string[];
      this.windows = this.windows.filter((row) => kept.includes(String(row.id)));
      return { rows: [] };
    }
    if (text.startsWith("DELETE FROM proactive_messages")) {
      const changed = values[1] as string[];
      this.messages = this.messages.filter(
        (row) => !(row.status === "scheduled" && changed.includes(String(row.window_id))),
      );
      return { rows: [] };
    }
    throw new Error(`Неожиданный запрос: ${text.slice(0, 80)}`);
  };

  withUserScope = async <T>(_scope: unknown, work: () => Promise<T>): Promise<T> => await work();
  bindScopeUserId = () => undefined;
  transaction = async <T>(work: (client: { query: typeof this.query }) => Promise<T>): Promise<T> =>
    await work({ query: this.query });
}

function repository(store: FakeWindowStore) {
  return new PublicRepository(store as never, {} as never, {} as never, {} as never);
}

test("правка одного окна не перекатывает минуту соседнего", async () => {
  // Набор сохранялся целиком — `DELETE` и `INSERT`, — и каждое окно
  // получало новый идентификатор. Слот выбранной минуты собран из него,
  // поэтому любая правка настроек делала уже разложенное окно «ещё не
  // тронутым»: планировщик выбирал ему ВТОРУЮ минуту в те же сутки, и
  // человек получал два сообщения там, где просил одно.
  const store = new FakeWindowStore();
  store.windows = [
    { id: "1", start_minute: 660, end_minute: 720, weekdays: [1, 2, 3], enabled: true, label: null },
    { id: "2", start_minute: 1020, end_minute: 1080, weekdays: [1, 2, 3], enabled: true, label: null },
  ];
  store.messages = [
    { id: "m1", window_id: "1", status: "scheduled", reason: null },
    { id: "m2", window_id: "2", status: "scheduled", reason: null },
  ];

  // Человек тронул только второе окно.
  await repository(store).saveProactiveWindows(4242, {
    windows: [
      { id: "1", start_minute: 660, end_minute: 720, weekdays: [1, 2, 3] },
      { id: "2", start_minute: 1080, end_minute: 1140, weekdays: [1, 2, 3] },
    ],
  });

  assert.deepEqual(store.windows.map((row) => row.id), ["1", "2"], "идентификаторы обязаны уцелеть");
  // Минута нетронутого окна на месте: второго сообщения сегодня не будет.
  assert.ok(store.messages.some((row) => row.id === "m1" && row.status === "scheduled"));
  // У изменённого минута снята: она считалась по старым границам.
  assert.ok(!store.messages.some((row) => row.id === "m2"));
});

test("снятое окно не срабатывает по уже выбранной минуте", async () => {
  // Ссылка на окно — `ON DELETE SET NULL`: без явной отмены выбранная
  // минута пережила бы удаление окна и сработала бы сама по себе.
  const store = new FakeWindowStore();
  store.windows = [
    { id: "1", start_minute: 660, end_minute: 720, weekdays: [1], enabled: true, label: null },
  ];
  store.messages = [{ id: "m1", window_id: "1", status: "scheduled", reason: null }];

  await repository(store).saveProactiveWindows(4242, { windows: [] });

  assert.deepEqual(store.windows, []);
  const message = store.messages.find((row) => row.id === "m1")!;
  assert.equal(message.status, "skipped");
  assert.equal(message.reason, "window_removed");
});

test("отправленное сообщение сохранением настроек не воскрешается", async () => {
  // Слот отправленного остаётся занятым: иначе правка настроек днём
  // давала бы второе сообщение в то же окно тех же суток.
  const store = new FakeWindowStore();
  store.windows = [
    { id: "1", start_minute: 660, end_minute: 720, weekdays: [1], enabled: true, label: null },
  ];
  store.messages = [{ id: "m1", window_id: "1", status: "sent", reason: null }];

  await repository(store).saveProactiveWindows(4242, {
    windows: [{ id: "1", start_minute: 600, end_minute: 700, weekdays: [1] }],
  });

  assert.equal(store.messages.find((row) => row.id === "m1")!.status, "sent");
});

test("чужой идентификатор окна читается как новое окно, а не крадёт чужое", async () => {
  const store = new FakeWindowStore();
  store.windows = [];
  await repository(store).saveProactiveWindows(4242, {
    windows: [{ id: "999", start_minute: 660, end_minute: 720, weekdays: [1] }],
  });
  assert.equal(store.windows.length, 1);
  assert.notEqual(store.windows[0]!.id, "999");
});

test("одинаковый идентификатор у двух окон отвергается, а не теряет одно из них", async () => {
  const store = new FakeWindowStore();
  store.windows = [
    { id: "1", start_minute: 660, end_minute: 720, weekdays: [1], enabled: true, label: null },
  ];
  await assert.rejects(
    () => repository(store).saveProactiveWindows(4242, {
      windows: [
        { id: "1", start_minute: 660, end_minute: 720, weekdays: [1] },
        { id: "1", start_minute: 1020, end_minute: 1080, weekdays: [1] },
      ],
    }),
    /идентификатор/,
  );
  assert.equal(store.windows.length, 1);
});

/**
 * Служебное слово не уходит человеку.
 *
 * Отказ писать проверялся на точное равенство `HEARTBEAT_SKIP`, а модель
 * отвечает текстом и текст оформляет. «HEARTBEAT_SKIP.» равенству не
 * удовлетворяет — и на боевой установке человек получил в чат ровно это
 * служебное слово вместо сообщения.
 */
test("оформленный отказ модели не превращается в сообщение человеку", async () => {
  const { LettaProactiveComposer } = await import("../dist/jobs/proactive/composer.js");
  const purposes = {
    ensure: async (input: { purpose: string }) => ({
      conversationId: `conversation-${input.purpose}`,
      purpose: input.purpose,
      created: false,
    }),
    close: async () => undefined,
  };
  const build = (reply: string) => new LettaProactiveComposer(
    { runTurn: async () => ({ reply }) } as never,
    purposes as never,
    { build: async () => ({}), wrapUserMessage: (_c: unknown, m: string) => m } as never,
    { run: async (_id: number, work: () => Promise<unknown>) => await work() } as never,
    logger as never,
  );
  const compose = async (reply: string) => await build(reply).compose({
    kind: "heartbeat", candidate: scheduledCandidate(), episode: null,
    signal: new AbortController().signal,
  } as never);

  for (const refusal of [
    "HEARTBEAT_SKIP",
    "HEARTBEAT_SKIP.",
    "**HEARTBEAT_SKIP**",
    "\"HEARTBEAT_SKIP\"",
    "HEARTBEAT_SKIP — повода писать нет",
    "   ",
  ]) {
    assert.deepEqual(await compose(refusal), { text: null },
      `служебное слово ушло бы человеку: ${refusal}`);
  }

  // Настоящее сообщение при этом проходит: запрет касается маркера, а
  // не любого ответа.
  assert.deepEqual(
    await compose("Вспомнила про твой разговор с дядей Колей."),
    { text: "Вспомнила про твой разговор с дядей Колей." },
  );
});

test("ветка инициативы закрывается после каждого выхода на связь", async () => {
  // Она была вечной и копила прошлые выходы вместе с ответами на них:
  // на новом ходе модель писала человеку сводку по накопленному вместо
  // повода. Что она уже отправляла, приходит ей блоком
  // `i_wrote_since_your_last_message` — без накопления.
  const { LettaProactiveComposer } = await import("../dist/jobs/proactive/composer.js");
  const closed: Array<{ purpose: string }> = [];
  const purposes = {
    ensure: async (input: { purpose: string }) => ({
      conversationId: `conversation-${input.purpose}`,
      purpose: input.purpose,
      created: false,
    }),
    close: async (_userId: number, _agentId: string, purpose: string) => {
      closed.push({ purpose });
    },
  };
  const build = (runTurn: () => Promise<{ reply: string }>) => new LettaProactiveComposer(
    { runTurn } as never,
    purposes as never,
    { build: async () => ({}), wrapUserMessage: (_c: unknown, m: string) => m } as never,
    { run: async (_id: number, work: () => Promise<unknown>) => await work() } as never,
    logger as never,
  );

  const composer = build(async () => ({ reply: "Вспомнила про твой разговор." }));
  await composer.compose({
    kind: "initiative", candidate: scheduledCandidate(), episode: null,
    signal: new AbortController().signal,
  } as never);
  assert.deepEqual(closed, [{ purpose: "initiative" }]);

  // Сорванный ход оставляет после себя самый мусор — значит и его.
  const failing = build(async () => { throw new Error("ход не состоялся"); });
  await assert.rejects(() => failing.compose({
    kind: "initiative", candidate: scheduledCandidate(), episode: null,
    signal: new AbortController().signal,
  } as never));
  assert.equal(closed.length, 2);
});
