import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_WINDOW_MINUTES,
  ProactiveWindowPlanner,
  windowOccurrence,
} from "../dist/jobs/proactive/windows.js";
import { decideProactive, initiativeSlotKey } from "../dist/jobs/proactive/policy.js";
import { ProactiveService } from "../dist/jobs/proactive/service.js";

const logger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
};

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
    const occurrence = windowOccurrence(WINDOW, "2026-08-17", "Asia/Yekaterinburg", () => value);
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
      WINDOW, `2026-08-${String(day).padStart(2, "0")}`, "UTC", () => seed % 1,
    );
    minutes.add(occurrence!.scheduledFor.toISOString().slice(11, 16));
  }
  assert.ok(minutes.size > 5, `минут получилось всего ${minutes.size}`);
});

test("в невыбранный день недели окно не срабатывает", () => {
  // 2026-08-17 — понедельник.
  const weekend = { ...WINDOW, weekdays: [6, 7] };
  assert.equal(windowOccurrence(weekend, "2026-08-17", "UTC", () => 0.5), null);
  assert.ok(windowOccurrence(weekend, "2026-08-15", "UTC", () => 0.5));
});

test("конец окна приходит вместе с минутой", () => {
  const occurrence = windowOccurrence(WINDOW, "2026-08-17", "UTC", () => 0.5)!;
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
  const occurrence = windowOccurrence(night, "2026-03-29", "Europe/Amsterdam", () => 0.5);
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

  assert.equal(await planner.plan(), 1);
  const first = fake.planned[0]!.scheduled_for;

  // Второй заход того же дня: выборка ЕЩЁ отдаёт окно (в фейке она это
  // делает всегда), но слот уже занят — и записи не будет.
  assert.equal(await planner.plan(), 0);
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
  assert.equal(await planner.plan(), 2);
  assert.equal(new Set(fake.planned.map((row) => row.slot_key)).size, 2);
});

test("день, который человек не выбирал, строки не оставляет", async () => {
  const fake = new FakeWindowDatabase();
  // 2026-08-17 — понедельник, а окно только на выходные.
  fake.rows = [windowRow({ weekdays: [6, 7] })];
  const planner = new ProactiveWindowPlanner(fake as never, logger as never, () => 0.5);
  assert.equal(await planner.plan(), 0);
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
