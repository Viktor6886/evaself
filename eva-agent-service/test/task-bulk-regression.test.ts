import assert from "node:assert/strict";
import { test } from "node:test";

import { preferredResponseLanguage, t } from "../dist/i18n/index.js";
import { TaskToolFactory } from "../dist/tools/task-tools.js";
import { recordToolFallback } from "../dist/turns/tool-fallback.js";
import { runInScope, userScope } from "../dist/tenancy/index.js";

const RUNTIME = {
  userId: 7,
  telegramId: 42,
  chatId: 42,
  conversationId: "conv-1",
  purpose: "chat" as const,
  timezone: "Europe/Amsterdam",
  responseMode: "text" as const,
  useEmoji: true,
};

function taskHarness() {
  let transactionCount = 0;
  let nextId = 1;
  const committedTasks: Array<Record<string, unknown>> = [];
  const committedEvents: Array<Record<string, unknown>> = [];

  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(work: (client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>) => {
      transactionCount += 1;
      const stagedTasks: Array<Record<string, unknown>> = [];
      const stagedEvents: Array<Record<string, unknown>> = [];
      const client = {
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("SELECT id FROM goals")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("SELECT goal_id FROM goal_results")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("SELECT goal_id, goal_result_id FROM work_blocks")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("INSERT INTO tasks")) {
            const task = { id: nextId++, title: values[1] };
            stagedTasks.push(task);
            return { rows: [task], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO task_events")) {
            const event = { task_id: values[1], event_type: "created" };
            stagedEvents.push(event);
            return { rows: [event], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };

      try {
        const result = await work(client);
        committedTasks.push(...stagedTasks);
        committedEvents.push(...stagedEvents);
        return result;
      } catch (error) {
        throw error;
      }
    },
  };

  const factory = new TaskToolFactory(db as never);
  const tools = new Map(
    factory.build(((name, _label, _description, _parameters, execute) => ({
      name,
      execute: async (toolCallId: string, args: Record<string, unknown>) =>
        await execute(args, RUNTIME, toolCallId),
    })) as never).map((tool) => [tool.name, tool]),
  );

  return {
    tools,
    committedTasks,
    committedEvents,
    transactionCount: () => transactionCount,
  };
}

test("save_tasks_bulk commits all tasks in one transaction and returns a compact result", async () => {
  const harness = taskHarness();
  const tool = harness.tools.get("save_tasks_bulk");
  assert.ok(tool);

  const result = await tool.execute("bulk-1", {
    tasks: [
      { title: "Занятие 1", due_at: "2026-09-21T09:00:00" },
      { title: "Занятие 2", due_at: "2026-09-22T09:00:00" },
    ],
  }) as Record<string, unknown>;

  assert.deepEqual(result, { ok: true, created: 2, task_ids: [1, 2] });
  assert.equal(harness.transactionCount(), 1);
  assert.equal(harness.committedTasks.length, 2);
  assert.equal(harness.committedEvents.length, 2);
  assert.equal(Object.hasOwn(result, "tasks"), false, "bulk must not echo full task rows to the model");
});

test("save_tasks_bulk rolls back earlier inserts when a later task fails ownership validation", async () => {
  const harness = taskHarness();
  const tool = harness.tools.get("save_tasks_bulk");
  assert.ok(tool);

  await assert.rejects(
    async () => await tool.execute("bulk-2", {
      tasks: [
        { title: "Успела бы записаться первой" },
        { title: "Ошибка связи", goal_id: 999 },
      ],
    }),
    /Цель 999 не найдена/,
  );

  assert.equal(harness.transactionCount(), 1);
  assert.equal(harness.committedTasks.length, 0, "partial bulk writes must be rolled back");
  assert.equal(harness.committedEvents.length, 0, "created events must roll back with tasks");
});

test("emptyReply reports successful bulk action instead of asking the user to rephrase", async () => {
  await runInScope(userScope({ userId: 7, label: "tool-fallback-test" }), async () => {
    preferredResponseLanguage({ id: 7, language_code: "ru" });
    recordToolFallback(7, "save_tasks_bulk", { ok: true, created: 41 });
    assert.equal(t("ru", "emptyReply"), "Готово. Сохранено задач: 41.");
  });
});

test("a new user turn clears an unconsumed tool fallback from the previous turn", async () => {
  await runInScope(userScope({ userId: 7, label: "tool-fallback-reset-test" }), async () => {
    recordToolFallback(7, "save_tasks_bulk", { ok: true, created: 41 });
    preferredResponseLanguage({ id: 7, language_code: "ru" });
    assert.equal(
      t("ru", "emptyReply"),
      "Не удалось сформировать текстовый ответ. Попробуй отправить сообщение ещё раз.",
    );
  });
});
