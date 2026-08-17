/**
 * Проактивность на очередях: часовые пояса, тихие часы, идемпотентность
 * и взаимоблокировка со старым интервалом.
 *
 * Внешних сервисов нет: база подменена таблицами в памяти, composer
 * возвращает заранее известный текст, доставка считает вызовы. Проверяются
 * правила переноса, а не Telegram и не Letta.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_QUIET_HOURS,
  decideProactive,
  inQuietHours,
  nextLocalTime,
  proactiveSlot,
} from "../dist/jobs/proactive/policy.js";
import { ProactiveService } from "../dist/jobs/proactive/service.js";
import { ProactiveRunner } from "../dist/jobs/proactive/runner.js";
import {
  legacySchedulerActive,
  proactiveStage,
  queueMayDispatch,
} from "../dist/jobs/proactive/cutover.js";
import { compareSelections } from "../dist/jobs/mirror.js";
import { ReconcileService } from "../dist/jobs/maintenance.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------
// Часовые пояса и слоты
// ---------------------------------------------------------------------

test("переход на летнее время не теряет и не удваивает местное время", () => {
  // 29 марта 2026, Европа/Москва зону не переводит — а Берлин переводит:
  // 02:00 становится 03:00, и местного 02:30 в этот день не существует.
  const beforeSpring = new Date("2026-03-29T00:30:00Z");
  const target = nextLocalTime("Europe/Berlin", 2, 30, beforeSpring);
  // Несуществующее местное время не пропадает: зона отдаёт ближайшее
  // существующее, и напоминание сдвигается, а не исчезает.
  assert.ok(target.getTime() > beforeSpring.getTime());
  assert.ok(target.getTime() - beforeSpring.getTime() < 26 * 3_600_000);

  // Обратный переход: 25 октября 2026 местные 02:30 в Берлине наступают
  // дважды. Слот у обоих наступлений один — второе сообщение не уходит.
  const firstPass = new Date("2026-10-25T00:30:00Z");
  const secondPass = new Date("2026-10-25T01:30:00Z");
  const first = proactiveSlot("checkin_morning", "Europe/Berlin", firstPass);
  const second = proactiveSlot("checkin_morning", "Europe/Berlin", secondPass);
  assert.equal(first.slotKey, second.slotKey);
});

test("слот считается в местной дате человека, а не в UTC", () => {
  // 21:30 UTC — это уже следующий день в Екатеринбурге и ещё текущий в Лиссабоне.
  const moment = new Date("2026-08-10T21:30:00Z");
  const yekaterinburg = proactiveSlot("checkin_evening", "Asia/Yekaterinburg", moment);
  const lisbon = proactiveSlot("checkin_evening", "Europe/Lisbon", moment);
  assert.equal(yekaterinburg.localDate, "2026-08-11");
  assert.equal(lisbon.localDate, "2026-08-10");
  assert.notEqual(yekaterinburg.slotKey, lisbon.slotKey);

  // Heartbeat делит сутки пополам: утренний и вечерний слоты разные.
  const morning = proactiveSlot("heartbeat", "Europe/Moscow", new Date("2026-08-10T06:00:00Z"));
  const evening = proactiveSlot("heartbeat", "Europe/Moscow", new Date("2026-08-10T18:00:00Z"));
  assert.notEqual(morning.slotKey, evening.slotKey);
});

test("тихие часы считаются в местном времени и пересекают полночь", () => {
  // 23:00 в Москве — тишина; тот же момент в Лиссабоне — 21:00, не тишина.
  const night = new Date("2026-08-10T20:00:00Z");
  assert.equal(inQuietHours("Europe/Moscow", night), true);
  assert.equal(inQuietHours("Europe/Lisbon", night), false);
  assert.equal(inQuietHours("Europe/Moscow", new Date("2026-08-10T09:00:00Z")), false);
  assert.equal(
    inQuietHours("Europe/Moscow", night, { startHour: 1, endHour: 5 }),
    false,
    "окно без перехода через полночь работает так же",
  );
  assert.deepEqual(DEFAULT_QUIET_HOURS, { startHour: 22, endHour: 9 });
});

// ---------------------------------------------------------------------
// Решение об инициативе
// ---------------------------------------------------------------------

function context(overrides = {}) {
  return {
    timezone: "Europe/Moscow",
    lastUserMessageAt: new Date("2026-08-09T10:00:00Z"),
    lastProactiveAt: null,
    unansweredProactive: 0,
    consent: true,
    frequency: "normal" as const,
    awaitingReply: false,
    ...overrides,
  };
}

test("инициатива учитывает согласие, активность, тишину и незакрытую переписку", () => {
  const noon = new Date("2026-08-10T09:00:00Z"); // 12:00 в Москве

  assert.deepEqual(decideProactive("heartbeat", context(), noon), { send: true });

  assert.deepEqual(
    decideProactive("heartbeat", context({ consent: false }), noon),
    { send: false, reason: "consent_withheld" },
  );
  assert.deepEqual(
    decideProactive("heartbeat", context({ frequency: "off" }), noon),
    { send: false, reason: "frequency_off" },
  );
  assert.deepEqual(
    decideProactive("heartbeat", context(), new Date("2026-08-10T20:00:00Z")),
    { send: false, reason: "quiet_hours" },
  );
  assert.deepEqual(
    decideProactive("heartbeat", context({ awaitingReply: true }), noon),
    { send: false, reason: "awaiting_reply" },
  );
  assert.deepEqual(
    decideProactive(
      "heartbeat",
      context({ lastUserMessageAt: new Date("2026-08-10T08:00:00Z") }),
      noon,
    ),
    { send: false, reason: "recent_activity" },
  );
  assert.deepEqual(
    decideProactive("heartbeat", context({ unansweredProactive: 2 }), noon),
    { send: false, reason: "unanswered_previous" },
  );

  // Напоминание человек назначил сам: тихие часы и молчание его не отменяют.
  assert.deepEqual(
    decideProactive("reminder", context(), new Date("2026-08-10T20:00:00Z")),
    { send: true },
  );
});

test("режим «реже» растягивает интервалы, а не отключает инициативу", () => {
  const now = new Date("2026-08-10T09:00:00Z");
  const eightHoursAgo = new Date(now.getTime() - 8 * 3_600_000);
  assert.deepEqual(
    decideProactive("heartbeat", context({ lastUserMessageAt: eightHoursAgo }), now),
    { send: true },
  );
  assert.deepEqual(
    decideProactive(
      "heartbeat",
      context({ lastUserMessageAt: eightHoursAgo, frequency: "reduced" }),
      now,
    ),
    { send: false, reason: "recent_activity" },
  );
});

// ---------------------------------------------------------------------
// Поддельная база
// ---------------------------------------------------------------------

class FakeProactiveDatabase {
  /** Часы фейка: тест сдвигает их, чтобы попытка успела «зависнуть». */
  now = Date.now();
  messages: Record<string, unknown>[] = [];
  episodes: Record<string, unknown>[] = [];
  mirror: Record<string, unknown>[] = [];
  private nextId = 1;

  query = async (sql: string, values: unknown[] = []): Promise<{ rows: never[] }> => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("INSERT INTO proactive_messages")) {
      const [userId, kind, slotKey, localDate, timezone] = values;
      const existing = this.messages.find(
        (row) => row.user_id === userId && row.kind === kind && row.slot_key === slotKey,
      );
      if (existing) {
        // Повторяет `ON CONFLICT ... DO UPDATE ... WHERE`: зависшая
        // попытка забирается заново, живая — нет.
        const staleSeconds = Number(values[6] ?? 0);
        const age = this.now - Number(existing.updated_at ?? this.now);
        const stale = existing.status === "planned" && age >= staleSeconds * 1000;
        if (!stale || !text.includes("RETURNING id")) return { rows: [] as never };
        existing.updated_at = this.now;
        return { rows: [{ id: existing.id }] as never };
      }
      const row = {
        id: `msg-${this.nextId++}`,
        updated_at: this.now,
        user_id: userId,
        kind,
        slot_key: slotKey,
        local_date: localDate,
        timezone,
        status: text.includes("'planned'") ? "planned" : values[5],
        reason: text.includes("'planned'") ? null : values[6],
        outbox_id: null,
        episode_id: null,
      };
      this.messages.push(row);
      return { rows: (text.includes("RETURNING id") ? [{ id: row.id }] : []) as never };
    }

    if (text.startsWith("UPDATE proactive_messages SET status")) {
      const row = this.messages.find((item) => item.id === values[0]);
      if (row) {
        row.status = values[1];
        row.reason = values[2];
        row.outbox_id = values[3];
      }
      return { rows: [] as never };
    }

    if (text.startsWith("UPDATE proactive_messages SET episode_id")) {
      const row = this.messages.find((item) => item.id === values[0]);
      if (row) row.episode_id = values[1];
      return { rows: [] as never };
    }

    if (text.startsWith("SELECT id, local_date::text AS local_date, evening_outcome_ref")) {
      const previous = this.episodes
        .filter((row) => row.user_id === values[0] && String(row.local_date) < String(values[1]))
        .sort((left, right) => String(right.local_date).localeCompare(String(left.local_date)))[0];
      return { rows: (previous ? [previous] : []) as never };
    }

    if (text.startsWith("INSERT INTO checkin_episodes")) {
      const existing = this.episodes.find(
        (row) => row.user_id === values[0] && row.local_date === values[1],
      );
      if (existing) return { rows: [existing] as never };
      const row = {
        id: `ep-${this.nextId++}`,
        user_id: values[0],
        local_date: values[1],
        timezone: values[2],
        previous_id: values[3],
        morning_intent_ref: null,
        evening_outcome_ref: null,
        morning_message_id: null,
        evening_message_id: null,
      };
      this.episodes.push(row);
      return { rows: [row] as never };
    }

    if (text.startsWith("UPDATE checkin_episodes")) {
      const row = this.episodes.find((item) => item.id === values[0]);
      if (row) {
        if (text.includes("morning_message_id")) row.morning_message_id = values[2];
        else row.evening_message_id = values[2];
      }
      return { rows: [] as never };
    }

    if (text.startsWith("INSERT INTO job_mirror_samples")) {
      this.mirror.push({
        job_type: values[0],
        legacy_count: values[1],
        queue_count: values[2],
        matched: values[3],
      });
      return { rows: [] as never };
    }

    if (text.startsWith("SELECT matched FROM job_mirror_samples")) {
      return { rows: this.mirror.map((row) => ({ matched: row.matched })) as never };
    }

    // Сверки обслуживания: каждая возвращает пустой список.
    if (text.includes("FROM job_outbox") || text.includes("FROM turn_runs")
      || text.includes("FROM telegram_outbox") || text.includes("FROM checkin_episodes")
      || text.includes("FROM subscriptions")) {
      return { rows: [] as never };
    }

    throw new Error(`Неожиданный запрос: ${text.slice(0, 80)}`);
  };

  transaction = async <T>(work: (client: { query: typeof this.query }) => Promise<T>): Promise<T> =>
    await work({ query: this.query });
}

function candidate(overrides = {}) {
  return {
    userId: 42,
    telegramId: 4242,
    chatId: 4242,
    agentId: "agent-1",
    conversationId: "conv-1",
    timezone: "Europe/Moscow",
    lastUserMessageAt: new Date("2026-08-09T10:00:00Z"),
    lastProactiveAt: null,
    unansweredProactive: 0,
    consent: true,
    frequency: "normal" as const,
    awaitingReply: false,
    ...overrides,
  };
}

function buildService(text: string | null = "Как ты сегодня?") {
  const fake = new FakeProactiveDatabase();
  const db = withTenantScopes(fake as never) as never;
  const delivered: { chatId: number; text: string; idempotencyKey: string }[] = [];
  const composed: string[] = [];
  const service = new ProactiveService(
    db,
    {
      compose: async (input: { kind: string }) => {
        composed.push(input.kind);
        return { text };
      },
    } as never,
    {
      deliver: async (input: { chatId: number; text: string; idempotencyKey: string }) => {
        delivered.push(input);
        return { outboxId: `outbox-${delivered.length}` };
      },
    } as never,
    logger as never,
  );
  return { fake, db, service, delivered, composed };
}

// ---------------------------------------------------------------------
// Идемпотентность и эпизоды
// ---------------------------------------------------------------------

test("повторное задание не отправляет второе сообщение", async () => {
  const layer = buildService();
  const now = new Date("2026-08-10T06:00:00Z"); // 09:00 в Москве

  const first = await layer.service.handle("checkin_morning", candidate(), { now });
  assert.equal(first.status, "sent");

  // Тот же слот: расписание сработало дважды, воркер перезапустился —
  // второго сообщения человек не получает.
  const second = await layer.service.handle("checkin_morning", candidate(), { now });
  assert.deepEqual(second, { status: "skipped", reason: "duplicate" });

  assert.equal(layer.delivered.length, 1);
  assert.equal(layer.composed.length, 1, "второй ход агента не выполняется");
  assert.equal(
    layer.delivered[0]?.idempotencyKey,
    "proactive:checkin_morning:42:2026-08-10:checkin_morning",
  );
});

test("heartbeat без повода ничего не отправляет и это успех", async () => {
  const layer = buildService(null);
  const outcome = await layer.service.handle("heartbeat", candidate(), {
    now: new Date("2026-08-10T09:00:00Z"),
  });
  assert.deepEqual(outcome, { status: "skipped", reason: "empty_message" });
  assert.equal(layer.delivered.length, 0);
  // Решение записано: следующий заход в этом же слоте не будет считать,
  // что о человеке ещё не думали.
  assert.equal(layer.fake.messages.length, 1);
  assert.equal(layer.fake.messages[0]?.status, "skipped");
});

test("решение промолчать записывается вместе с причиной", async () => {
  const layer = buildService();
  const outcome = await layer.service.handle("heartbeat", candidate({ consent: false }), {
    now: new Date("2026-08-10T09:00:00Z"),
  });
  assert.deepEqual(outcome, { status: "skipped", reason: "consent_withheld" });
  assert.equal(layer.fake.messages[0]?.reason, "consent_withheld");
  assert.equal(layer.delivered.length, 0);
  assert.equal(layer.composed.length, 0, "ход агента при отказе не выполняется");
});

test("утро и вечер образуют один суточный эпизод со ссылкой на предыдущий день", async () => {
  const layer = buildService();
  const morning = new Date("2026-08-10T06:00:00Z");
  const evening = new Date("2026-08-10T18:00:00Z");

  await layer.service.handle("checkin_morning", candidate(), { now: morning });
  await layer.service.handle("checkin_evening", candidate(), { now: evening });

  assert.equal(layer.fake.episodes.length, 1, "утро и вечер — один эпизод дня");
  const episode = layer.fake.episodes[0]!;
  assert.equal(episode.local_date, "2026-08-10");
  assert.ok(episode.morning_message_id, "утреннее сообщение привязано к эпизоду");
  assert.ok(episode.evening_message_id, "вечернее сообщение привязано к эпизоду");

  // Следующий день ссылается на предыдущий эпизод: утро знает про вечер.
  await layer.service.handle("checkin_morning", candidate(), {
    now: new Date("2026-08-11T06:00:00Z"),
  });
  const next = layer.fake.episodes.find((row) => row.local_date === "2026-08-11");
  assert.equal(next?.previous_id, episode.id);
});

test("смена часового пояса не переписывает прошлые слоты", async () => {
  const layer = buildService();
  const now = new Date("2026-08-10T06:00:00Z");
  await layer.service.handle("checkin_morning", candidate(), { now });
  const stored = layer.fake.messages[0]!;
  assert.equal(stored.timezone, "Europe/Moscow");

  // Человек переехал: новый слот считается в новой зоне, а старая строка
  // сохраняет ту зону, в которой решение принималось.
  await layer.service.handle(
    "checkin_morning",
    candidate({ timezone: "Asia/Yekaterinburg" }),
    { now: new Date("2026-08-10T20:00:00Z") },
  );
  assert.equal(layer.fake.messages[0]?.timezone, "Europe/Moscow");
  assert.equal(layer.fake.messages.length, 2);
  assert.equal(layer.fake.messages[1]?.local_date, "2026-08-11");
});

test("перезапуск между занятием слота и доставкой не теряет напоминание", async () => {
  const layer = buildService();
  const now = new Date("2026-08-10T09:00:00Z");

  // Первая попытка падает после занятия слота: доставка бросает.
  const crashing = new ProactiveService(
    layer.db,
    { compose: async () => ({ text: "Пора сделать шаг" }) } as never,
    {
      deliver: async () => {
        throw new Error("процесс убит");
      },
    } as never,
    logger as never,
  );
  const failed = await crashing.handle("reminder", candidate(), { now });
  assert.equal(failed.status, "failed");
  assert.equal(layer.delivered.length, 0);

  // Свежую попытку другой реплики никто не перехватывает.
  layer.fake.messages[0]!.status = "planned";
  const concurrent = await layer.service.handle("reminder", candidate(), { now });
  assert.deepEqual(concurrent, { status: "skipped", reason: "duplicate" });

  // А зависшая дольше срока — забирается заново, и напоминание уходит.
  layer.fake.now += 11 * 60_000;
  const retried = await layer.service.handle("reminder", candidate(), { now });
  assert.equal(retried.status, "sent");
  assert.equal(layer.delivered.length, 1, "напоминание не потеряно");
  assert.equal(layer.fake.messages.length, 1, "второй строки слота не появилось");
});

test("неотвеченный check-in не превращается в поток сообщений", async () => {
  const layer = buildService();
  // Три утренних check-in подряд остались без ответа — четвёртый не уходит.
  const outcome = await layer.service.handle(
    "checkin_morning",
    candidate({ unansweredProactive: 3 }),
    { now: new Date("2026-08-10T06:00:00Z") },
  );
  assert.deepEqual(outcome, { status: "skipped", reason: "unanswered_previous" });
  assert.equal(layer.delivered.length, 0);
  assert.equal(layer.fake.messages[0]?.reason, "unanswered_previous");
});

// ---------------------------------------------------------------------
// Ступени переноса и зеркало
// ---------------------------------------------------------------------

test("одна задача не выполняется одновременно старым и новым механизмом", () => {
  const legacy = proactiveStage({ proactiveEnabled: false, mirrorMode: true });
  const mirror = proactiveStage({ proactiveEnabled: true, mirrorMode: true });
  const queue = proactiveStage({ proactiveEnabled: true, mirrorMode: false });

  assert.deepEqual([legacy, mirror, queue], ["legacy", "mirror", "queue"]);
  // Ровно одна сторона отправляет на каждой ступени.
  for (const stage of [legacy, mirror, queue]) {
    assert.notEqual(
      legacySchedulerActive(stage),
      queueMayDispatch(stage),
      `на ступени ${stage} отправляют обе стороны или ни одной`,
    );
  }
});

test("зеркало сравнивает множества, а не счётчики, и ничего не отправляет", async () => {
  const layer = buildService();
  const selection = {
    heartbeat: async () => [candidate()],
    reminders: async () => [],
    checkin: async () => [],
  };
  const mirror = new (await import("../dist/jobs/mirror.js")).MirrorRecorder(
    layer.db,
    logger as never,
  );
  const runner = new ProactiveRunner(
    selection as never,
    layer.service,
    mirror,
    "mirror",
    logger as never,
    () => Promise.resolve(["user:42"]),
  );

  const result = await runner.tick("heartbeat", { now: new Date("2026-08-10T09:00:00Z") });
  assert.equal(result.selected, 1);
  assert.equal(result.matched, true);
  // Одно совпадение доказательством не считается: снимать зеркало рано.
  assert.equal(result.readyToCutOver, false);
  assert.equal(result.sent, 0, "в режиме зеркала очередь не отправляет");
  assert.equal(layer.delivered.length, 0);
  assert.equal(layer.fake.mirror.length, 1);

  // Равные счётчики при разных людях — это расхождение, а не совпадение.
  const skewed = compareSelections("heartbeat", ["user:1"], ["user:2"]);
  assert.equal(skewed.matched, false);
  assert.deepEqual([skewed.legacyCount, skewed.queueCount], [1, 1]);
});

test("после снятия зеркала отправляет очередь", async () => {
  const layer = buildService();
  const selection = {
    heartbeat: async () => [candidate()],
    reminders: async () => [],
    checkin: async () => [],
  };
  const mirror = new (await import("../dist/jobs/mirror.js")).MirrorRecorder(
    layer.db,
    logger as never,
  );
  const runner = new ProactiveRunner(
    selection as never,
    layer.service,
    mirror,
    "queue",
    logger as never,
  );
  const result = await runner.tick("heartbeat", { now: new Date("2026-08-10T09:00:00Z") });
  assert.equal(result.sent, 1);
  assert.equal(layer.delivered.length, 1);
});

test("готовность к снятию зеркала требует серии совпадений подряд", async () => {
  const layer = buildService();
  const mirror = new (await import("../dist/jobs/mirror.js")).MirrorRecorder(
    layer.db,
    logger as never,
  );
  const runner = new ProactiveRunner(
    { heartbeat: async () => [candidate()], reminders: async () => [], checkin: async () => [] } as never,
    layer.service,
    mirror,
    "mirror",
    logger as never,
    () => Promise.resolve(["user:42"]),
    { cutoverRuns: 3 },
  );
  const now = new Date("2026-08-10T09:00:00Z");

  assert.equal((await runner.tick("heartbeat", { now })).readyToCutOver, false);
  assert.equal((await runner.tick("heartbeat", { now })).readyToCutOver, false);
  const third = await runner.tick("heartbeat", { now });
  assert.equal(third.readyToCutOver, true, "три совпадения подряд — доказательство");

  // Одно расхождение обнуляет готовность: серия должна быть чистой.
  const diverging = new ProactiveRunner(
    { heartbeat: async () => [candidate()], reminders: async () => [], checkin: async () => [] } as never,
    layer.service,
    mirror,
    "mirror",
    logger as never,
    () => Promise.resolve(["user:99"]),
    { cutoverRuns: 3 },
  );
  const mismatch = await diverging.tick("heartbeat", { now });
  assert.equal(mismatch.matched, false);
  assert.equal(mismatch.readyToCutOver, false);
});

// ---------------------------------------------------------------------
// Сверки обслуживания
// ---------------------------------------------------------------------

test("сверка отличает «нечего проверять» от «проблем нет»", async () => {
  const layer = buildService();
  const report = await new ReconcileService(layer.db, logger as never).run();

  const embeddings = report.findings.find((item) => item.check === "embeddings_missing");
  assert.equal(embeddings?.status, "not_applicable");
  assert.equal(embeddings?.reason, "vector_column_absent_until_step_18");

  const outbox = report.findings.find((item) => item.check === "job_outbox_unpublished");
  assert.equal(outbox?.status, "checked");
  assert.equal(report.total, 0);
  assert.deepEqual(report.degraded, []);
});
