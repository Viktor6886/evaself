/**
 * Запись целей, результатов и задач из архива — только вставкой.
 *
 * Повтор — та же формулировка (у задач — то же название, время и повтор),
 * и считается он по количеству (`Multiset`): две одинаковые цели в файле
 * на чистом аккаунте дают две цели, а не одну. Ссылки листов друг на
 * друга — ключи файла («Ц1», «Р3»); идентификаторы базы из файла не
 * принимаются.
 */

import { assertCronExpression, nextCronDate } from "../time/cron.js";
import { fold, wallClock } from "./format.js";
import { Multiset, type ApplyContext } from "./import-context.js";
import { sheet } from "./sheets.js";

/** Чаще этого повтор из файла не принимается: «каждую минуту» — не напоминание, а поток. */
const MIN_REPEAT_MINUTES = 15;

export interface GoalLinks {
  goals: Map<string, number>;
  results: Map<string, { id: number; goalId: number }>;
}

/**
 * Порядок записи: родитель раньше потомка. Строка, чей родитель есть в
 * файле, ждёт его; цикл или ссылка в никуда записываются без родителя.
 */
function ordered<T extends { ref: string | null; parent: string | null }>(
  items: Array<{ row: number; value: T }>,
): Array<{ row: number; value: T }> {
  const refs = new Set(items.map((item) => item.value.ref).filter((ref): ref is string => ref !== null));
  const result: Array<{ row: number; value: T }> = [];
  const placed = new Set<string>();
  let pending = items.slice();
  while (pending.length > 0) {
    const next = pending.filter((item) => {
      const parent = item.value.parent;
      const ready = !parent || parent === item.value.ref || !refs.has(parent) || placed.has(parent);
      if (ready) {
        result.push(item);
        if (item.value.ref) placed.add(item.value.ref);
      }
      return !ready;
    });
    if (next.length === pending.length) {
      result.push(...next);
      break;
    }
    pending = next;
  }
  return result;
}

export async function applyGoals(ctx: ApplyContext): Promise<GoalLinks> {
  const links: GoalLinks = { goals: new Map(), results: new Map() };
  const { client, userId, parsed } = ctx;

  // ---- цели -----------------------------------------------------------
  if (parsed.goals.length > 0) {
    const counter = ctx.count("goals");
    const { rows } = await client.query<{ id: string; title: string }>(
      "SELECT id, title FROM goals WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    const existing = new Multiset<number>();
    for (const row of rows) existing.add(fold(row.title), Number(row.id));
    let downgraded = 0;
    for (const { row, value } of ordered(parsed.goals)) {
      const parentRef = value.parent && value.parent !== value.ref ? value.parent : null;
      const parentId = parentRef ? links.goals.get(parentRef) ?? null : null;
      if (parentRef && parentId === null) ctx.notice("Цели: родительская цель не найдена — цель загружена без неё", row);
      const known = existing.take(fold(value.title));
      if (known !== undefined) {
        if (value.ref) links.goals.set(value.ref, known);
        counter.existing += 1;
        continue;
      }
      // Активной цель бывает только подтверждённой (ограничение таблицы):
      // неподтверждённая «в работе» становится черновиком.
      const status = value.status === "active" && !value.user_confirmed ? "draft" : value.status;
      if (status !== value.status) downgraded += 1;
      const id = await ctx.insert(
        `INSERT INTO goals (
           user_id, parent_goal_id, life_area, horizon, title, why_it_matters, result_artifact, target_date,
           success_criteria, minimum_version, target_version, constraints, learning_goal, review_condition,
           stop_condition, priority, status, vector_stage, user_confirmed, confirmed_at, created_at, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::date, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18,
           $19, CASE WHEN $19 THEN now() ELSE NULL END, COALESCE($20::timestamptz, now()), $21::timestamptz
         )
         RETURNING id`,
        [
          userId, parentId, value.life_area, value.horizon, value.title, value.why_it_matters,
          value.result_artifact, value.target_date, JSON.stringify(value.success_criteria),
          value.minimum_version, value.target_version, JSON.stringify(value.constraints), value.learning_goal,
          value.review_condition, value.stop_condition, value.priority, status, value.vector_stage,
          value.user_confirmed, ctx.createdAt(value.created_at), ctx.instant(value.completed_at)?.toISOString() ?? null,
        ],
      );
      if (value.ref) links.goals.set(value.ref, id);
      counter.added += 1;
    }
    if (downgraded > 0) {
      ctx.warnings.push(`Цели «в работе» без отметки «Подтверждена мной» загружены черновиками: ${downgraded}.`);
    }
  }

  // ---- результаты целей -----------------------------------------------
  if (parsed.results.length > 0) {
    const counter = ctx.count("results");
    const { rows } = await client.query<{ id: string; goal_id: string; title: string }>(
      "SELECT id, goal_id, title FROM goal_results WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    const existing = new Multiset<number>();
    for (const row of rows) existing.add(`${row.goal_id}|${fold(row.title)}`, Number(row.id));
    for (const { row, value } of ordered(parsed.results)) {
      const goalId = links.goals.get(value.goal);
      if (goalId === undefined) {
        ctx.errors.push({ sheet: sheet("results").name, row, message: `цель «${value.goal}» не найдена на листе «Цели»` });
        continue;
      }
      const parent = value.parent && value.parent !== value.ref ? links.results.get(value.parent) : undefined;
      const parentId = parent && parent.goalId === goalId ? parent.id : null;
      const known = existing.take(`${goalId}|${fold(value.title)}`);
      if (known !== undefined) {
        if (value.ref) links.results.set(value.ref, { id: known, goalId });
        counter.existing += 1;
        continue;
      }
      const id = await ctx.insert(
        `INSERT INTO goal_results (
           user_id, goal_id, parent_result_id, title, result_artifact, success_criteria, minimum_version,
           target_date, sort_order, status, is_checkpoint, is_external, external_dependency,
           is_critical_path, fallback_plan, first_action, progress_percent, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8::date, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::timestamptz
         )
         RETURNING id`,
        [
          userId, goalId, parentId, value.title, value.result_artifact, JSON.stringify(value.success_criteria),
          value.minimum_version, value.target_date, value.sort_order, value.status, value.is_checkpoint,
          value.is_external, value.external_dependency, value.is_critical_path, value.fallback_plan,
          value.first_action, value.progress_percent, ctx.instant(value.completed_at)?.toISOString() ?? null,
        ],
      );
      if (value.ref) links.results.set(value.ref, { id, goalId });
      counter.added += 1;
    }
  }
  return links;
}

/** Повтор не чаще `MIN_REPEAT_MINUTES`: проверяются ближайшие срабатывания. */
function repeatsTooOften(cron: string, zone: string, now: Date): boolean {
  let previous = nextCronDate(cron, zone, now);
  for (let step = 0; step < 4; step += 1) {
    const next = nextCronDate(cron, zone, previous);
    if (next.getTime() - previous.getTime() < MIN_REPEAT_MINUTES * 60_000) return true;
    previous = next;
  }
  return false;
}

/**
 * Задачи. Повтор — то же название, то же время по стенным часам пояса
 * файла и тот же повтор. Время сравнивается стенными часами, а не
 * моментом: в час перевода часов 01:30 бывает дважды, и момент из файла
 * неоднозначен, а запись в файле — нет.
 */
export async function applyTasks(ctx: ApplyContext, links: GoalLinks): Promise<{ paused: number; scheduled: number }> {
  const { client, userId, parsed, now } = ctx;
  let paused = 0;
  let scheduled = 0;
  if (parsed.tasks.length === 0) return { paused, scheduled };
  const counter = ctx.count("tasks");
  const { rows } = await client.query<{ title: string; due_at: Date | null; remind_at: Date | null; cron_expression: string | null }>(
    "SELECT title, due_at, remind_at, cron_expression FROM tasks WHERE user_id = $1",
    [userId],
  );
  const key = (title: string, wall: string | null, cron: string | null) => `${fold(title)}|${wall ?? ""}|${cron ?? ""}`;
  const existing = new Multiset();
  for (const row of rows) {
    existing.add(key(row.title, wallClock(row.remind_at ?? row.due_at, parsed.zone), row.cron_expression), true);
  }
  for (const { row, value } of parsed.tasks) {
    if (existing.take(key(value.title, value.remind_at ?? value.due_at, value.cron_expression)) !== undefined) {
      counter.existing += 1;
      continue;
    }
    const zone = value.timezone ?? parsed.zone;
    try {
      if (value.cron_expression) {
        assertCronExpression(value.cron_expression, zone);
        if (value.repeat_enabled && repeatsTooOften(value.cron_expression, zone, now)) {
          throw new Error(`повтор чаще раза в ${MIN_REPEAT_MINUTES} минут из файла не загружается`);
        }
      }
    } catch (error) {
      ctx.errors.push({ sheet: sheet("tasks").name, row, message: `«Повтор (cron)»: ${(error as Error).message}` });
      continue;
    }
    const dueAt = ctx.instant(value.due_at);
    const remindAt = ctx.instant(value.remind_at);
    let goalId = value.goal ? links.goals.get(value.goal) ?? null : null;
    const result = value.result ? links.results.get(value.result) ?? null : null;
    if (value.goal && goalId === null) ctx.notice("Задачи: цель не найдена — задача загружена без цели", row);
    if (result) goalId = result.goalId;
    const open = value.status === "open" || value.status === "in_progress";
    // Задача-действие — поручение Еве. Из файла поручение не включается
    // само: файл мог прийти не от самого человека.
    const remindersEnabled = value.kind === "action" ? false : value.reminders_enabled;
    if (value.kind === "action" && open && value.reminders_enabled) paused += 1;
    let nextRunAt: Date | null = null;
    let lastRunAt: Date | null = null;
    if (open) {
      if (value.repeat_enabled && value.cron_expression) {
        nextRunAt = nextCronDate(value.cron_expression, zone, now);
      } else {
        nextRunAt = remindAt ?? dueAt;
        // Прошедший срок из архива — история, а не повод написать сейчас:
        // отметка о прошедшем запуске гасит напоминание.
        if (nextRunAt && nextRunAt.getTime() <= now.getTime()) lastRunAt = nextRunAt;
      }
      if (remindersEnabled && nextRunAt && !lastRunAt) scheduled += 1;
    }
    const taskId = await ctx.insert(
      `INSERT INTO tasks (
         user_id, title, description, status, priority, due_at, remind_at, completed_at, source,
         cron_expression, repeat_enabled, timezone, last_run_at, next_run_at, goal_id, goal_result_id,
         estimated_minutes, energy_required, kind, reminders_enabled, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, 'import', $9, $10, $11,
         $12::timestamptz, $13::timestamptz, $14, $15, $16, $17, $18, $19, COALESCE($20::timestamptz, now())
       )
       RETURNING id`,
      [
        userId, value.title, value.description, value.status, value.priority, dueAt?.toISOString() ?? null,
        remindAt?.toISOString() ?? null, open ? null : ctx.instant(value.completed_at)?.toISOString() ?? null,
        value.cron_expression, value.repeat_enabled, zone, lastRunAt?.toISOString() ?? null,
        nextRunAt?.toISOString() ?? null, goalId, result?.id ?? null, value.estimated_minutes,
        value.energy_required, value.kind, remindersEnabled, ctx.createdAt(value.created_at),
      ],
    );
    await ctx.run(
      `INSERT INTO task_events (user_id, task_id, event_type, scheduled_at, metadata)
       VALUES ($1, $2, 'created', $3::timestamptz, $4::jsonb)`,
      [userId, taskId, (remindAt ?? dueAt)?.toISOString() ?? null, JSON.stringify({ source: "archive_import" })],
    );
    counter.added += 1;
  }
  return { paused, scheduled };
}
