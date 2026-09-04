import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";
import { purposePolicy } from "../dist/conversations/purpose-service.js";
import { TaskEventService } from "../dist/tasks/task-event-service.js";
import { ScheduledTaskRunner } from "../dist/tasks/task-runner.js";
import {
  ACTION_DAILY_LIMIT,
  MAX_ATTEMPTS,
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
} = {}) {
  const db = options.db ?? fakeDb();
  const turns: Array<{ conversationId: string; prompt: string }> = [];
  const sent: Array<{ chatId: number; text: string }> = [];
  const letta = {
    runTurn: async (conversationId: string, prompt: string) => {
      turns.push({ conversationId, prompt });
      if (options.fail) throw options.fail;
      return { reply: options.reply ?? "Вот три новости Перми на сегодня: …" };
    },
  };
  const telegram = {
    configured: true,
    withPriority: async (_priority: string, work: () => Promise<unknown>) => await work(),
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
    } as never,
    new TaskEventService(db as never),
    logger,
  );
  return { db, runner, turns, sent };
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
  assert.match(action, /дай сам результат/);
  assert.equal(action.includes("верни только готовый текст"), false);

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
