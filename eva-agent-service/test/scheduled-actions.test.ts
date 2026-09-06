import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";
import { purposePolicy } from "../dist/conversations/purpose-service.js";
import { TaskEventService } from "../dist/tasks/task-event-service.js";
import { turnCancelled } from "../dist/errors.js";
import { ScheduledTaskRunner } from "../dist/tasks/task-runner.js";
import {
  ACTION_DAILY_LIMIT,
  MAX_APPROVAL_WAITS,
  MAX_ATTEMPTS,
  approvalRetryAt,
  retryAfterFailure,
  scheduledInstruction,
  taskKindOf,
} from "../dist/tasks/task-run.js";

const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as never;

interface Call { sql: string; values: unknown[] }

function fakeDb(reply: (sql: string, values: unknown[]) => unknown[] | null = () => null) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      const rows = reply(sql, values) ?? [];
      return { rows, rowCount: rows.length };
    },
    markAgentUsed: async () => {},
  };
}

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11",
    user_id: "7",
    telegram_id: "77",
    chat_id: "77",
    kind: "action",
    title: "найти новости в Перми",
    description: null,
    priority: 3,
    attempts: 0,
    due_at: null,
    remind_at: new Date("2026-09-04T10:00:00Z"),
    related_goal: null,
    previous_runs: 0,
    last_task_action: null,
    cron_expression: null,
    repeat_enabled: false,
    timezone: "Asia/Yekaterinburg",
    agent_id: "agent-7",
    conversation_id: "conversation-chat",
    scheduled_at: new Date("2026-09-04T10:00:00Z"),
    language_mode: "auto",
    preferred_language: null,
    last_message_language: "ru",
    language_code: "ru",
    ...overrides,
  };
}

function harness(options: {
  db?: ReturnType<typeof fakeDb>;
  reply?: string;
  fail?: Error;
  /** Чем кончился вопрос, заданный внутри фонового хода. */
  approval?: { status: string; toolName: string; description: string } | null;
  /** Ход уступает живому сообщению: барьер отмены отвечает «да». */
  cancel?: boolean;
  /** Держать ход открытым, пока тест не отпустит: нужно виртуальным часам. */
  hold?: { promise: Promise<void>; reached: () => void };
  actionTurnTimeoutMs?: number;
} = {}) {
  const db = options.db ?? fakeDb();
  const turns: Array<{
    conversationId: string; prompt: string; timeoutMs?: number;
  }> = [];
  const sent: Array<{ chatId: number; text: string }> = [];
  const deliveries: Array<{ prefix: string; priority: string }> = [];
  const closed: Array<{ userId: number; agentId: string; purpose: string }> = [];
  const letta = {
    runTurn: async (
      conversationId: string,
      prompt: string,
      turnOptions: { timeoutMs?: number; isCancelled?: () => Promise<boolean> } = {},
    ) => {
      turns.push({ conversationId, prompt, timeoutMs: turnOptions.timeoutMs });
      if (options.hold) {
        // Ход дошёл до сюда — значит отметка о долгой работе уже
        // заведена, и часы можно двигать.
        options.hold.reached();
        await options.hold.promise;
      }
      if (options.cancel && await turnOptions.isCancelled?.()) {
        throw turnCancelled("ход отменён живым сообщением");
      }
      if (options.fail) throw options.fail;
      return { reply: options.reply ?? "Вот три новости Перми на сегодня: …" };
    },
  };
  const telegram = {
    configured: true,
    withPriority: async (_priority: string, work: () => Promise<unknown>) => await work(),
    // Результат задачи уходит в durable outbox с ключом идемпотентности,
    // собранным из задачи и её срока: строка переживает перезапуск,
    // HTTP-запрос из упавшего процесса — нет.
    withDeliveryContext: async (
      prefix: string,
      work: () => Promise<unknown>,
      priority: string,
    ) => {
      deliveries.push({ prefix, priority });
      return await work();
    },
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return [{ message_id: 500 }];
    },
  };
  const runner = new ScheduledTaskRunner(
    db as never,
    letta as never,
    { run: async (_id: number, work: () => Promise<unknown>) => await work() } as never,
    telegram as never,
    {
      build: async () => ({}),
      wrapUserMessage: (_context: unknown, message: string) => message,
    } as never,
    {
      ensure: async (input: { purpose: string }) => ({
        conversationId: `conversation-${input.purpose}`,
        purpose: input.purpose,
        created: false,
      }),
      // Ветка служебного хода закрывается, чем бы заход ни кончился:
      // иначе в ней копятся прошлые задания, и модель отвечает человеку
      // сводкой по ним вместо работы.
      close: async (userId: number, agentId: string, purpose: string) => {
        closed.push({ userId, agentId, purpose });
      },
    } as never,
    new TaskEventService(db as never),
    logger,
    options.approval === undefined
      ? null
      : { lastUnattendedApproval: async () => options.approval ?? null },
    options.actionTurnTimeoutMs,
  );
  return { db, runner, turns, sent, deliveries, closed };
}

function updates(db: ReturnType<typeof fakeDb>): Call[] {
  return db.calls.filter((call) => call.sql.includes("UPDATE tasks SET"));
}

function events(db: ReturnType<typeof fakeDb>): Call[] {
  return db.calls.filter((call) => call.sql.includes("INSERT INTO task_events"));
}

test("наступившее действие поручает работу Еве, а не возвращает её человеку", () => {
  const action = scheduledInstruction({
    taskId: "11", kind: "action", title: "найти новости в Перми",
    description: null, priority: 3, dueAt: null, remindAt: null,
    timezone: "Asia/Yekaterinburg", relatedGoal: null, previousRuns: 0,
    lastTaskAction: null,
  });
  assert.match(action, /\[ЗАПЛАНИРОВАННОЕ ДЕЙСТВИЕ\]/);
  assert.match(action, /Сделай это сейчас сама/);
  assert.match(action, /сообщение человеку, а не отчёт/);
  assert.equal(action.includes("верни только готовый текст"), false);

  // Служебный номер в инструкции доезжал до человека словами «задачу 44
  // выполненной не считаю»: ответ превращался в отчёт трекера. Закрывает
  // задачу планировщик, модели номер не нужен.
  assert.equal(action.includes("task_id"), false);
  assert.equal(action.includes("11"), false);
  // Эта conversation общая для всех отложенных дел и копит служебные
  // блоки. Запрет поимённый, потому что каждый пункт модель писала
  // человеку на самом деле.
  assert.match(action, /восстановлении или потере контекста/);
  assert.match(action, /других задач, их номеров, статусов/);
  assert.match(action, /предложения повторить/);

  // Напоминание не тронуто: его формулировка работает и переписывать её
  // этот шаг не нанимали.
  const reminder = scheduledInstruction({
    taskId: "11", kind: "reminder", title: "позвонить маме",
    description: null, priority: 3, dueAt: null, remindAt: null,
    timezone: "UTC", relatedGoal: null, previousRuns: 0, lastTaskAction: null,
  });
  assert.match(reminder, /\[ЗАПЛАНИРОВАННАЯ ЗАДАЧА\]/);
  assert.match(reminder, /верни только готовый текст/);
  assert.equal(reminder.includes("Сделай это сейчас сама"), false);
  // «Задача открыта» в хвосте напоминания — это доехавшая до человека
  // служебная отметка, а не часть напоминания.
  assert.equal(reminder.includes("task_id"), false);
  assert.match(reminder, /Служебных отметок/);
});

test("род задачи по умолчанию — напоминание", () => {
  assert.equal(taskKindOf("action"), "action");
  assert.equal(taskKindOf("reminder"), "reminder");
  assert.equal(taskKindOf(null), "reminder");
  assert.equal(taskKindOf(undefined), "reminder");
  assert.equal(taskKindOf("что-то ещё"), "reminder");
});

test("попытки заканчиваются, а не повторяются вечно", () => {
  const now = new Date("2026-09-04T10:00:00Z");
  const first = retryAfterFailure(1, now);
  const second = retryAfterFailure(2, now);
  assert.equal(first?.getTime(), now.getTime() + 2 * 60_000);
  assert.equal(second?.getTime(), now.getTime() + 10 * 60_000);
  assert.equal(retryAfterFailure(MAX_ATTEMPTS, now), null);
  assert.equal(retryAfterFailure(MAX_ATTEMPTS + 1, now), null);
});

test("действие выполняется в своей conversation и закрывает разовую задачу", async () => {
  const { db, runner, turns, sent } = harness();
  await runner.execute(taskRow() as never);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.conversationId, "conversation-task_action");
  assert.match(turns[0]!.prompt, /Сделай это сейчас сама/);
  assert.deepEqual(sent.map((message) => message.chatId), [77]);
  assert.match(sent[0]!.text, /новости Перми/);

  const recorded = events(db).map((call) => call.values[2]);
  assert.deepEqual(recorded, ["action_done"]);

  const update = updates(db).at(-1)!;
  // Разовое действие закрывается само: работу сделала Ева.
  assert.equal(update.values[3], true);
  assert.equal(update.values[1], null);
});

test("напоминание работает по-прежнему: та же conversation и те же события", async () => {
  const { db, runner, turns, sent } = harness({ reply: "Пора позвонить маме" });
  await runner.execute(taskRow({ kind: "reminder", title: "позвонить маме" }) as never);

  assert.equal(turns[0]!.conversationId, "conversation-scheduler");
  assert.deepEqual(events(db).map((call) => call.values[2]), [
    "reminder_generated", "reminder_sent",
  ]);
  assert.equal(sent.length, 1);
  // Напоминание остаётся открытым: выполнил его человек или нет, знает он.
  assert.equal(updates(db).at(-1)!.values[3], false);
});

test("повторяющееся действие переносится на следующий cron и не закрывается", async () => {
  const { db, runner } = harness();
  await runner.execute(taskRow({
    cron_expression: "0 8 * * *", repeat_enabled: true, timezone: "UTC",
  }) as never);

  const update = updates(db).at(-1)!;
  assert.equal(update.values[3], false);
  assert.equal(typeof update.values[1], "string");
  assert.equal(new Date(String(update.values[1])).getTime() > Date.now(), true);
});

test("сорванный заход откладывается, а не крутится каждые тридцать секунд", async () => {
  const { db, runner, sent } = harness({ fail: new Error("провайдер вернул 503") });
  await runner.execute(taskRow() as never);

  assert.deepEqual(events(db).map((call) => call.values[2]), ["action_failed"]);
  const update = updates(db).at(-1)!;
  assert.match(update.sql, /attempts = \$4/);
  assert.equal(update.values[3], 1);
  const retryAt = new Date(String(update.values[4])).getTime();
  assert.equal(retryAt > Date.now() + 60_000, true);
  // Пока попытки не исчерпаны, человека не беспокоят.
  assert.equal(sent.length, 0);
});

test("исчерпав попытки, планировщик говорит человеку прямо и закрывает срок", async () => {
  const { db, runner, sent } = harness({ fail: new Error("провайдер вернул 503") });
  await runner.execute(taskRow({ attempts: MAX_ATTEMPTS - 1 }) as never);

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Не получилось сделать это самой/);
  const update = updates(db).at(-1)!;
  // last_run_at = now() снимает задачу с выборки: тот же срок второй раз
  // не берётся.
  assert.match(update.sql, /last_run_at = now\(\)/);
  assert.equal(update.values[1], null);
});

test("сорванное напоминание всё равно доходит до человека своим текстом", async () => {
  const { db, runner, sent } = harness({ fail: new Error("нет ответа модели") });
  await runner.execute(taskRow({
    kind: "reminder", title: "позвонить маме", attempts: MAX_ATTEMPTS - 1,
  }) as never);

  assert.deepEqual(sent.map((message) => message.text), ["Напоминаю: позвонить маме"]);
  assert.deepEqual(events(db).map((call) => call.values[2]), [
    "delivery_failed", "reminder_sent",
  ]);
});

test("пустой ответ на действие считается отказом, а не выполнением", async () => {
  const { db, runner, sent } = harness({ reply: "   " });
  await runner.execute(taskRow() as never);

  assert.deepEqual(events(db).map((call) => call.values[2]), ["action_failed"]);
  assert.equal(sent.length, 0);
});

test("суточный потолок действий откладывает задачу, а не теряет её", async () => {
  const db = fakeDb((sql) => (
    sql.includes("AS used") ? [{ used: ACTION_DAILY_LIMIT }] : null
  ));
  const { runner, turns, sent } = harness({ db });
  await runner.execute(taskRow() as never);

  assert.equal(turns.length, 0, "ход агента не начинался");
  assert.equal(sent.length, 0);
  const event = events(db).at(-1)!;
  assert.equal(event.values[2], "action_failed");
  assert.equal(event.values[17], "daily_limit");
  const update = updates(db).at(-1)!;
  const postponed = new Date(String(update.values[1])).getTime();
  assert.equal(postponed > Date.now() + 30 * 60_000, true);
});

test("уже выполненный срок не выполняется второй раз", async () => {
  const db = fakeDb((sql) => (sql.includes("SELECT 1 FROM task_events") ? [{ "?column?": 1 }] : null));
  const { runner, turns } = harness({ db });
  await runner.execute(taskRow() as never);

  assert.equal(turns.length, 0);
  assert.equal(events(db).length, 0);
  assert.equal(updates(db).length, 1, "срок сдвинут, работа не повторена");
});

test("в conversation выполнения задачи инструменты не сужены, а профиль защищён", () => {
  const policy = purposePolicy("task_action");
  assert.equal(policy.allowedTools, null);
  assert.equal(policy.canChangeProfile, false);
  assert.deepEqual(policy.deniedTools, [
    "upsert_user_profile_field",
    "confirm_user_profile_field",
    "decline_user_profile_field",
    "mark_profile_field_asked",
  ]);
  // У планировщика напоминаний ничего не изменилось.
  assert.deepEqual(purposePolicy("scheduler").allowedTools, []);
});

test("фоновое действие не меняет профиль человека, но работать может", async () => {
  const factory = new AgentToolFactory(
    { searxngUrl: "http://search.invalid" } as never,
    withTenantScopes({
      getAgentRuntimeContext: async () => ({
        userId: 7, telegramId: 77, chatId: 77,
        conversationId: "conversation-task_action",
        purpose: "task_action", timezone: "UTC",
        responseMode: "text", useEmoji: false,
      }),
      query: async () => ({ rows: [{ id: 1, title: "Новости Перми" }] }),
    }) as never,
    {} as never,
    logger,
  );
  const tools = factory.forConversation("conversation-task_action");
  const profile = tools.find((tool) => tool.name === "upsert_user_profile_field")!;
  const denied = await profile.execute("call-1", {
    field_key: "city", value: "Пермь",
  }) as { details?: { ok?: boolean; error?: string } };
  assert.equal(denied.details?.ok, false);
  assert.match(denied.details?.error ?? "", /недоступен/);

  // Рабочие инструменты при этом на месте: иначе «сделай сама» упиралось
  // бы в пустой список.
  const saveNote = tools.find((tool) => tool.name === "save_note")!;
  const saved = await saveNote.execute("call-2", {
    title: "Новости Перми", content: "Три главные новости дня",
  }) as { details?: { ok?: boolean } };
  assert.equal(saved.details?.ok, true);
});

// ---------------------------------------------------------------------
// Фоновое действие, которому нужно согласие человека
// ---------------------------------------------------------------------

test("ход, упершийся в согласие, переносит задачу, а не тратит попытку", async () => {
  // «Через десять минут сделай пост для моего телеграм-канала»:
  // публикация — действие с внешним последствием, и фоновый ход не
  // выполнял его вовсе. Теперь ход спрашивает человека и заканчивается,
  // не удерживая блокировку, а задача возвращается за ответом.
  const layer = harness({
    approval: { status: "pending", toolName: "publish_post", description: "Опубликовать пост" },
  });
  await layer.runner.execute(taskRow() as never);

  const waiting = events(layer.db).filter(
    (call) => call.values[2] === "action_awaiting_approval",
  );
  assert.equal(waiting.length, 1, "ожидание согласия обязано оставить след");

  // Попытка не считается: человек ещё не ответил, и исчерпывать на нём
  // три попытки нельзя.
  const moved = updates(layer.db).filter((call) => call.sql.includes("next_run_at = $2"));
  assert.equal(moved.length, 1);
  assert.equal(layer.sent.length, 0, "второго сообщения о том же вопросе быть не должно");

  // Работы не было — значит и результата тоже.
  const done = events(layer.db).filter((call) => call.values[2] === "action_done");
  assert.equal(done.length, 0);
});

test("отказ человека закрывает задачу, а не повторяет вопрос", async () => {
  const layer = harness({
    approval: { status: "denied", toolName: "publish_post", description: "Опубликовать пост" },
  });
  await layer.runner.execute(taskRow() as never);

  assert.equal(layer.sent.length, 1);
  assert.match(layer.sent[0]!.text, /не разрешил/);
  const closed = updates(layer.db).filter((call) => call.sql.includes("status = CASE WHEN"));
  assert.equal(closed.length, 1, "задача обязана закрыться, а не ждать снова");
});

test("вопросы кончаются: человек слышит прямой ответ вместо четвёртого", () => {
  const now = new Date("2026-09-04T10:00:00Z");
  assert.ok(approvalRetryAt(1, now));
  assert.ok(approvalRetryAt(MAX_APPROVAL_WAITS - 1, now));
  assert.equal(approvalRetryAt(MAX_APPROVAL_WAITS, now), null);
  // Отступ растёт: тот, кто не ответил за десять минут, занят.
  assert.ok(approvalRetryAt(2, now)!.getTime() > approvalRetryAt(1, now)!.getTime());
});

test("без контура подтверждений задача работает по-прежнему", async () => {
  // `approval: undefined` — источник не передан вовсе.
  const layer = harness();
  await layer.runner.execute(taskRow() as never);
  assert.equal(layer.sent.length, 1);
  const done = events(layer.db).filter((call) => call.values[2] === "action_done");
  assert.equal(done.length, 1);
});

// ---------------------------------------------------------------------
// Живое сообщение важнее фоновой работы
// ---------------------------------------------------------------------

test("живое сообщение отодвигает фоновую задачу и не тратит попытку", async () => {
  // Ход выполнения задачи держит блокировку пользователя. Без уступки
  // человек, написавший в эту минуту, ждал бы её до конца — до десяти
  // минут молчания в ответ на «привет».
  const db = fakeDb((sql) =>
    sql.includes("FROM telegram_updates") ? [{ ok: 1 }] : null);
  const layer = harness({ db, cancel: true });
  await layer.runner.execute(taskRow() as never);

  const moved = updates(layer.db).filter((call) => call.sql.includes("next_run_at = $2"));
  assert.equal(moved.length, 1, "срок обязан сдвинуться");
  // Ни отказа, ни сообщения: человек написал сам и сейчас получит ответ.
  assert.equal(layer.sent.length, 0);
  const failed = events(layer.db).filter((call) => call.values[2] === "action_failed");
  assert.equal(failed.length, 0, "уступка — не отказ");
});

test("напоминание живому сообщению не уступает", async () => {
  // Напоминание — это одно короткое сообщение, а не работа минутами:
  // уступать здесь нечему, а барьер стоил бы запроса к базе на каждый
  // десяток событий потока.
  const db = fakeDb((sql) =>
    sql.includes("FROM telegram_updates") ? [{ ok: 1 }] : null);
  const layer = harness({ db, cancel: true });
  await layer.runner.execute(taskRow({ kind: "reminder" }) as never);
  assert.equal(layer.sent.length, 1);
});

// ---------------------------------------------------------------------
// Доставка и потолок хода
// ---------------------------------------------------------------------

test("результат уходит с ключом идемпотентности, а не мимо outbox", async () => {
  // Падение между ходом и отправкой теряло уже оплаченную работу: ход
  // агента и поиск стоили денег, а сообщения человек не получал.
  const layer = harness();
  await layer.runner.execute(taskRow() as never);
  assert.equal(layer.deliveries.length, 1);
  assert.match(layer.deliveries[0]!.prefix, /^task:11:/);
  assert.equal(layer.deliveries[0]!.priority, "reminder");
});

test("у действия свой потолок хода, у напоминания — общий", async () => {
  const action = harness({ actionTurnTimeoutMs: 600_000 });
  await action.runner.execute(taskRow() as never);
  assert.equal(action.turns[0]!.timeoutMs, 600_000);

  const reminder = harness({ actionTurnTimeoutMs: 600_000 });
  await reminder.runner.execute(taskRow({ kind: "reminder" }) as never);
  assert.equal(reminder.turns[0]!.timeoutMs, undefined);
});

test("ожиданий на одно меньше, чем вопросов", () => {
  // Между тремя вопросами два ожидания. Третий интервал в списке был бы
  // кодом, до которого исполнение не доходит никогда.
  const now = new Date("2026-09-04T10:00:00Z");
  const delays: number[] = [];
  for (let waits = 1; waits <= MAX_APPROVAL_WAITS; waits += 1) {
    const at = approvalRetryAt(waits, now);
    if (at) delays.push(at.getTime() - now.getTime());
  }
  assert.equal(delays.length, MAX_APPROVAL_WAITS - 1);
  assert.deepEqual(delays, [...delays].sort((left, right) => left - right));
  assert.ok(new Set(delays).size === delays.length, "одинаковых отступов быть не должно");
});

/**
 * Долгая работа на виртуальных часах.
 *
 * Ход держится открытым, часы сдвигаются на две минуты, и только потом
 * ход отпускается: отметка «взялась» висит на таймере, и без остановки
 * времени тест ловил бы не её, а собственную скорость фейка.
 */
async function longWork(attempts: number) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const hold = {
      promise: new Promise<void>((resolve) => { release = resolve; }),
      reached: () => reached(),
    };
    const layer = harness({ hold });
    const running = layer.runner.execute(taskRow({ attempts }) as never);
    // Ждём не такты, а сам факт: ход дошёл до середины, таймер заведён.
    await started;
    mock.timers.tick(120_000);
    release();
    await running;
    // Отметка уходит из обработчика таймера и никем не ожидается:
    // дать её цепочке дойти до фейка доставки.
    await new Promise((resolve) => setImmediate(resolve));
    return layer.sent.map((item) => item.text);
  } finally {
    mock.timers.reset();
  }
}

test("«взялась за работу» приходит один раз, а не на каждой попытке", async () => {
  // Человек получал «Взялась за „Найти погоду“» второй и третий раз
  // подряд: отметка висела на попытке, а не на работе, и повтор после
  // неудачи выглядел как топтание на месте.
  const first = await longWork(0);
  assert.ok(
    first.some((text) => text.startsWith("Взялась за")),
    "на первой попытке долгая работа обязана назваться",
  );

  const retry = await longWork(1);
  assert.ok(
    !retry.some((text) => text.startsWith("Взялась за")),
    "повтор — та же работа, а не новая",
  );
});

test("отметка о работе не обещает срока, которого не знает", async () => {
  // «Займёт пару минут» превращалось в невыполненное обещание ровно
  // тогда, когда работа затягивалась, — то есть всегда, когда эта
  // отметка вообще отправляется.
  const sent = await longWork(0);
  const notice = sent.find((text) => text.startsWith("Взялась за"))!;
  assert.doesNotMatch(notice, /минут|час|скоро/i);
});

test("журнал задач не приходит в ход выполнения задачи", async () => {
  // Он оказывался единственным конкретным, что у модели перед глазами,
  // и она писала человеку сводку по задачам вместо того, что он просил.
  const { RuntimeContextBuilder } = await import("../dist/runtime/runtime-context.js");
  const row = {
    user_id: "1", telegram_id: "2", language_code: "ru", language_mode: "fixed",
    preferred_language: "ru", last_message_language: "ru", timezone: "UTC",
    city: null, country_code: null, agent_id: "a", conversation_id: "c",
    response_mode: "text", use_emoji: false, communication_style: null,
    profile_field_key: null, profile_title: null, profile_prompt_hint: null,
    profile_status: null, active_goal_title: null, next_result_title: null,
    next_action: null, llm_quality_mode: "auto", program_key: null,
    program_version: null, program_phase_key: null, program_step_key: null,
    program_next_step_key: null, program_next_action_hint: null, program_resume_policy: null,
  };
  const build = async (purpose: string) => {
    const builder = new RuntimeContextBuilder(
      {
        query: async (sql: string) => sql.includes("JOIN tasks t ON t.id=e.task_id")
          ? { rows: [{ title: "Собрать новости", event_type: "action_failed",
            created_at: new Date("2026-09-06T10:00:00Z"), task_status: "open" }] }
          : sql.includes("FROM tasks t")
            ? { rows: [{ title: "Позвонить", scheduled_at: new Date("2026-09-06T12:00:00Z") }] }
            : { rows: [{ ...row, purpose }] },
      } as never,
      { defaultTimezone: "UTC", profileCompletionEnabled: false, vectorGoalsEnabled: false,
        now: () => new Date("2026-09-06T11:00:00Z") },
    );
    const context = await builder.build({ userId: 1, conversationId: "c", userMessage: "x" });
    return builder.wrapUserMessage(context, "x");
  };

  const chat = await build("chat");
  assert.match(chat, /recent_task_events:/, "живому разговору журнал нужен");

  const action = await build("task_action");
  assert.doesNotMatch(action, /recent_task_events:/);
  assert.doesNotMatch(action, /upcoming_reminders:/);

  // Инициативе ближайшее напоминание остаётся: «не забудь про звонок» —
  // это разговор, а не сводка. Журнал прошедшего — нет.
  const initiative = await build("initiative");
  assert.doesNotMatch(initiative, /recent_task_events:/);
  assert.match(initiative, /upcoming_reminders:/);
});

// ---------------------------------------------------------------------
// Служебная ветка закрывается вместе с работой
// ---------------------------------------------------------------------

test("ветка задачи закрывается, чем бы заход ни кончился", async () => {
  // Она была вечной: одна на человека, и в ней копились все задания
  // подряд вместе с ответами на них. На новом задании модель видела
  // перед собой не задачу, а накопленное состояние трекера, и отвечала
  // человеку «Поняла, где остановились…» вместо погоды.
  const done = harness();
  await done.runner.execute(taskRow() as never);
  assert.deepEqual(done.closed, [{ userId: 7, agentId: "agent-7", purpose: "task_action" }]);

  // Неудачный заход оставляет после себя самый мусор, и повтору он
  // мешает больше всего — значит закрывать надо и его.
  const failed = harness({ fail: new Error("поиск не ответил") });
  await failed.runner.execute(taskRow() as never);
  assert.equal(failed.closed.length, 1);
  assert.equal(failed.closed[0]!.purpose, "task_action");
});

test("напоминание закрывает свою ветку, а не ветку действия", async () => {
  const layer = harness();
  await layer.runner.execute(taskRow({ kind: "reminder" }) as never);
  assert.deepEqual(layer.closed, [{ userId: 7, agentId: "agent-7", purpose: "scheduler" }]);
});

test("незакрытая ветка не роняет уже сделанную работу", async () => {
  // Результат человеку важнее уборки: отказ закрытия — это ровно то,
  // что было до сих пор, а не новая поломка.
  const layer = harness();
  (layer.runner as unknown as {
    purposes: { close: () => Promise<void> };
  }).purposes.close = async () => { throw new Error("App Server недоступен"); };

  await assert.doesNotReject(() => layer.runner.execute(taskRow() as never));
  assert.equal(layer.sent.length, 1, "результат обязан дойти");
});
