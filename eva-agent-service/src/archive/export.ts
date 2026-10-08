/**
 * Выгрузка данных человека в листы архива.
 *
 * Каждый запрос называет владельца (`user_id = $1`): выгрузка идёт в
 * области пользователя, и граница арендатора проверяет это на каждом
 * запросе. Все запросы — в одной транзакции REPEATABLE READ: задача,
 * созданная посреди выгрузки, либо целиком попадает в файл, либо нет,
 * а не задача без своей цели.
 *
 * Служебного в файле нет: идентификаторы базы, агента и conversation,
 * провайдерские номера платежей, хэши документов и внутренние коды
 * индекса. Связи между листами — ключи самого файла («Ц1», «Р3»).
 */

import { isValidIanaTimezone } from "../time/local-date-time.js";
import { aboutRows, historySheets } from "./export-history.js";
import {
  boolOf as bool, intOf as int, jsonCell, labelCell, listCell, minorToMajor, numberCell, textOf as str, wallClock,
} from "./format.js";
import {
  LABELS, MEMORY_FIELDS, NORTH_FIELDS, PROFILE_FIELDS,
  SHEETS, SHEET_ROW_LIMIT, SPILL_CHUNK, physicalColumns, sheet, type SheetId,
} from "./sheets.js";
import type { CellInput, WorkbookSheet } from "./xlsx-writer.js";

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Что Ева знает о человеке: `null` — раздел в архив не включён,
 * `"unavailable"` — runtime сейчас не ответил, и выгрузка честно это пишет.
 */
export type MemorySnapshot = { human: string | null; current_state: string | null } | "unavailable" | null;

export interface ExportInput {
  db: Queryable;
  userId: number;
  zone: string;
  now: Date;
  memory: MemorySnapshot;
  limit?: number;
}

export interface ExportResult {
  sheets: WorkbookSheet[];
  counts: Partial<Record<SheetId, number>>;
  /** Листы, где строк больше предела: в файле — самые свежие. */
  capped: SheetId[];
  /** Значения, не поместившиеся даже в столбцы-продолжения. */
  truncated: number;
}

export type Row = Record<string, CellInput>;
export type DbRow = Record<string, unknown>;

class Builder {
  truncated = 0;

  sheet(id: SheetId, rows: Row[]): WorkbookSheet {
    const definition = sheet(id);
    const columns = physicalColumns(definition);
    return {
      name: definition.name,
      columns: columns.map(({ column, header }) => ({
        header,
        kind: column.kind,
        ...(column.width ? { width: column.width } : {}),
      })),
      rows: rows.map((row) => columns.map(({ column, part }) => {
        const value = row[column.key];
        if (!column.spill || typeof value !== "string") return part === 0 ? value : null;
        if (part === column.spill && value.length > (part + 1) * SPILL_CHUNK) this.truncated += 1;
        return value.slice(part * SPILL_CHUNK, (part + 1) * SPILL_CHUNK) || null;
      })),
    };
  }
}

/** Ключи целей и результатов внутри файла: по ним листы ссылаются друг на друга. */
interface Keys {
  goals: Map<string, string>;
  goalTitles: Map<string, string>;
  results: Map<string, string>;
}

const goalRef = (keys: Keys, id: unknown): string | null => (id === null || id === undefined ? null : keys.goals.get(String(id)) ?? null);
const resultRef = (keys: Keys, id: unknown): string | null => (id === null || id === undefined ? null : keys.results.get(String(id)) ?? null);

export async function collectArchive(input: ExportInput): Promise<ExportResult> {
  const zone = isValidIanaTimezone(input.zone) ? input.zone : "UTC";
  const limit = input.limit ?? SHEET_ROW_LIMIT;
  const { db, userId } = input;
  const at = (value: unknown) => wallClock(value, zone);
  const counts: Partial<Record<SheetId, number>> = {};
  const capped: SheetId[] = [];
  /** Строк на один больше предела: так видно, что лист обрезан. */
  const select = async (id: SheetId, sql: string, values: unknown[] = []): Promise<DbRow[]> => {
    const { rows } = await db.query<DbRow>(sql, [userId, limit + 1, ...values]);
    if (rows.length > limit) capped.push(id);
    return rows.slice(0, limit);
  };
  const builder = new Builder();
  const sheets = new Map<SheetId, WorkbookSheet>();
  const put = (id: SheetId, rows: Row[]) => {
    counts[id] = rows.length;
    sheets.set(id, builder.sheet(id, rows));
  };

  // ---- профиль ------------------------------------------------------
  const profile = (await db.query<DbRow>(
    `SELECT u.first_name, u.last_name, u.username, u.language_code, u.preferred_language,
            u.timezone, u.city, u.country_code, u.created_at,
            p.response_mode, p.agent_mode, p.use_emoji, p.heartbeat_enabled, p.llm_quality_mode
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  )).rows[0] ?? {};
  const profileValues: Record<string, CellInput> = {
    first_name: str(profile.first_name),
    last_name: str(profile.last_name),
    username: str(profile.username) ? `@${String(profile.username)}` : null,
    language: str(profile.preferred_language) ?? str(profile.language_code),
    timezone: str(profile.timezone),
    city: str(profile.city),
    country_code: str(profile.country_code),
    since: at(profile.created_at)?.slice(0, 10) ?? null,
    response_mode: labelCell(profile.response_mode, LABELS.responseMode),
    agent_mode: labelCell(profile.agent_mode, LABELS.agentMode),
    use_emoji: bool(profile.use_emoji),
    heartbeat_enabled: bool(profile.heartbeat_enabled),
    llm_quality_mode: labelCell(profile.llm_quality_mode, LABELS.qualityMode),
  };
  put("profile", PROFILE_FIELDS
    .filter((field) => profileValues[field.key] !== null && profileValues[field.key] !== undefined)
    .map((field) => ({ field: field.label, value: valueText(profileValues[field.key]) })));

  // ---- анкета -------------------------------------------------------
  const answers = await select("questionnaire",
    `SELECT f.field_key, d.title, d.value_type, f.field_value, f.field_json, f.status, f.updated_at
       FROM onboarding_fields f
       LEFT JOIN profile_field_definitions d ON d.field_key = f.field_key
      WHERE f.user_id = $1
        AND (f.field_value IS NOT NULL OR f.field_json IS NOT NULL OR f.status <> 'missing')
      ORDER BY d.sort_order NULLS LAST, f.field_key
      LIMIT $2`);
  put("questionnaire", answers.map((row) => ({
    field_key: str(row.field_key),
    title: str(row.title),
    value: str(row.field_value) ?? jsonCell(row.field_json),
    status: labelCell(row.status, LABELS.profileStatus),
    updated_at: at(row.updated_at),
  })));

  // ---- направление --------------------------------------------------
  const north = (await db.query<DbRow>(
    `SELECT desired_direction, why_it_matters, values, conflicts, reduce_list,
            acceptable_cost, unacceptable_cost, user_confirmed
       FROM user_north WHERE user_id = $1`,
    [userId],
  )).rows[0];
  put("north", north
    ? NORTH_FIELDS.flatMap((field) => {
      const raw = north[field.key];
      const value = typeof raw === "boolean" ? raw : typeof raw === "string" ? str(raw) : jsonCell(raw);
      return value === null || value === undefined ? [] : [{ field: field.label, value: valueText(value) }];
    })
    : []);

  // ---- цели и результаты --------------------------------------------
  const goals = await select("goals",
    `SELECT id, parent_goal_id, title, life_area, horizon, why_it_matters, result_artifact,
            target_date::text AS target_date, success_criteria, minimum_version, target_version,
            constraints, learning_goal, review_condition, stop_condition, priority, status,
            vector_stage, user_confirmed, created_at, completed_at
       FROM goals WHERE user_id = $1 ORDER BY id LIMIT $2`);
  const keys: Keys = { goals: new Map(), goalTitles: new Map(), results: new Map() };
  goals.forEach((row, index) => {
    keys.goals.set(String(row.id), `Ц${index + 1}`);
    keys.goalTitles.set(String(row.id), String(row.title ?? ""));
  });
  put("goals", goals.map((row) => ({
    ref: goalRef(keys, row.id),
    parent: goalRef(keys, row.parent_goal_id),
    title: str(row.title),
    life_area: str(row.life_area),
    horizon: str(row.horizon),
    why_it_matters: str(row.why_it_matters),
    result_artifact: str(row.result_artifact),
    target_date: str(row.target_date),
    success_criteria: jsonCell(row.success_criteria),
    minimum_version: str(row.minimum_version),
    target_version: str(row.target_version),
    constraints: jsonCell(row.constraints),
    learning_goal: str(row.learning_goal),
    review_condition: str(row.review_condition),
    stop_condition: str(row.stop_condition),
    priority: int(row.priority),
    status: labelCell(row.status, LABELS.goalStatus),
    vector_stage: labelCell(row.vector_stage, LABELS.goalStage),
    user_confirmed: bool(row.user_confirmed),
    created_at: at(row.created_at),
    completed_at: at(row.completed_at),
  })));

  const results = await select("results",
    `SELECT id, goal_id, parent_result_id, title, result_artifact, success_criteria, minimum_version,
            target_date::text AS target_date, sort_order, status, is_checkpoint, is_external,
            external_dependency, is_critical_path, fallback_plan, first_action, progress_percent, completed_at
       FROM goal_results WHERE user_id = $1 ORDER BY id LIMIT $2`);
  results.forEach((row, index) => keys.results.set(String(row.id), `Р${index + 1}`));
  put("results", results.map((row) => ({
    ref: resultRef(keys, row.id),
    goal: goalRef(keys, row.goal_id),
    goal_title: keys.goalTitles.get(String(row.goal_id)) ?? null,
    parent: resultRef(keys, row.parent_result_id),
    title: str(row.title),
    result_artifact: str(row.result_artifact),
    success_criteria: jsonCell(row.success_criteria),
    minimum_version: str(row.minimum_version),
    target_date: str(row.target_date),
    sort_order: int(row.sort_order),
    status: labelCell(row.status, LABELS.resultStatus),
    is_checkpoint: bool(row.is_checkpoint),
    is_external: bool(row.is_external),
    external_dependency: str(row.external_dependency),
    is_critical_path: bool(row.is_critical_path),
    fallback_plan: str(row.fallback_plan),
    first_action: str(row.first_action),
    progress_percent: int(row.progress_percent),
    completed_at: at(row.completed_at),
  })));

  // ---- задачи -------------------------------------------------------
  const tasks = await select("tasks",
    `SELECT title, description, kind, status, priority, due_at, remind_at, cron_expression,
            repeat_enabled, timezone, reminders_enabled, goal_id, goal_result_id,
            estimated_minutes, energy_required, created_at, completed_at
       FROM tasks WHERE user_id = $1 ORDER BY id DESC LIMIT $2`);
  put("tasks", tasks.reverse().map((row) => ({
    title: str(row.title),
    description: str(row.description),
    kind: labelCell(row.kind, LABELS.taskKind),
    status: labelCell(row.status, LABELS.taskStatus),
    priority: int(row.priority),
    due_at: at(row.due_at),
    remind_at: at(row.remind_at),
    cron_expression: str(row.cron_expression),
    repeat_enabled: bool(row.repeat_enabled),
    timezone: str(row.timezone),
    reminders_enabled: bool(row.reminders_enabled),
    goal: goalRef(keys, row.goal_id),
    result: resultRef(keys, row.goal_result_id),
    goal_title: row.goal_id === null ? null : keys.goalTitles.get(String(row.goal_id)) ?? null,
    estimated_minutes: int(row.estimated_minutes),
    energy_required: int(row.energy_required),
    created_at: at(row.created_at),
    completed_at: at(row.completed_at),
  })));

  // ---- дневник ------------------------------------------------------
  const entries = await select("journal",
    `SELECT id, local_date::text AS local_date, title, content, mood, energy, share_state, created_at
       FROM journal_entries WHERE user_id = $1 ORDER BY local_date DESC, id DESC LIMIT $2`);
  const peopleOfEntry = new Map<string, string[]>();
  if (entries.length > 0) {
    const { rows } = await db.query<DbRow>(
      `SELECT ep.entry_id, p.display_name
         FROM journal_entry_people ep
         JOIN journal_people p ON p.id = ep.person_id AND p.user_id = ep.user_id
        WHERE ep.user_id = $1 AND ep.entry_id = ANY($2::bigint[])
        ORDER BY p.display_name`,
      [userId, entries.map((row) => String(row.id))],
    );
    for (const row of rows) {
      const list = peopleOfEntry.get(String(row.entry_id)) ?? [];
      list.push(String(row.display_name));
      peopleOfEntry.set(String(row.entry_id), list);
    }
  }
  put("journal", entries.reverse().map((row) => ({
    local_date: str(row.local_date),
    title: str(row.title),
    content: str(row.content),
    mood: labelCell(row.mood, LABELS.mood),
    energy: int(row.energy),
    people: listCell(peopleOfEntry.get(String(row.id)) ?? []),
    shared: row.share_state === "shared_with_eva",
    created_at: at(row.created_at),
  })));

  const people = await select("people",
    `SELECT display_name, relation FROM journal_people WHERE user_id = $1 ORDER BY display_name LIMIT $2`);
  put("people", people.map((row) => ({ display_name: str(row.display_name), relation: str(row.relation) })));

  // ---- заметки, самочувствие, бюджет, решения -----------------------
  const notes = await select("notes",
    `SELECT title, content, category, tags, pinned, entry_type, created_at
       FROM eva_notes WHERE user_id = $1 ORDER BY id DESC LIMIT $2`);
  put("notes", notes.reverse().map((row) => ({
    title: str(row.title),
    content: str(row.content),
    category: str(row.category),
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).filter((tag) => typeof tag === "string").join(", ") || null : null,
    pinned: bool(row.pinned),
    entry_type: labelCell(row.entry_type, LABELS.noteType),
    created_at: at(row.created_at),
  })));

  const checkins = await select("checkins",
    `SELECT local_date::text AS local_date, mood, energy, tension, note
       FROM user_checkins WHERE user_id = $1 ORDER BY local_date DESC LIMIT $2`);
  put("checkins", checkins.reverse().map((row) => ({
    local_date: str(row.local_date),
    mood: labelCell(row.mood, LABELS.mood),
    energy: int(row.energy),
    tension: int(row.tension),
    note: str(row.note),
  })));

  const budget = await select("budget",
    `SELECT occurred_on::text AS occurred_on, entry_type, amount_minor, currency, category, store,
            description, payment_method, quantity
       FROM budget_entries WHERE user_id = $1 ORDER BY occurred_on DESC, id DESC LIMIT $2`);
  put("budget", budget.reverse().map((row) => ({
    occurred_on: str(row.occurred_on),
    entry_type: labelCell(row.entry_type, LABELS.budgetType),
    amount: minorToMajor(row.amount_minor),
    currency: str(row.currency),
    category: str(row.category),
    store: str(row.store),
    description: str(row.description),
    payment_method: str(row.payment_method),
    quantity: numberCell(row.quantity),
  })));

  const decisions = await select("decisions",
    `SELECT question, options, facts, assumptions, criteria, risks, selected_option, confidence,
            reversible, cheap_test, review_at::text AS review_at, actual_result, status, created_at
       FROM eva_decisions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`);
  put("decisions", decisions.reverse().map((row) => ({
    question: str(row.question),
    options: jsonCell(row.options),
    facts: jsonCell(row.facts),
    assumptions: jsonCell(row.assumptions),
    criteria: jsonCell(row.criteria),
    risks: jsonCell(row.risks),
    selected_option: str(row.selected_option),
    confidence: int(row.confidence),
    reversible: bool(row.reversible),
    cheap_test: str(row.cheap_test),
    review_at: str(row.review_at),
    actual_result: str(row.actual_result),
    status: labelCell(row.status, LABELS.decisionStatus),
    created_at: at(row.created_at),
  })));

  // ---- только для просмотра -----------------------------------------
  for (const [id, rows] of await historySheets({
    db, userId, limit, at,
    select: async (id, sql) => await select(id, sql),
    goalRef: (id) => goalRef(keys, id),
    resultRef: (id) => resultRef(keys, id),
  })) put(id, rows);

  // ---- память Евы ---------------------------------------------------
  if (input.memory !== null) {
    put("memory", input.memory === "unavailable"
      ? [{ field: "Память", value: "Память Евы сейчас недоступна — выгрузи архив ещё раз чуть позже." }]
      : MEMORY_FIELDS.flatMap((field) => {
        const value = (input.memory as Record<string, string | null>)[field.key];
        return value && value.trim() ? [{ field: field.label, value: value.trim() }] : [];
      }));
  }

  // ---- о файле ------------------------------------------------------
  const ordered = SHEETS.filter((definition) => definition.id !== "about" && sheets.has(definition.id));
  put("about", aboutRows({
    exportedAt: wallClock(input.now, zone) ?? "",
    zone,
    importable: ordered.filter((item) => item.importable).map((item) => item.name),
    readOnly: ordered.filter((item) => !item.importable).map((item) => item.name),
    capped: capped.map((id) => sheet(id).name),
    memoryIncluded: input.memory !== null,
  }));
  return {
    sheets: [sheets.get("about")!, ...ordered.map((definition) => sheets.get(definition.id)!)],
    counts,
    capped,
    truncated: builder.truncated,
  };
}

function valueText(value: CellInput): CellInput {
  if (typeof value === "boolean") return value ? "да" : "нет";
  return value;
}
