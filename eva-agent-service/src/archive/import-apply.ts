/**
 * Запись разобранного архива в базу — только добавлением.
 *
 * Главное правило загрузки: файл дополняет то, что есть у Евы, и ничего
 * не заменяет. Поэтому здесь нет ни одного UPDATE существующего значения:
 * строки только вставляются, повтор уже имеющейся записи пропускается, а
 * «дополнение» — это заполнение пустого места (имя в профиле, где имени
 * нет; ответ анкеты, на который ответа не было).
 *
 * Повтор узнаётся по содержанию, а не по идентификатору: архив, загруженный
 * дважды, второй раз ничего не добавляет. Ключ повтора у каждой таблицы
 * свой и описан у её раздела.
 *
 * Всё выполняется одной транзакцией вызывающего: файл ложится целиком
 * или не ложится вовсе. Предпросмотр — та же запись с откатом в конце,
 * поэтому числа предпросмотра совпадают с тем, что запишется.
 */

import { assertCronExpression, nextCronDate } from "../time/cron.js";
import { normalizeProfileValue } from "../profile/profile-service.js";
import { fold, instantOf } from "./format.js";
import { applyEntries, type ApplyClient, type Counter } from "./import-entries.js";
import type { ParsedArchive, RowError } from "./import-types.js";
import { sheet, type SheetId } from "./sheets.js";

export type { ApplyClient } from "./import-entries.js";

export interface SheetReport {
  id: SheetId;
  name: string;
  added: number;
  existing: number;
}

export interface ImportReport {
  recognized: boolean;
  sheets: SheetReport[];
  added_total: number;
  existing_total: number;
  /** Первые ошибки строк; всего их `error_count`. */
  errors: RowError[];
  error_count: number;
  warnings: string[];
  /** Задачи-действия, загруженные выключенными. */
  paused_actions: number;
  read_only_sheets: string[];
  /** Текст для передачи Еве в чате: память из файла сама в память не пишется. */
  memory_handoff: string | null;
}

const ERROR_LIMIT = 100;
const HANDOFF_LIMIT = 3_500;

export async function applyArchive(
  client: ApplyClient,
  input: { userId: number; parsed: ParsedArchive; now: Date },
): Promise<ImportReport> {
  const { userId, parsed, now } = input;
  const errors: RowError[] = [...parsed.errors];
  const warnings: string[] = [...parsed.warnings];
  const counters = new Map<SheetId, Counter>();
  const count = (id: SheetId): Counter => {
    const existing = counters.get(id);
    if (existing) return existing;
    const created = { added: 0, existing: 0 };
    counters.set(id, created);
    return created;
  };
  const instant = (wall: string | null): Date | null => (wall === null ? null : instantOf(wall, parsed.zone));
  /** Момент создания из файла; будущее время — опечатка, а не история. */
  const createdAt = (wall: string | null): string | null => {
    const value = instant(wall);
    return value && value.getTime() <= now.getTime() ? value.toISOString() : null;
  };

  // Две загрузки одного человека не идут параллельно: обе прочли бы
  // базу до записи другой и вставили бы одни и те же строки.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`evaself.archive.import:${userId}`]);
  await client.query("SET LOCAL statement_timeout = '120s'");

  // ---- профиль: заполняется только пустое -----------------------------
  if (parsed.profile) {
    const counter = count("profile");
    const current = (await client.query<Record<string, string | null>>(
      "SELECT first_name, last_name, city, country_code, timezone, timezone_source FROM users WHERE id = $1",
      [userId],
    )).rows[0];
    if (current) {
      const sets: string[] = [];
      const values: unknown[] = [userId];
      const fill = (column: "first_name" | "last_name" | "city" | "country_code", value: string | undefined) => {
        if (!value) return;
        if ((current[column] ?? "").trim()) {
          counter.existing += 1;
          return;
        }
        values.push(value);
        sets.push(`${column} = $${values.length}`);
        counter.added += 1;
      };
      fill("first_name", parsed.profile.first_name);
      fill("last_name", parsed.profile.last_name);
      fill("city", parsed.profile.city);
      fill("country_code", parsed.profile.country_code);
      // Пояс «UTC» без источника — значение по умолчанию, а не выбор
      // человека: его можно заполнить. Выбранный пояс не трогается.
      if (parsed.profile.timezone) {
        if (current.timezone_source === null && current.timezone === "UTC") {
          values.push(parsed.profile.timezone);
          sets.push(`timezone = $${values.length}`, "timezone_source = 'import'", "timezone_updated_at = now()");
          counter.added += 1;
        } else {
          counter.existing += 1;
        }
      }
      if (sets.length > 0) {
        await client.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
      }
    }
    const candidates: Array<[string, string | boolean | undefined]> = [
      ["response_mode", parsed.profile.response_mode],
      ["agent_mode", parsed.profile.agent_mode],
      ["use_emoji", parsed.profile.use_emoji],
      ["heartbeat_enabled", parsed.profile.heartbeat_enabled],
    ];
    const preferences = candidates.filter((entry) => entry[1] !== undefined);
    if (preferences.length > 0) {
      // Настройки — одна строка на человека. Есть строка — человек уже
      // что-то выбирал, и файл её не трогает.
      const { rows } = await client.query(
        `INSERT INTO user_preferences (user_id, ${preferences.map(([column]) => column).join(", ")})
         VALUES ($1, ${preferences.map((_, index) => `$${index + 2}`).join(", ")})
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id`,
        [userId, ...preferences.map(([, value]) => value)],
      );
      if (rows.length > 0) counter.added += preferences.length;
      else counter.existing += preferences.length;
    }
  }

  // ---- анкета: ответ пишется туда, где ответа нет ---------------------
  if (parsed.questionnaire.length > 0) {
    const counter = count("questionnaire");
    const { rows: definitions } = await client.query<{ field_key: string; value_type: "string" | "string_array" | "object" }>(
      "SELECT field_key, value_type FROM profile_field_definitions WHERE enabled",
    );
    const types = new Map(definitions.map((row) => [row.field_key, row.value_type]));
    for (const { row, value } of parsed.questionnaire) {
      const type = types.get(value.field_key);
      if (!type) {
        errors.push({ sheet: sheet("questionnaire").name, row, message: `поле «${value.field_key}» Еве неизвестно` });
        continue;
      }
      let normalized: { text: string | null; json: unknown };
      try {
        const raw = value.field_key === "grammatical_gender" ? gender(value.value) : value.value;
        normalized = normalizeProfileValue(type === "object" ? JSON.parse(raw) as unknown : raw, type);
      } catch (error) {
        errors.push({
          sheet: sheet("questionnaire").name,
          row,
          message: error instanceof SyntaxError ? "ответ должен быть JSON-объектом" : (error as Error).message,
        });
        continue;
      }
      const { rows } = await client.query(
        `INSERT INTO onboarding_fields
           (user_id, field_key, field_value, field_json, status, confidence, source_type, confirmed_at, sensitivity)
         SELECT $1, d.field_key, $3, $4::jsonb, $5, 1, 'archive_import',
                CASE WHEN $5 = 'confirmed' THEN now() ELSE NULL END, d.sensitivity
           FROM profile_field_definitions d
          WHERE d.field_key = $2
         ON CONFLICT (user_id, field_key) DO UPDATE SET
           field_value = EXCLUDED.field_value,
           field_json = EXCLUDED.field_json,
           status = EXCLUDED.status,
           confidence = EXCLUDED.confidence,
           source_type = EXCLUDED.source_type,
           confirmed_at = EXCLUDED.confirmed_at,
           answered_at = now(),
           updated_at = now()
         WHERE onboarding_fields.status = 'missing'
           AND onboarding_fields.field_value IS NULL
           AND onboarding_fields.field_json IS NULL
         RETURNING id`,
        [userId, value.field_key, normalized.text, normalized.json === null ? null : JSON.stringify(normalized.json), value.status],
      );
      if (rows.length > 0) counter.added += 1;
      else counter.existing += 1;
    }
  }

  // ---- направление: одна строка на человека ---------------------------
  if (parsed.north) {
    const counter = count("north");
    const north = parsed.north;
    const { rows } = await client.query(
      `INSERT INTO user_north (
         user_id, desired_direction, why_it_matters, values, acceptable_cost,
         unacceptable_cost, conflicts, reduce_list, user_confirmed, confirmed_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, CASE WHEN $9 THEN now() ELSE NULL END)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [
        userId, north.desired_direction, north.why_it_matters, JSON.stringify(north.values),
        north.acceptable_cost, north.unacceptable_cost, JSON.stringify(north.conflicts),
        JSON.stringify(north.reduce_list), north.user_confirmed,
      ],
    );
    if (rows.length > 0) counter.added += 1;
    else counter.existing += 1;
  }

  // ---- цели: повтор — та же формулировка -------------------------------
  const goalIds = new Map<string, number>();
  if (parsed.goals.length > 0) {
    const counter = count("goals");
    const { rows } = await client.query<{ id: string; title: string }>(
      "SELECT id, title FROM goals WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    const byTitle = new Map<string, number>();
    for (const row of rows) if (!byTitle.has(fold(row.title))) byTitle.set(fold(row.title), Number(row.id));
    const refs = new Set(parsed.goals.map((item) => item.value.ref).filter((item): item is string => item !== null));
    let downgraded = 0;
    for (const { row, value } of ordered(parsed.goals, refs, goalIds)) {
      const parentId = value.parent && value.parent !== value.ref ? goalIds.get(value.parent) ?? null : null;
      if (value.parent && parentId === null && value.parent !== value.ref) {
        warnings.push(`Цели, строка ${row}: цель «${value.parent}» не найдена — цель загружена без неё.`);
      }
      const known = byTitle.get(fold(value.title));
      if (known !== undefined) {
        if (value.ref) goalIds.set(value.ref, known);
        counter.existing += 1;
        continue;
      }
      // Активной цель бывает только подтверждённой (ограничение таблицы):
      // неподтверждённая «в работе» становится черновиком.
      const status = value.status === "active" && !value.user_confirmed ? "draft" : value.status;
      if (status !== value.status) downgraded += 1;
      const { rows: inserted } = await client.query<{ id: string }>(
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
          value.user_confirmed, createdAt(value.created_at), instant(value.completed_at)?.toISOString() ?? null,
        ],
      );
      const id = Number(inserted[0]!.id);
      byTitle.set(fold(value.title), id);
      if (value.ref) goalIds.set(value.ref, id);
      counter.added += 1;
    }
    if (downgraded > 0) {
      warnings.push(`Цели «в работе» без отметки «Подтверждена мной» загружены черновиками: ${downgraded}.`);
    }
  }

  // ---- результаты целей: повтор — та же формулировка в той же цели ----
  const resultIds = new Map<string, { id: number; goalId: number }>();
  if (parsed.results.length > 0) {
    const counter = count("results");
    const { rows } = await client.query<{ id: string; goal_id: string; title: string }>(
      "SELECT id, goal_id, title FROM goal_results WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    const known = new Map<string, number>();
    for (const row of rows) known.set(`${row.goal_id}|${fold(row.title)}`, Number(row.id));
    const refs = new Set(parsed.results.map((item) => item.value.ref).filter((item): item is string => item !== null));
    for (const { row, value } of ordered(parsed.results, refs, resultIds)) {
      const goalId = goalIds.get(value.goal);
      if (goalId === undefined) {
        errors.push({ sheet: sheet("results").name, row, message: `цель «${value.goal}» не найдена на листе «Цели»` });
        continue;
      }
      const parent = value.parent && value.parent !== value.ref ? resultIds.get(value.parent) : undefined;
      const parentId = parent && parent.goalId === goalId ? parent.id : null;
      const key = `${goalId}|${fold(value.title)}`;
      const existing = known.get(key);
      if (existing !== undefined) {
        if (value.ref) resultIds.set(value.ref, { id: existing, goalId });
        counter.existing += 1;
        continue;
      }
      const { rows: inserted } = await client.query<{ id: string }>(
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
          value.first_action, value.progress_percent, instant(value.completed_at)?.toISOString() ?? null,
        ],
      );
      const id = Number(inserted[0]!.id);
      known.set(key, id);
      if (value.ref) resultIds.set(value.ref, { id, goalId });
      counter.added += 1;
    }
  }

  // ---- задачи: повтор — то же название, время и повтор -----------------
  let pausedActions = 0;
  if (parsed.tasks.length > 0) {
    const counter = count("tasks");
    const { rows } = await client.query<{ title: string; due_at: Date | null; remind_at: Date | null; cron_expression: string | null }>(
      "SELECT title, due_at, remind_at, cron_expression FROM tasks WHERE user_id = $1",
      [userId],
    );
    const fingerprint = (title: string, at: Date | null, cron: string | null) =>
      `${fold(title)}|${at ? at.getTime() : ""}|${cron ?? ""}`;
    const known = new Set(rows.map((row) => fingerprint(row.title, row.remind_at ?? row.due_at, row.cron_expression)));
    for (const { row, value } of parsed.tasks) {
      const zone = value.timezone ?? parsed.zone;
      const dueAt = instant(value.due_at);
      const remindAt = instant(value.remind_at);
      const key = fingerprint(value.title, remindAt ?? dueAt, value.cron_expression);
      if (known.has(key)) {
        counter.existing += 1;
        continue;
      }
      try {
        if (value.cron_expression) assertCronExpression(value.cron_expression, zone);
      } catch (error) {
        errors.push({ sheet: sheet("tasks").name, row, message: `«Повтор (cron)»: ${(error as Error).message}` });
        continue;
      }
      let goalId = value.goal ? goalIds.get(value.goal) ?? null : null;
      const result = value.result ? resultIds.get(value.result) ?? null : null;
      if (value.goal && goalId === null) warnings.push(`Задачи, строка ${row}: цель «${value.goal}» не найдена — задача без цели.`);
      if (result) goalId = result.goalId;
      const open = value.status === "open" || value.status === "in_progress";
      // Задача-действие — это поручение Еве. Из файла поручение не
      // включается само: файл мог прийти не от самого человека.
      const remindersEnabled = value.kind === "action" ? false : value.reminders_enabled;
      if (value.kind === "action" && open && value.reminders_enabled) pausedActions += 1;
      let nextRunAt: Date | null = null;
      let lastRunAt: Date | null = null;
      if (open) {
        if (value.repeat_enabled && value.cron_expression) {
          nextRunAt = nextCronDate(value.cron_expression, zone, now);
        } else {
          nextRunAt = remindAt ?? dueAt;
          // Прошедший срок из архива — история, а не повод написать
          // сейчас: отметка о прошедшем запуске гасит напоминание.
          if (nextRunAt && nextRunAt.getTime() <= now.getTime()) lastRunAt = nextRunAt;
        }
      }
      const { rows: inserted } = await client.query<{ id: string }>(
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
          remindAt?.toISOString() ?? null, open ? null : instant(value.completed_at)?.toISOString() ?? null,
          value.cron_expression, value.repeat_enabled, zone, lastRunAt?.toISOString() ?? null,
          nextRunAt?.toISOString() ?? null, goalId, result?.id ?? null, value.estimated_minutes,
          value.energy_required, value.kind, remindersEnabled, createdAt(value.created_at),
        ],
      );
      await client.query(
        `INSERT INTO task_events (user_id, task_id, event_type, scheduled_at, metadata)
         VALUES ($1, $2, 'created', $3::timestamptz, $4::jsonb)`,
        [userId, Number(inserted[0]!.id), (remindAt ?? dueAt)?.toISOString() ?? null, JSON.stringify({ source: "archive_import" })],
      );
      known.add(key);
      counter.added += 1;
    }
  }

  await applyEntries(client, { userId, parsed, count, errors, createdAt });

  const sheets: SheetReport[] = [...counters.entries()].map(([id, counter]) => ({
    id, name: sheet(id).name, added: counter.added, existing: counter.existing,
  }));
  return {
    recognized: parsed.recognized,
    sheets,
    added_total: sheets.reduce((sum, item) => sum + item.added, 0),
    existing_total: sheets.reduce((sum, item) => sum + item.existing, 0),
    errors: errors.slice(0, ERROR_LIMIT),
    error_count: errors.length,
    warnings,
    paused_actions: pausedActions,
    read_only_sheets: parsed.readOnlySheets,
    memory_handoff: memoryHandoff(parsed.memory),
  };
}

/**
 * Порядок записи: родитель раньше потомка. Строка, чей родитель есть в
 * файле, ждёт его; цикл или ссылка в никуда записываются без родителя.
 */
function ordered<T extends { ref: string | null; parent: string | null }>(
  items: Array<{ row: number; value: T }>,
  refs: Set<string>,
  done: Map<string, unknown>,
): Array<{ row: number; value: T }> {
  const result: Array<{ row: number; value: T }> = [];
  const placed = new Set<string>();
  let pending = items.slice();
  while (pending.length > 0) {
    const next = pending.filter((item) => {
      const parent = item.value.parent;
      const ready = !parent || parent === item.value.ref || !refs.has(parent) || placed.has(parent) || done.has(parent);
      if (ready) {
        result.push(item);
        if (item.value.ref) placed.add(item.value.ref);
      }
      return !ready;
    });
    if (next.length === pending.length) {
      // Цикл: остаток идёт как есть, родитель найдётся или нет.
      result.push(...next);
      break;
    }
    pending = next;
  }
  return result;
}

function gender(value: string): string {
  const folded = fold(value);
  if (["masculine", "мужской", "м"].includes(folded)) return "masculine";
  if (["feminine", "женский", "ж"].includes(folded)) return "feminine";
  return value;
}

/** Обращение к Еве с памятью из файла — его человек отправит сам. */
function memoryHandoff(memory: ParsedArchive["memory"]): string | null {
  if (memory.length === 0) return null;
  const intro = "Это из моего архива — то, что ты знала обо мне раньше. Посмотри и запомни то, что важно сейчас.";
  let text = [intro, ...memory.map((item) => `${item.label}:\n${item.value}`)].join("\n\n");
  if (text.length > HANDOFF_LIMIT) text = `${text.slice(0, HANDOFF_LIMIT - 1)}…`;
  return text;
}

