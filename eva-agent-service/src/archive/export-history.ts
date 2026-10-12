/**
 * Листы архива «только для просмотра»: история работы над целями,
 * фокус, окна инициативы, диалоги, документы, исследования, подписка,
 * платежи и тесты, а также лист «О файле».
 *
 * Обратно они не загружаются: это след событий (разборы, сессии, платежи)
 * или настройки с собственными правилами (окна инициативы), и вставка
 * их из файла создала бы историю, которой не было.
 *
 * Каждый запрос, как и в `export.ts`, называет владельца `user_id = $1`.
 */

import { boolOf, intOf, jsonCell, minorToMajor, textOf } from "./format.js";
import { ABOUT_FIELDS, ARCHIVE_FORMAT, ARCHIVE_VERSION, SHEET_ROW_LIMIT, type SheetId } from "./sheets.js";
import type { DbRow, Queryable, Row } from "./export.js";

export interface HistoryContext {
  db: Queryable;
  userId: number;
  limit: number;
  /** Выборка листа с пределом строк: `$1` — владелец, `$2` — предел. */
  select(id: SheetId, sql: string): Promise<DbRow[]>;
  at(value: unknown): string | null;
  goalRef(id: unknown): string | null;
  resultRef(id: unknown): string | null;
}

const pad = (value: number) => String(value).padStart(2, "0");

export async function historySheets(ctx: HistoryContext): Promise<Array<[SheetId, Row[]]>> {
  const out: Array<[SheetId, Row[]]> = [];
  out.push(["work_blocks", (await ctx.select("work_blocks",
    `SELECT goal_id, goal_result_id, intention, first_physical_step, planned_start_at, planned_minutes,
            if_then_rule, completion_criterion, status, started_at, completed_at, actual_minutes,
            actual_result, artifact, obstacle, helpful_factor, next_step, energy_before, energy_after
       FROM work_blocks WHERE user_id = $1 ORDER BY id DESC LIMIT $2`)).reverse().map((row) => ({
    goal: ctx.goalRef(row.goal_id),
    result: ctx.resultRef(row.goal_result_id),
    intention: textOf(row.intention),
    first_physical_step: textOf(row.first_physical_step),
    planned_start_at: ctx.at(row.planned_start_at),
    planned_minutes: intOf(row.planned_minutes),
    if_then_rule: textOf(row.if_then_rule),
    completion_criterion: textOf(row.completion_criterion),
    status: textOf(row.status),
    started_at: ctx.at(row.started_at),
    completed_at: ctx.at(row.completed_at),
    actual_minutes: intOf(row.actual_minutes),
    actual_result: textOf(row.actual_result),
    artifact: textOf(row.artifact),
    obstacle: textOf(row.obstacle),
    helpful_factor: textOf(row.helpful_factor),
    next_step: textOf(row.next_step),
    energy_before: intOf(row.energy_before),
    energy_after: intOf(row.energy_after),
  }))]);

  out.push(["reviews", (await ctx.select("reviews",
    `SELECT goal_id, review_type, fact, system_signal, changed_element, next_small_step, created_at
       FROM goal_reviews WHERE user_id = $1 ORDER BY id DESC LIMIT $2`)).reverse().map((row) => ({
    goal: ctx.goalRef(row.goal_id),
    review_type: textOf(row.review_type),
    fact: textOf(row.fact),
    system_signal: textOf(row.system_signal),
    changed_element: textOf(row.changed_element),
    next_small_step: textOf(row.next_small_step),
    created_at: ctx.at(row.created_at),
  }))]);

  out.push(["strategies", (await ctx.select("strategies",
    `SELECT goal_id, title, description, status, uses_count, last_used_at
       FROM user_strategies WHERE user_id = $1 ORDER BY id LIMIT $2`)).map((row) => ({
    goal: ctx.goalRef(row.goal_id),
    title: textOf(row.title),
    description: textOf(row.description),
    status: textOf(row.status),
    uses_count: intOf(row.uses_count),
    last_used_at: ctx.at(row.last_used_at),
  }))]);

  out.push(["experiments", (await ctx.select("experiments",
    `SELECT goal_id, hypothesis, action_taken, outcome, lesson, next_experiment, created_at
       FROM learning_attempts WHERE user_id = $1 ORDER BY id DESC LIMIT $2`)).reverse().map((row) => ({
    goal: ctx.goalRef(row.goal_id),
    hypothesis: textOf(row.hypothesis),
    action_taken: textOf(row.action_taken),
    outcome: textOf(row.outcome),
    lesson: textOf(row.lesson),
    next_experiment: textOf(row.next_experiment),
    created_at: ctx.at(row.created_at),
  }))]);

  out.push(["focus_days", (await ctx.select("focus_days",
    `SELECT local_date::text AS local_date, title, expected_result, is_manual
       FROM daily_focus_selections WHERE user_id = $1 ORDER BY local_date DESC LIMIT $2`)).reverse().map((row) => ({
    local_date: textOf(row.local_date),
    title: textOf(row.title),
    expected_result: textOf(row.expected_result),
    is_manual: boolOf(row.is_manual),
  }))]);

  out.push(["focus_sessions", (await ctx.select("focus_sessions",
    `SELECT title, planned_minutes, actual_minutes, actual_result, status, started_at, completed_at
       FROM eva_focus_sessions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`)).reverse().map((row) => ({
    title: textOf(row.title),
    planned_minutes: intOf(row.planned_minutes),
    actual_minutes: intOf(row.actual_minutes),
    actual_result: textOf(row.actual_result),
    status: textOf(row.status),
    started_at: ctx.at(row.started_at),
    completed_at: ctx.at(row.completed_at),
  }))]);

  out.push(["windows", (await ctx.select("windows",
    `SELECT start_minute, end_minute, weekdays, enabled, label
       FROM proactive_windows WHERE user_id = $1 ORDER BY start_minute LIMIT $2`)).map((row) => ({
    start: minutesText(row.start_minute),
    end: minutesText(row.end_minute),
    weekdays: weekdaysText(row.weekdays),
    enabled: boolOf(row.enabled),
    label: textOf(row.label),
  }))]);

  out.push(["conversations", (await ctx.select("conversations",
    `SELECT title, purpose, status, message_count, started_at, last_message_at, archived_at
       FROM agent_conversations WHERE user_id = $1 ORDER BY started_at DESC NULLS LAST, id DESC LIMIT $2`))
    .map((row) => ({
      title: textOf(row.title),
      purpose: textOf(row.purpose),
      status: textOf(row.status),
      message_count: intOf(row.message_count),
      started_at: ctx.at(row.started_at),
      last_message_at: ctx.at(row.last_message_at),
      archived_at: ctx.at(row.archived_at),
    }))]);

  out.push(["documents", (await ctx.select("documents",
    `SELECT name, mime, size_bytes, status, chunk_count, source, created_at
       FROM knowledge_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`)).map((row) => ({
    name: textOf(row.name),
    mime: textOf(row.mime),
    size_kb: row.size_bytes === null || row.size_bytes === undefined ? null : Math.ceil(Number(row.size_bytes) / 1024),
    status: textOf(row.status),
    chunk_count: intOf(row.chunk_count),
    source: textOf(row.source),
    created_at: ctx.at(row.created_at),
  }))]);

  out.push(["research", (await ctx.select("research",
    `SELECT r.query, r.status, r.created_at, r.completed_at, rep.summary
       FROM research_requests r
       LEFT JOIN research_reports rep ON rep.id = r.report_id AND rep.user_id = r.user_id
      WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT $2`)).map((row) => ({
    query: textOf(row.query),
    status: textOf(row.status),
    summary: textOf(row.summary),
    created_at: ctx.at(row.created_at),
    completed_at: ctx.at(row.completed_at),
  }))]);

  out.push(["subscriptions", (await ctx.select("subscriptions",
    `SELECT plan, status, source, started_at, current_period_end, canceled_at
       FROM subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`)).map((row) => ({
    plan: textOf(row.plan),
    status: textOf(row.status),
    source: textOf(row.source),
    started_at: ctx.at(row.started_at),
    current_period_end: ctx.at(row.current_period_end),
    canceled_at: ctx.at(row.canceled_at),
  }))]);

  out.push(["payments", (await ctx.select("payments",
    `SELECT paid_at, created_at, amount_minor, currency, status, description
       FROM payments WHERE user_id = $1 ORDER BY id DESC LIMIT $2`)).map((row) => ({
    paid_at: ctx.at(row.paid_at ?? row.created_at),
    // Звёзды Telegram неделимы, у денег — копейки.
    amount: row.currency === "XTR" ? intOf(row.amount_minor) : minorToMajor(row.amount_minor),
    currency: textOf(row.currency),
    status: textOf(row.status),
    description: textOf(row.description),
  }))]);

  out.push(["tests", await testRows(ctx)]);
  return out;
}

function minutesText(value: unknown): string | null {
  const minutes = intOf(value);
  if (minutes === null) return null;
  return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

const WEEKDAYS = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];

function weekdaysText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const days = value.map(Number).filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  return days.length === 7 ? "каждый день" : days.map((day) => WEEKDAYS[day]).join(", ") || null;
}

/**
 * Психологические тесты. Отдельной таблицы результатов сегодня нет
 * (`get_psychological_test_results` — заглушка): старая `test_results`
 * существует только на установках, где в ней остались строки. Пустой лист
 * без пояснения читался бы как «результаты потеряны», поэтому пояснение
 * пишется прямо в лист.
 */
async function testRows(ctx: HistoryContext): Promise<Row[]> {
  const present = await ctx.db.query<{ present: boolean }>(
    "SELECT to_regclass('public.test_results') IS NOT NULL AS present",
  );
  const rows: Row[] = [];
  if (present.rows[0]?.present) {
    const { rows: tests } = await ctx.db.query<DbRow>(
      `SELECT test_key, test_version, scores, summary, started_at, completed_at
         FROM test_results WHERE user_id = $1 ORDER BY started_at LIMIT $2`,
      [ctx.userId, ctx.limit],
    );
    for (const row of tests) {
      rows.push({
        test_key: textOf(row.test_key),
        test_version: textOf(row.test_version),
        scores: jsonCell(row.scores),
        summary: textOf(row.summary),
        started_at: ctx.at(row.started_at),
        completed_at: ctx.at(row.completed_at),
      });
    }
  }
  if (rows.length === 0) {
    rows.push({
      test_key: "Пояснение",
      summary: "Отдельных результатов тестов Ева пока не хранит. Выводы из разговоров о тебе Ева держит "
        + "в своей памяти как гипотезы. В архив попадает только её краткая часть — лист «Память Евы», "
        + "если он включён; долговременная память Евы в архив не входит.",
    });
  }
  return rows;
}

export function aboutRows(input: {
  exportedAt: string;
  zone: string;
  importable: string[];
  readOnly: string[];
  capped: string[];
  memoryIncluded: boolean;
  truncated: number;
}): Row[] {
  const rows: Row[] = [
    { field: "Что это", value: "Архив твоих данных из Евы." },
    { field: ABOUT_FIELDS.format, value: ARCHIVE_FORMAT },
    { field: ABOUT_FIELDS.version, value: String(ARCHIVE_VERSION) },
    { field: ABOUT_FIELDS.exportedAt, value: input.exportedAt.replace("T", " ") },
    { field: ABOUT_FIELDS.zone, value: input.zone },
    {
      field: "Как загрузить обратно",
      value: "Mini App → Профиль → «Мои данные» → «Загрузить архив». Загрузка только добавляет: "
        + "то, что уже есть у Евы, не меняется и не удаляется, а повторы пропускаются. "
        + "Перед записью Ева показывает, что именно добавится.",
    },
    { field: "Загружаются листы", value: input.importable.join("\n") },
    { field: "Только для просмотра", value: input.readOnly.join("\n") },
    {
      field: "Не входит в архив",
      value: "Переписка с Евой и долговременная память Евы — их Ева хранит у себя. Сами файлы документов — "
        + "в архиве только их список. OSINT-исследования — это сведения о других людях. Связи и служебные "
        + "записи: зависимости и рекомендации целей, связи и голосовые заметки дневника, записи сервиса.",
    },
  ];
  if (input.memoryIncluded) {
    rows.push({
      field: "Память Евы",
      value: "Лист «Память Евы» — рабочие заметки Евы о тебе. Это её предположения, а не диагнозы. "
        + "Из файла в память они не записываются: при загрузке Ева предложит передать их ей в чате.",
    });
  }
  if (input.truncated > 0) {
    rows.push({
      field: "Обрезано",
      value: `Значений длиннее миллиона знаков: ${input.truncated}. В файле — их начало; полностью они остались у Евы.`,
    });
  }
  if (input.capped.length > 0) {
    rows.push({
      field: "Ограничения",
      value: `На листах ${input.capped.map((name) => `«${name}»`).join(", ")} больше ${SHEET_ROW_LIMIT} строк: `
        + "в файле — самые свежие.",
    });
  }
  return rows;
}
