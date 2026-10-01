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

interface Statement { sql: string; values: unknown[]; inTransaction: boolean }

function harness(tasks: Array<Record<string, unknown>> = []) {
  const statements: Statement[] = [];
  let inTransaction = false;
  const query = async (sql: string, values: unknown[] = []) => {
    const flat = sql.replace(/\s+/gu, " ").trim();
    statements.push({ sql: flat, values, inTransaction });
    if (flat.startsWith("SELECT count(*) AS total FROM tasks")) {
      return { rows: [{ total: String(tasks.length) }], rowCount: 1 };
    }
    if (flat.startsWith("SELECT id, left(title")) {
      const [, , limit, afterId] = values as [number, string | null, number, number];
      // Поддельная база исполняет ровно то, что важно для курсора:
      // id > after_id и порядок по id (в режиме order=id).
      const byId = /ORDER BY id LIMIT/u.test(flat);
      const ordered = byId ? [...tasks].sort((a, b) => Number(a.id) - Number(b.id)) : tasks;
      return { rows: ordered.filter((task) => Number(task.id) > afterId).slice(0, limit), rowCount: 0 };
    }
    if (flat.startsWith("UPDATE tasks SET reminders_enabled")) {
      const ids = values[1] as number[];
      const enabled = values[2] as boolean;
      const changed = tasks.filter((task) => ids.includes(Number(task.id)) && task.reminders_enabled !== enabled);
      for (const task of changed) task.reminders_enabled = enabled;
      return {
        rows: changed.map((task) => ({
          id: String(task.id),
          cron_expression: task.cron_expression ?? null,
          repeat_enabled: task.repeat_enabled ?? false,
          timezone: null,
          scheduled_at: task.next_run_at ?? task.remind_at ?? task.due_at ?? null,
          last_run_at: task.last_run_at ?? null,
        })),
        rowCount: changed.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const db = {
    query,
    transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) => {
      inTransaction = true;
      try { return await work({ query }); } finally { inTransaction = false; }
    },
  };
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
    cron_expression: null as string | null,
    repeat_enabled: false,
    reminders_enabled: true,
    goal_id: null,
    description: null,
    last_run_at: null as Date | null,
  }));
}

type Page = { total: number; next_after_id: number | null; returned: number; note?: string; tasks: Array<{ id: number }> };

test("get_tasks: 250 задач проходятся курсором целиком, каждая страница в пределе ответа", async () => {
  const tasks = manyTasks(250);
  const { tools } = harness(tasks);
  const seen: number[] = [];
  let after: number | null = 0;
  let pages = 0;
  while (after !== null) {
    const page = await tools.get("get_tasks").execute({ order: "id", after_id: after, limit: 100 }) as Page;
    assert.equal(page.total, 250);
    // Ровно то, что уйдёт модели, помещается в предел Letta Code.
    const serialized = toolResult(page).content[0]!.text;
    assert.ok(serialized.length < 32_000, `страница ${pages + 1}: ${serialized.length} знаков — Letta Code её обрежет`);
    seen.push(...page.tasks.map((task) => task.id));
    after = page.next_after_id;
    pages += 1;
    assert.ok(pages < 50, "страницы не сходятся");
  }
  assert.deepEqual(seen, Array.from({ length: 250 }, (_value, index) => index + 1));
});

test("get_tasks: изменения между страницами не дают повторов и пропусков", async () => {
  const tasks = manyTasks(120);
  const { tools } = harness(tasks);
  const first = await tools.get("get_tasks").execute({ order: "id", limit: 50 }) as Page;
  // Между страницами: планировщик сдвинул сроки, человек закрыл и удалил
  // уже показанные задачи и завёл новую.
  for (const task of tasks) task.next_run_at = new Date(Date.now() + Math.random() * 1e9);
  tasks.splice(0, 10);
  tasks.push({ ...manyTasks(1)[0]!, id: "500" });
  const seen = first.tasks.map((task) => task.id);
  let after = first.next_after_id;
  while (after !== null) {
    const page = await tools.get("get_tasks").execute({ order: "id", after_id: after, limit: 50 }) as Page;
    seen.push(...page.tasks.map((task) => task.id));
    after = page.next_after_id;
  }
  assert.equal(new Set(seen).size, seen.length, "задача повторилась");
  for (let id = 1; id <= 120; id += 1) assert.ok(seen.includes(id), `задача ${id} пропущена`);
  assert.ok(seen.includes(500), "новая задача не попала в обход");
});

test("get_tasks по расписанию — ближайшие одной страницей и подсказка, как пройти весь список", async () => {
  const { tools } = harness(manyTasks(80));
  const page = await tools.get("get_tasks").execute({ limit: 20 }) as Page;
  assert.equal(page.returned, 20);
  assert.equal(page.next_after_id, null, "курсор — только у порядка по id");
  assert.match(page.note ?? "", /order=id/u);
});

test("get_tasks: строки компактные, название ограничено, запрос — только своих", async () => {
  const tasks = manyTasks(1).map((task) => ({ ...task, locked_at: new Date(), attempts: 3, last_error: "секрет", user_id: "7" }));
  const { tools, statements } = harness(tasks);
  const page = await tools.get("get_tasks").execute({}) as { tasks: Array<Record<string, unknown>> };
  const [task] = page.tasks;
  assert.deepEqual(Object.keys(task!).sort(), ["due_at", "id", "kind", "next_run_at", "priority", "remind_at", "reminders_enabled", "status", "title"].sort());
  const select = statements.find((item) => item.sql.startsWith("SELECT id, left(title"))!;
  assert.match(select.sql, /left\(title, 500\)/u, "одно огромное название не выносит страницу за предел");
  assert.match(select.sql, /WHERE user_id = \$1/u);
  assert.equal(select.values[0], RUNTIME.userId);
});

test("set_task_reminders: выключает напоминания, не трогая задачи; события — в той же транзакции", async () => {
  const tasks = manyTasks(3);
  tasks[2]!.reminders_enabled = false;
  const { tools, statements } = harness(tasks);
  const result = await tools.get("set_task_reminders").execute({ ids: [1, 2, 3, 2], enabled: false });
  assert.deepEqual(result, { ok: true, enabled: false, changed: 2, task_ids: [1, 2] });
  const update = statements.find((item) => item.sql.startsWith("UPDATE tasks SET reminders_enabled"))!;
  assert.match(update.sql, /WHERE user_id = \$1 AND id = ANY\(\$2::bigint\[\]\)/u);
  assert.equal(update.values[0], RUNTIME.userId);
  assert.deepEqual(update.values[1], [1, 2, 3]);
  assert.doesNotMatch(update.sql, /status|DELETE|due_at =|remind_at =|locked_at/u, "задача и захват планировщика не трогаются");
  const insert = statements.find((item) => item.sql.startsWith("INSERT INTO task_events"))!;
  assert.equal(insert.inTransaction, true, "событие пишется в той же транзакции, что и изменение");
  assert.equal(update.inTransaction, true);
  assert.deepEqual(insert.values[1], [1, 2]);
});

test("включение: прошедший срок не срабатывает задним числом", async () => {
  const past = new Date(Date.now() - 3 * 3_600_000);
  const future = new Date(Date.now() + 3_600_000);
  const tasks = manyTasks(4).map((task) => ({ ...task, reminders_enabled: false }));
  // 1 — разовая просроченная, 2 — повторяющаяся просроченная,
  // 3 — разовая в будущем, 4 — разовая, срок которой уже отработан.
  Object.assign(tasks[0]!, { next_run_at: past, remind_at: past, due_at: past });
  Object.assign(tasks[1]!, { next_run_at: past, cron_expression: "0 9 * * *", repeat_enabled: true });
  Object.assign(tasks[2]!, { next_run_at: future });
  Object.assign(tasks[3]!, { next_run_at: past, last_run_at: new Date(past.getTime() + 1_000) });
  const { tools, statements } = harness(tasks);
  const result = await tools.get("set_task_reminders").execute({ ids: [1, 2, 3, 4], enabled: true }) as {
    changed: number; overdue_ids?: number[]; note?: string;
  };
  assert.equal(result.changed, 4);
  assert.deepEqual(result.overdue_ids, [1], "разовой просроченной нужно новое время");
  assert.match(result.note ?? "", /snooze_task_reminder/u);
  const passed = statements.filter((item) => item.sql.startsWith("UPDATE tasks SET last_run_at"));
  assert.deepEqual(passed.map((item) => item.values[0]), [1]);
  assert.equal(passed[0]!.values[2], past.toISOString(), "срок считается состоявшимся — выборка его не возьмёт");
  const shifted = statements.filter((item) => item.sql.startsWith("UPDATE tasks SET next_run_at"));
  assert.deepEqual(shifted.map((item) => item.values[0]), [2]);
  assert.ok(new Date(String(shifted[0]!.values[2])).getTime() > Date.now(), "повторяющаяся продолжает со следующего раза");
  for (const item of [...passed, ...shifted]) {
    assert.match(item.sql, /WHERE id = \$1 AND user_id = \$2/u);
    assert.equal(item.values[1], RUNTIME.userId);
    assert.equal(item.inTransaction, true);
  }
});

test("set_task_reminders: id только целыми числами; без enabled или id — отказ, а не догадка", async () => {
  const { tools, statements } = harness(manyTasks(3));
  await tools.get("set_task_reminders").execute({ ids: [1, true, "2", [3], -5, 1.5], enabled: false });
  const update = statements.find((item) => item.sql.startsWith("UPDATE tasks SET reminders_enabled"))!;
  assert.deepEqual(update.values[1], [1], "true, строка и массив за id не принимаются");
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: [1] }), /enabled/u);
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: [1], enabled: "false" }), /enabled/u);
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: [], enabled: false }), /ids/u);
  await assert.rejects(() => tools.get("set_task_reminders").execute({ ids: Array.from({ length: 101 }, (_v, i) => i + 1), enabled: false }), /100/u);
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
