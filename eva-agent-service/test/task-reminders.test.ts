/**
 * Напоминания задачи отдельно от самой задачи и полный список задач.
 *
 * Ева сама описала оба недостатка. Погасить напоминание можно было только
 * вместе с задачей: даже без времени напоминания срок сам приводил к
 * напоминанию. А список из ~250 задач обрывался на середине: `get_tasks`
 * отдавал до сотни полных строк без смещения, и ответ инструмента
 * превышал предел Letta Code в 32 000 знаков.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { TaskToolFactory } from "../dist/tools/task-tools.js";
import { toolResult } from "../dist/tools/tool-executor.js";

const RUNTIME = {
  userId: 7,
  telegramId: 42,
  chatId: 42,
  conversationId: "conv-1",
  purpose: "chat" as const,
  timezone: "Europe/Moscow",
  responseMode: "text" as const,
  useEmoji: true,
};

interface Statement { sql: string; values: unknown[] }

function harness(tasks: Array<Record<string, unknown>> = []) {
  const statements: Statement[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    const flat = sql.replace(/\s+/gu, " ").trim();
    statements.push({ sql: flat, values });
    if (flat.startsWith("SELECT count(*) AS total FROM tasks")) {
      return { rows: [{ total: String(tasks.length) }], rowCount: 1 };
    }
    if (flat.startsWith("SELECT id, title, status")) {
      const [, , limit, offset] = values as [number, string | null, number, number];
      return { rows: tasks.slice(offset, offset + limit), rowCount: 0 };
    }
    if (flat.startsWith("UPDATE tasks SET reminders_enabled")) {
      const ids = values[1] as number[];
      const enabled = values[2] as boolean;
      const changed = tasks.filter((task) => ids.includes(Number(task.id)) && task.reminders_enabled !== enabled);
      for (const task of changed) task.reminders_enabled = enabled;
      return { rows: changed.map((task) => ({ id: String(task.id) })), rowCount: changed.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const db = { query, transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) => await work({ query }) };
  const factory = new TaskToolFactory(db as never);
  const tools = new Map(
    factory.build(((name, _label, _description, _parameters, execute) => ({
      name,
      execute: async (args: Record<string, unknown>) => await execute(args, RUNTIME, "call-1"),
    })) as never).map((tool: { name: string }) => [tool.name, tool]),
  );
  return { tools, statements };
}

function manyTasks(count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    id: String(index + 1),
    // Длинные названия: так страница упирается в предел знаков раньше,
    // чем в число задач.
    title: `Задача ${index + 1}: ${"подробное название дела ".repeat(6)}`,
    status: "open",
    kind: "reminder",
    priority: 3,
    due_at: new Date("2026-10-02T07:00:00Z"),
    remind_at: new Date("2026-10-02T06:30:00Z"),
    next_run_at: new Date("2026-10-02T06:30:00Z"),
    cron_expression: null,
    repeat_enabled: false,
    reminders_enabled: true,
    goal_id: null,
    description: null,
  }));
}

test("get_tasks: 250 задач проходятся страницами целиком, без повторов и пропусков", async () => {
  const tasks = manyTasks(250);
  const { tools } = harness(tasks);
  const seen: number[] = [];
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const page = await tools.get("get_tasks").execute({ offset, limit: 100 }) as {
      total: number; next_offset: number | null; returned: number; tasks: Array<{ id: number }>;
    };
    assert.equal(page.total, 250);
    // Ровно то, что уйдёт модели, помещается в предел Letta Code.
    const serialized = toolResult(page).content[0]!.text;
    assert.ok(serialized.length < 32_000, `страница ${pages + 1}: ${serialized.length} знаков — Letta Code её обрежет`);
    seen.push(...page.tasks.map((task) => task.id));
    offset = page.next_offset;
    pages += 1;
    assert.ok(pages < 50, "страницы не сходятся");
  }
  assert.deepEqual(seen, Array.from({ length: 250 }, (_value, index) => index + 1));
});

test("get_tasks: строки компактные — без служебных колонок и пустых полей", async () => {
  const tasks = manyTasks(1).map((task) => ({ ...task, locked_at: new Date(), attempts: 3, last_error: "секрет", user_id: "7" }));
  const { tools, statements } = harness(tasks);
  const page = await tools.get("get_tasks").execute({}) as { tasks: Array<Record<string, unknown>> };
  const [task] = page.tasks;
  assert.deepEqual(Object.keys(task!).sort(), ["due_at", "id", "kind", "next_run_at", "priority", "remind_at", "reminders_enabled", "status", "title"].sort());
  const select = statements.find((item) => item.sql.startsWith("SELECT id, title, status"))!;
  assert.doesNotMatch(select.sql, /SELECT \*/u);
  assert.match(select.sql, /WHERE user_id = \$1/u);
  assert.equal(select.values[0], RUNTIME.userId);
  assert.match(select.sql, /ORDER BY .* id DESC/u, "порядок однозначен до id — иначе страницы плывут");
});

test("set_task_reminders: выключает напоминания, не трогая задачи; только свои, только изменившиеся", async () => {
  const tasks = manyTasks(3);
  tasks[2]!.reminders_enabled = false;
  const { tools, statements } = harness(tasks);
  const result = await tools.get("set_task_reminders").execute({ ids: [1, 2, 3, 2, -5, "x"], enabled: false });
  assert.deepEqual(result, { ok: true, enabled: false, changed: 2, task_ids: [1, 2] });
  const update = statements.find((item) => item.sql.startsWith("UPDATE tasks SET reminders_enabled"))!;
  assert.match(update.sql, /WHERE user_id = \$1 AND id = ANY\(\$2::bigint\[\]\)/u);
  assert.equal(update.values[0], RUNTIME.userId);
  assert.deepEqual(update.values[1], [1, 2, 3], "id без повторов и мусора");
  assert.doesNotMatch(update.sql, /status|DELETE|due_at|remind_at/u, "задача сама не меняется");
  const events = statements.filter((item) => item.sql.startsWith("INSERT INTO task_events"));
  assert.equal(events.length, 2, "событие — только у изменившихся задач");

  const back = await tools.get("set_task_reminders").execute({ ids: [1], enabled: true }) as { changed: number };
  assert.equal(back.changed, 1);
  assert.equal(tasks[0]!.reminders_enabled, true);
});

test("set_task_reminders: без enabled или без id — отказ, а не догадка", async () => {
  const { tools } = harness(manyTasks(1));
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: [1] }), /enabled/u);
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: [1], enabled: "false" }), /enabled/u);
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: [], enabled: false }), /ids/u);
});

/**
 * Сторож: каждая выборка наступивших задач обязана пропускать задачи с
 * выключенными напоминаниями. Новый запрос планировщика, забывший это
 * условие, снова будет будить «выключенную» задачу.
 */
test("все выборки наступивших задач учитывают reminders_enabled", async () => {
  const root = join(import.meta.dirname, "..", "src");
  const files = ["background.ts", "jobs/proactive/selection.ts", "tasks/task-event-service.ts"];
  let checked = 0;
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    const queries = source.split("`").filter((part) => /FROM tasks/u.test(part)
      && /COALESCE\(\w*\.?next_run_at, \w*\.?remind_at, \w*\.?due_at\) (<=|>) now\(\)/u.test(part));
    for (const query of queries) {
      assert.match(query, /reminders_enabled/u, `${file}: выборка задач без reminders_enabled`);
      checked += 1;
    }
  }
  assert.equal(checked, 4, "фоновая выборка, её предпросмотр, проактивная выборка и ближайшие напоминания");
});
