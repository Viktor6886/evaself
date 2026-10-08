/**
 * Запись целей, результатов и задач из архива — только вставкой.
 *
 * Повтор — та же формулировка (у задач — то же название, время и повтор),
 * и считается он по количеству (`Multiset`): две одинаковые цели в файле
 * на чистом аккаунте дают две цели, а не одну. Ссылки листов друг на
 * друга — ключи файла («Ц1», «Р3»); идентификаторы базы из файла не
 * принимаются.
 */

import { assertCronExpression, cronFieldMatches, nextCronDate } from "../time/cron.js";
import { fold } from "./format.js";
import { Multiset, type ApplyContext } from "./import-context.js";
import { sheet } from "./sheets.js";

/** Чаще этого повтор из файла не принимается: «каждую минуту» — не напоминание, а поток. */
const MIN_REPEAT_MINUTES = 15;

/**
 * Столько разных повторов (выражение и пояс) один файл может принести.
 * Проверка каждого — поиск следующего срабатывания по календарю, у
 * «раз в год» это сотни шагов; одинаковые повторы считаются один раз.
 */
const MAX_SCHEDULES = 50;

export interface GoalLinks {
  goals: Map<string, number>;
  results: Map<string, { id: number; goalId: number }>;
}

/**
 * Порядок записи: родитель раньше потомка. Строка, чей родитель есть в
 * файле, ставится после него; цикл или ссылка в никуда записываются без
 * родителя. Один проход вверх по цепочке на строку: цепочка из тысяч
 * целей «потомок раньше родителя» не превращается в тысячи проходов.
 */
function ordered<T extends { ref: string | null; parent: string | null }>(
  items: Array<{ row: number; value: T }>,
): Array<{ row: number; value: T }> {
  type Item = { row: number; value: T };
  const byRef = new Map<string, Item>();
  for (const item of items) {
    if (item.value.ref && !byRef.has(item.value.ref)) byRef.set(item.value.ref, item);
  }
  const result: Item[] = [];
  const seen = new Set<Item>();
  for (const item of items) {
    const chain: Item[] = [];
    let current: Item | undefined = item;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const parent: string | null = current.value.parent;
      current = parent && parent !== current.value.ref ? byRef.get(parent) : undefined;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) result.push(chain[index]!);
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
      await ctx.pace();
      const parentRef = value.parent && value.parent !== value.ref ? value.parent : null;
      const parentId = parentRef ? links.goals.get(parentRef) ?? null : null;
      if (parentRef && parentId === null) ctx.notice("Цели: родительская цель не найдена — цель загружается без неё", row);
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
      ctx.warnings.push(`Цели «в работе» без отметки «Подтверждена мной» загружаются черновиками: ${downgraded}.`);
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
      await ctx.pace();
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

/**
 * Повтор чаще `MIN_REPEAT_MINUTES` — по самим полям минут и часов, без
 * перебора срабатываний: две разрешённые минуты ближе предела, или
 * последняя минута часа близко к первой, а часы идут подряд.
 */
export function repeatsTooOften(cron: string): boolean {
  const [minuteField = "", hourField = ""] = cron.trim().split(/\s+/);
  const minutes: number[] = [];
  for (let minute = 0; minute < 60; minute += 1) {
    if (cronFieldMatches(minuteField, minute, 0, 59)) minutes.push(minute);
  }
  const hours = new Set<number>();
  for (let hour = 0; hour < 24; hour += 1) {
    if (cronFieldMatches(hourField, hour, 0, 23)) hours.add(hour);
  }
  for (let index = 1; index < minutes.length; index += 1) {
    if (minutes[index]! - minutes[index - 1]! < MIN_REPEAT_MINUTES) return true;
  }
  const consecutiveHours = [...hours].some((hour) => hours.has((hour + 1) % 24));
  const first = minutes[0];
  const last = minutes.at(-1);
  return consecutiveHours && first !== undefined && last !== undefined && 60 - last + first < MIN_REPEAT_MINUTES;
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
    existing.add(key(row.title, ctx.wall(row.remind_at ?? row.due_at), row.cron_expression), true);
  }
  // Повтор проверяется и считается один раз на выражение и пояс.
  const schedules = new Map<string, Date | Error>();
  const schedule = (cron: string, zone: string, repeating: boolean): Date => {
    const id = `${zone} ${cron}`;
    let known = schedules.get(id);
    if (known === undefined) {
      if (schedules.size >= MAX_SCHEDULES) {
        throw new Error(`больше ${MAX_SCHEDULES} разных повторов в одном файле — загрузи этот же файл ещё раз, добавятся следующие`);
      }
      try {
        assertCronExpression(cron, zone);
        known = nextCronDate(cron, zone, now);
      } catch (error) {
        known = error as Error;
      }
      schedules.set(id, known);
    }
    if (known instanceof Error) throw known;
    if (repeating && repeatsTooOften(cron)) {
      throw new Error(`повтор чаще раза в ${MIN_REPEAT_MINUTES} минут из файла не загружается`);
    }
    return known;
  };
  for (const { row, value } of parsed.tasks) {
    // Время из файла — через момент и обратно: несуществующее 02:30 ночи
    // перевода часов база хранит как 03:30, и сравнивать надо с ним.
    await ctx.pace();
    const wall = value.remind_at ?? value.due_at;
    const stored = wall === null ? null : ctx.wall(ctx.instant(wall));
    if (existing.take(key(value.title, stored, value.cron_expression)) !== undefined) {
      counter.existing += 1;
      continue;
    }
    const zone = value.timezone ?? parsed.zone;
    let next: Date | null = null;
    try {
      if (value.cron_expression) next = schedule(value.cron_expression, zone, value.repeat_enabled);
    } catch (error) {
      ctx.errors.push({ sheet: sheet("tasks").name, row, message: `«Повтор (cron)»: ${(error as Error).message}` });
      continue;
    }
    const dueAt = ctx.instant(value.due_at);
    const remindAt = ctx.instant(value.remind_at);
    let goalId = value.goal ? links.goals.get(value.goal) ?? null : null;
    const result = value.result ? links.results.get(value.result) ?? null : null;
    if (value.goal && goalId === null) ctx.notice("Задачи: цель не найдена — задача загружается без цели", row);
    if (result) goalId = result.goalId;
    const open = value.status === "open" || value.status === "in_progress";
    // Задача-действие — поручение Еве. Из файла поручение не включается
    // само: файл мог прийти не от самого человека.
    const remindersEnabled = value.kind === "action" ? false : value.reminders_enabled;
    if (value.kind === "action" && open && value.reminders_enabled) paused += 1;
    let nextRunAt: Date | null = null;
    let lastRunAt: Date | null = null;
    if (open) {
      if (value.repeat_enabled && next) {
        nextRunAt = next;
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
