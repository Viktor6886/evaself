import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { badRequest, notFound, unauthorized } from "../errors.js";
import {
  type TelegramWebAppUser,
  verifyTelegramWebAppInitData,
} from "./telegram-webapp-auth.js";
import {
  authenticateMiniAppRequest,
  type MiniAppSessionStore,
} from "./webapp-session.js";

interface WebAppRequest extends FastifyRequest {
  telegramWebAppUser?: TelegramWebAppUser;
}

interface OwnedUser {
  id: number;
  telegramId: number;
  timezone: string;
}

interface MainFocus {
  id: string;
  title: string;
  source_type: string;
  source_id: string | null;
  source_label: string;
  expected_result: string | null;
  first_step: string | null;
  reason: string;
  work_block_id: string | null;
  work_block_status: string | null;
  manual: boolean;
}

export function registerWebappCoreRoutes(
  app: FastifyInstance,
  input: {
    config: Config;
    db: Database;
    sessions?: MiniAppSessionStore;
    now?: () => Date;
  },
): void {
  void app.register(async (webApp) => {
    webApp.addHook("onRequest", async (request) => {
      // Сессия или initData — идентификатор из тела запроса не годится
      // ни в одной ветке. Общая реализация с /public/*.
      (request as WebAppRequest).telegramWebAppUser =
        await authenticateMiniAppRequest(
          request.headers as Record<string, unknown>,
          {
            botToken: input.config.telegramBotToken,
            maxAgeSeconds: input.config.telegramWebAppMaxAgeSeconds,
            ...(input.sessions ? { sessions: input.sessions } : {}),
            ...(input.now ? { now: input.now } : {}),
            verify: verifyTelegramWebAppInitData,
          },
        );
    });

    webApp.get("/dashboard", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      return await dashboard(input.db, user);
    });

    webApp.post("/checkins", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const mood = enumValue(body.mood, ["very_low", "low", "neutral", "good", "great"], "Настроение");
      const energy = integer(body.energy, "Энергия", 1, 10);
      const tension = integer(body.tension, "Напряжение", 1, 10);
      const note = optionalText(body.note, 1_000);
      const { rows } = await input.db.query(
        `INSERT INTO user_checkins
           (user_id, local_date, mood, energy, tension, note, source)
         VALUES ($1, (now() AT TIME ZONE $2)::date, $3, $4, $5, $6, 'webapp')
         ON CONFLICT (user_id, local_date) DO UPDATE SET
           mood = EXCLUDED.mood,
           energy = EXCLUDED.energy,
           tension = EXCLUDED.tension,
           note = EXCLUDED.note,
           source = EXCLUDED.source,
           updated_at = now()
         RETURNING id::text, local_date, mood, energy, tension, note, source,
                   created_at, updated_at`,
        [user.id, user.timezone, mood, energy, tension, note],
      );
      return { checkin: rows[0] };
    });

    webApp.get("/checkins", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const days = queryInteger(request, "days", 30, 1, 365);
      const { rows } = await input.db.query(
        `SELECT id::text, local_date, mood, energy, tension, note, source,
                created_at, updated_at
           FROM user_checkins
          WHERE user_id = $1
            AND local_date >= (now() AT TIME ZONE $2)::date - ($3::integer - 1)
          ORDER BY local_date DESC`,
        [user.id, user.timezone, days],
      );
      return { checkins: rows };
    });

    webApp.put("/main-result", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const title = requiredText(body.title, "Главный результат", 500);
      const sourceType = optionalText(body.source_type, 50) ?? "manual";
      const sourceId = optionalText(body.source_id ?? body.id, 200);
      const sourceLabel = optionalText(body.source_label, 300) ?? "Выбрано вручную";
      const expectedResult = optionalText(body.expected_result, 2_000);
      const { rows } = await input.db.query(
        `INSERT INTO daily_focus_selections
           (user_id, local_date, title, source_type, source_id, source_label,
            expected_result, is_manual)
         VALUES ($1, (now() AT TIME ZONE $2)::date, $3, $4, $5, $6, $7, true)
         ON CONFLICT (user_id, local_date) DO UPDATE SET
           title = EXCLUDED.title,
           source_type = EXCLUDED.source_type,
           source_id = EXCLUDED.source_id,
           source_label = EXCLUDED.source_label,
           expected_result = EXCLUDED.expected_result,
           is_manual = true,
           updated_at = now()
         RETURNING id::text, title, source_type, source_id, source_label,
                   expected_result, is_manual`,
        [user.id, user.timezone, title, sourceType, sourceId, sourceLabel, expectedResult],
      );
      return { main_focus: selectionToFocus(rows[0] as Record<string, unknown>) };
    });

    webApp.delete("/main-result", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      await input.db.query(
        `DELETE FROM daily_focus_selections
          WHERE user_id = $1
            AND local_date = (now() AT TIME ZONE $2)::date`,
        [user.id, user.timezone],
      );
      return { ok: true };
    });

    webApp.get("/tasks", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const view = queryString(request, "view") ?? "all";
      const { rows } = await input.db.query(
        `SELECT id::text, title, description, status, priority, due_at, remind_at,
                completed_at, cron_expression, repeat_enabled, timezone,
                goal_id::text, goal_result_id::text, work_block_id::text,
                estimated_minutes, energy_required, created_at, updated_at
           FROM tasks
          WHERE user_id = $1
            AND status <> 'canceled'
            AND ($2::text = 'all'
              OR ($2 = 'open' AND status IN ('open', 'in_progress'))
              OR ($2 = 'done' AND status = 'done')
              OR ($2 = 'reminders' AND remind_at IS NOT NULL))
          ORDER BY
            CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
            COALESCE(next_run_at, remind_at, due_at, created_at), id
          LIMIT 200`,
        [user.id, view],
      );
      return { tasks: rows };
    });

    webApp.post("/tasks", async (request, reply) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const title = requiredText(body.title, "Название задачи", 500);
      const description = optionalText(body.description, 5_000);
      const dueAt = optionalTimestamp(body.due_at, "Срок");
      const remindAt = optionalTimestamp(body.remind_at, "Напоминание");
      const priority = optionalInteger(body.priority, 1, 5) ?? 3;
      const { rows } = await input.db.query(
        `INSERT INTO tasks
           (user_id, title, description, status, priority, due_at, remind_at,
            timezone, next_run_at)
         VALUES ($1, $2, $3, 'open', $4, $5::timestamptz, $6::timestamptz,
                 $7, COALESCE($6::timestamptz, $5::timestamptz))
         RETURNING id::text, title, description, status, priority, due_at,
                   remind_at, completed_at, cron_expression, repeat_enabled,
                   timezone, created_at, updated_at`,
        [user.id, title, description, priority, dueAt, remindAt, user.timezone],
      );
      return reply.status(201).send({ task: rows[0] });
    });

    webApp.patch("/tasks/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "задачи");
      const body = objectBody(request);
      const patch = buildTaskPatch(body);
      if (patch.sets.length === 0) throw badRequest("Нет изменений задачи");
      const { rows } = await input.db.query(
        `UPDATE tasks SET ${patch.sets.join(", ")}, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status <> 'canceled'
          RETURNING id::text, title, description, status, priority, due_at,
                    remind_at, completed_at, cron_expression, repeat_enabled,
                    timezone, created_at, updated_at`,
        [id, user.id, ...patch.values],
      );
      if (!rows[0]) throw notFound("Задача не найдена");
      let task = rows[0];
      if (Object.hasOwn(body, "due_at") || Object.hasOwn(body, "remind_at")) {
        const normalized = await input.db.query(
          `UPDATE tasks SET next_run_at = COALESCE(remind_at, due_at)
            WHERE id = $1 AND user_id = $2
            RETURNING id::text, title, description, status, priority, due_at,
                      remind_at, completed_at, cron_expression, repeat_enabled,
                      timezone, created_at, updated_at`,
          [id, user.id],
        );
        task = normalized.rows[0] ?? task;
      }
      return { task };
    });

    webApp.delete("/tasks/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "задачи");
      const result = await input.db.query(
        `UPDATE tasks SET status = 'canceled', updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status <> 'canceled'`,
        [id, user.id],
      );
      if (!result.rowCount) throw notFound("Задача не найдена");
      return { ok: true };
    });

    webApp.get("/notes", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const limit = queryInteger(request, "limit", 50, 1, 200);
      const query = queryString(request, "query");
      const entryType = queryString(request, "entry_type");
      const { rows } = await input.db.query(
        `SELECT id::text, title, content, category, tags, pinned,
                COALESCE(entry_type, 'note') AS entry_type,
                created_at, updated_at
           FROM eva_notes
          WHERE user_id = $1
            AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%'
                 OR content ILIKE '%' || $2 || '%')
            AND ($3::text IS NULL OR COALESCE(entry_type, 'note') = $3)
          ORDER BY pinned DESC, updated_at DESC
          LIMIT $4`,
        [user.id, query, entryType, limit],
      );
      return { notes: rows };
    });

    webApp.post("/notes", async (request, reply) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const title = requiredText(body.title, "Заголовок", 300);
      const content = requiredText(body.content, "Содержание", 100_000);
      const category = optionalText(body.category, 200);
      const entryType = enumValue(body.entry_type ?? "note", ["note", "journal", "insight", "decision"], "Тип записи");
      const { rows } = await input.db.query(
        `INSERT INTO eva_notes
           (user_id, title, content, category, entry_type, tags, pinned)
         VALUES ($1, $2, $3, $4, $5, '{}'::text[], false)
         RETURNING id::text, title, content, category, tags, pinned,
                   entry_type, created_at, updated_at`,
        [user.id, title, content, category, entryType],
      );
      return reply.status(201).send({ note: rows[0] });
    });

    webApp.patch("/notes/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "заметки");
      const body = objectBody(request);
      const title = Object.hasOwn(body, "title") ? requiredText(body.title, "Заголовок", 300) : null;
      const content = Object.hasOwn(body, "content") ? requiredText(body.content, "Содержание", 100_000) : null;
      const category = Object.hasOwn(body, "category") ? optionalText(body.category, 200) : undefined;
      const { rows } = await input.db.query(
        `UPDATE eva_notes SET
           title = COALESCE($3, title),
           content = COALESCE($4, content),
           category = CASE WHEN $5::boolean THEN $6 ELSE category END,
           updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id::text, title, content, category, tags, pinned,
                   COALESCE(entry_type, 'note') AS entry_type,
                   created_at, updated_at`,
        [id, user.id, title, content, category !== undefined, category ?? null],
      );
      if (!rows[0]) throw notFound("Заметка не найдена");
      return { note: rows[0] };
    });

    webApp.delete("/notes/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "заметки");
      const result = await input.db.query(
        "DELETE FROM eva_notes WHERE id = $1 AND user_id = $2",
        [id, user.id],
      );
      if (!result.rowCount) throw notFound("Заметка не найдена");
      return { ok: true };
    });

    webApp.get("/budget", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const period = queryString(request, "period") ?? "month";
      const limit = queryInteger(request, "limit", 100, 1, 300);
      const condition = period === "year"
        ? "occurred_on >= date_trunc('year', now() AT TIME ZONE $2)::date"
        : period === "all"
          ? "true"
          : "occurred_on >= date_trunc('month', now() AT TIME ZONE $2)::date";
      const { rows } = await input.db.query(
        `SELECT id::text, occurred_on, entry_type, amount_minor, currency,
                category, store, description, payment_method, quantity, created_at
           FROM budget_entries
          WHERE user_id = $1 AND ${condition}
          ORDER BY occurred_on DESC, id DESC
          LIMIT $3`,
        [user.id, user.timezone, limit],
      );
      return { records: rows, summary: budgetSummary(rows as Array<Record<string, unknown>>) };
    });

    webApp.post("/budget", async (request, reply) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const type = enumValue(body.type, ["income", "expense"], "Тип записи");
      const amount = number(body.amount, "Сумма", 0, 1_000_000_000);
      const { rows } = await input.db.query(
        `INSERT INTO budget_entries
           (user_id, occurred_on, entry_type, amount_minor, currency, category,
            store, description, payment_method)
         VALUES ($1, COALESCE($2::date, (now() AT TIME ZONE $3)::date), $4,
                 $5, 'RUB', $6, $7, $8, $9)
         RETURNING id::text, occurred_on, entry_type, amount_minor, currency,
                   category, store, description, payment_method, quantity, created_at`,
        [
          user.id,
          optionalDate(body.date),
          user.timezone,
          type,
          Math.round(amount * 100),
          optionalText(body.category, 200),
          optionalText(body.store, 300),
          optionalText(body.description, 2_000),
          optionalText(body.payment_method, 100),
        ],
      );
      return reply.status(201).send({ record: rows[0] });
    });

    webApp.patch("/budget/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "финансовой записи");
      const body = objectBody(request);
      const amountMinor = Object.hasOwn(body, "amount")
        ? Math.round(number(body.amount, "Сумма", 0, 1_000_000_000) * 100)
        : null;
      const type = Object.hasOwn(body, "type")
        ? enumValue(body.type, ["income", "expense"], "Тип записи")
        : null;
      const category = Object.hasOwn(body, "category") ? optionalText(body.category, 200) : undefined;
      const store = Object.hasOwn(body, "store") ? optionalText(body.store, 300) : undefined;
      const description = Object.hasOwn(body, "description") ? optionalText(body.description, 2_000) : undefined;
      const date = Object.hasOwn(body, "date") ? optionalDate(body.date) : undefined;
      const { rows } = await input.db.query(
        `UPDATE budget_entries SET
           entry_type = COALESCE($3, entry_type),
           amount_minor = COALESCE($4, amount_minor),
           category = CASE WHEN $5::boolean THEN $6 ELSE category END,
           store = CASE WHEN $7::boolean THEN $8 ELSE store END,
           description = CASE WHEN $9::boolean THEN $10 ELSE description END,
           occurred_on = CASE WHEN $11::boolean THEN COALESCE($12::date, occurred_on) ELSE occurred_on END
         WHERE id = $1 AND user_id = $2
         RETURNING id::text, occurred_on, entry_type, amount_minor, currency,
                   category, store, description, payment_method, quantity, created_at`,
        [id, user.id, type, amountMinor, category !== undefined, category ?? null, store !== undefined, store ?? null, description !== undefined, description ?? null, date !== undefined, date ?? null],
      );
      if (!rows[0]) throw notFound("Финансовая запись не найдена");
      return { record: rows[0] };
    });

    webApp.delete("/budget/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "финансовой записи");
      const result = await input.db.query(
        "DELETE FROM budget_entries WHERE id = $1 AND user_id = $2",
        [id, user.id],
      );
      if (!result.rowCount) throw notFound("Финансовая запись не найдена");
      return { ok: true };
    });

    webApp.get("/decisions", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const { rows } = await input.db.query(
        `SELECT id::text, question, options, facts, assumptions, criteria, risks,
                selected_option, confidence, reversible, cheap_test, review_at,
                actual_result, status, created_at, updated_at
           FROM eva_decisions
          WHERE user_id = $1 AND status <> 'archived'
          ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
                   COALESCE(review_at, created_at::date), updated_at DESC
          LIMIT 100`,
        [user.id],
      );
      return { decisions: rows };
    });

    webApp.post("/decisions", async (request, reply) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const { rows } = await input.db.query(
        `INSERT INTO eva_decisions
           (user_id, question, options, facts, assumptions, criteria, risks,
            selected_option, review_at, status)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
                 $7::jsonb, $8, $9::date, 'open')
         RETURNING id::text, question, options, facts, assumptions, criteria,
                   risks, selected_option, confidence, reversible, cheap_test,
                   review_at, actual_result, status, created_at, updated_at`,
        [
          user.id,
          requiredText(body.question, "Вопрос решения", 2_000),
          JSON.stringify(stringArray(body.options, 50, 1_000)),
          JSON.stringify(stringArray(body.facts, 50, 1_000)),
          JSON.stringify(stringArray(body.assumptions, 50, 1_000)),
          JSON.stringify(stringArray(body.criteria, 50, 1_000)),
          JSON.stringify(stringArray(body.risks, 50, 1_000)),
          optionalText(body.selected_option, 1_000),
          optionalDate(body.review_at),
        ],
      );
      return reply.status(201).send({ decision: rows[0] });
    });

    webApp.patch("/decisions/:id", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "решения");
      const body = objectBody(request);
      const { rows } = await input.db.query(
        `UPDATE eva_decisions SET
           question = COALESCE($3, question),
           options = CASE WHEN $4::boolean THEN $5::jsonb ELSE options END,
           facts = CASE WHEN $6::boolean THEN $7::jsonb ELSE facts END,
           assumptions = CASE WHEN $8::boolean THEN $9::jsonb ELSE assumptions END,
           criteria = CASE WHEN $10::boolean THEN $11::jsonb ELSE criteria END,
           risks = CASE WHEN $12::boolean THEN $13::jsonb ELSE risks END,
           selected_option = CASE WHEN $14::boolean THEN $15 ELSE selected_option END,
           review_at = CASE WHEN $16::boolean THEN $17::date ELSE review_at END,
           actual_result = CASE WHEN $18::boolean THEN $19 ELSE actual_result END,
           status = COALESCE($20, status),
           updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status <> 'archived'
         RETURNING id::text, question, options, facts, assumptions, criteria,
                   risks, selected_option, confidence, reversible, cheap_test,
                   review_at, actual_result, status, created_at, updated_at`,
        [
          id,
          user.id,
          Object.hasOwn(body, "question") ? requiredText(body.question, "Вопрос решения", 2_000) : null,
          Object.hasOwn(body, "options"), JSON.stringify(stringArray(body.options, 50, 1_000)),
          Object.hasOwn(body, "facts"), JSON.stringify(stringArray(body.facts, 50, 1_000)),
          Object.hasOwn(body, "assumptions"), JSON.stringify(stringArray(body.assumptions, 50, 1_000)),
          Object.hasOwn(body, "criteria"), JSON.stringify(stringArray(body.criteria, 50, 1_000)),
          Object.hasOwn(body, "risks"), JSON.stringify(stringArray(body.risks, 50, 1_000)),
          Object.hasOwn(body, "selected_option"), optionalText(body.selected_option, 1_000),
          Object.hasOwn(body, "review_at"), optionalDate(body.review_at),
          Object.hasOwn(body, "actual_result"), optionalText(body.actual_result, 5_000),
          Object.hasOwn(body, "status") ? enumValue(body.status, ["open", "review", "completed", "archived"], "Статус решения") : null,
        ],
      );
      if (!rows[0]) throw notFound("Решение не найдено");
      return { decision: rows[0] };
    });

    webApp.post("/focus-sessions", async (request, reply) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const body = objectBody(request);
      const { rows } = await input.db.query(
        `INSERT INTO eva_focus_sessions
           (user_id, title, planned_minutes, source_type, source_id,
            work_block_id, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now())
         RETURNING id::text, title, planned_minutes, source_type, source_id,
                   work_block_id::text, status, started_at`,
        [
          user.id,
          requiredText(body.title, "Результат сессии", 500),
          optionalInteger(body.planned_minutes, 1, 480) ?? 15,
          optionalText(body.source_type, 50),
          optionalText(body.source_id, 200),
          optionalInteger(body.work_block_id, 1, Number.MAX_SAFE_INTEGER),
        ],
      );
      return reply.status(201).send({ focus_session: rows[0] });
    });

    webApp.post("/focus-sessions/:id/complete", async (request) => {
      const user = await ownedUser(input.db, publicUser(request).id);
      const id = positiveId((request.params as { id?: string }).id, "фокус-сессии");
      const body = objectBody(request);
      const { rows } = await input.db.query(
        `UPDATE eva_focus_sessions SET
           status = 'completed',
           actual_minutes = $3,
           actual_result = $4,
           completed_at = now(),
           updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'active'
         RETURNING id::text, title, planned_minutes, actual_minutes,
                   actual_result, status, started_at, completed_at`,
        [
          id,
          user.id,
          optionalInteger(body.actual_minutes, 0, 10_080) ?? 0,
          optionalText(body.actual_result, 5_000),
        ],
      );
      if (!rows[0]) throw notFound("Активная фокус-сессия не найдена");
      return { focus_session: rows[0] };
    });
  }, { prefix: "/public/v2" });
}

async function dashboard(db: Database, user: OwnedUser): Promise<Record<string, unknown>> {
  const [checkin, selection, focusData, taskData, counts, notes, budget, insight, activeGoal] = await Promise.all([
    db.query(
      `SELECT id::text, local_date, mood, energy, tension, note, source,
              created_at, updated_at
         FROM user_checkins
        WHERE user_id = $1
          AND local_date = (now() AT TIME ZONE $2)::date
        LIMIT 1`,
      [user.id, user.timezone],
    ),
    db.query(
      `SELECT id::text, title, source_type, source_id, source_label,
              expected_result, is_manual
         FROM daily_focus_selections
        WHERE user_id = $1
          AND local_date = (now() AT TIME ZONE $2)::date
        LIMIT 1`,
      [user.id, user.timezone],
    ),
    automaticFocusCandidates(db, user),
    db.query(
      `SELECT id::text, title, description, status, priority, due_at, remind_at,
              completed_at, cron_expression, repeat_enabled, timezone,
              goal_id::text, goal_result_id::text, work_block_id::text,
              estimated_minutes, energy_required, created_at, updated_at
         FROM tasks
        WHERE user_id = $1 AND status <> 'canceled'
        ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
                 COALESCE(next_run_at, remind_at, due_at, created_at), id
        LIMIT 100`,
      [user.id],
    ),
    db.query<{
      open_tasks: string;
      today_tasks: string;
      reminders: string;
      notes: string;
      open_decisions: string;
    }>(
      `SELECT
         (SELECT count(*) FROM tasks WHERE user_id = $1 AND status IN ('open','in_progress')) AS open_tasks,
         (SELECT count(*) FROM tasks WHERE user_id = $1 AND status IN ('open','in_progress')
            AND COALESCE(due_at, remind_at) IS NOT NULL
            AND (COALESCE(due_at, remind_at) AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date) AS today_tasks,
         (SELECT count(*) FROM tasks WHERE user_id = $1 AND status IN ('open','in_progress') AND remind_at IS NOT NULL) AS reminders,
         (SELECT count(*) FROM eva_notes WHERE user_id = $1) AS notes,
         (SELECT count(*) FROM eva_decisions WHERE user_id = $1 AND status IN ('open','review')) AS open_decisions`,
      [user.id, user.timezone],
    ),
    db.query(
      `SELECT id::text, title, content, category, tags, pinned,
              COALESCE(entry_type, 'note') AS entry_type, created_at, updated_at
         FROM eva_notes
        WHERE user_id = $1
        ORDER BY pinned DESC, updated_at DESC
        LIMIT 20`,
      [user.id],
    ),
    db.query(
      `SELECT id::text, occurred_on, entry_type, amount_minor, currency,
              category, store, description, created_at
         FROM budget_entries
        WHERE user_id = $1
          AND occurred_on >= date_trunc('month', now() AT TIME ZONE $2)::date
        ORDER BY occurred_on DESC, id DESC
        LIMIT 20`,
      [user.id, user.timezone],
    ),
    buildInsight(db, user),
    db.query(
      `SELECT g.id::text, g.title, g.status,
              nr.title AS next_result, nr.first_action AS next_step,
              COALESCE(round(avg(gr.progress_percent))::integer, 0) AS progress_percent
         FROM goals g
         LEFT JOIN goal_results gr ON gr.goal_id = g.id AND gr.user_id = g.user_id
         LEFT JOIN LATERAL (
           SELECT title, first_action FROM goal_results
            WHERE user_id = g.user_id AND goal_id = g.id
              AND status NOT IN ('completed','skipped')
            ORDER BY is_critical_path DESC, sort_order, id LIMIT 1
         ) nr ON true
        WHERE g.user_id = $1 AND g.status = 'active'
        GROUP BY g.id, nr.title, nr.first_action
        ORDER BY g.priority, g.updated_at DESC
        LIMIT 1`,
      [user.id],
    ),
  ]);

  const candidates = focusData;
  const manual = selection.rows[0]
    ? selectionToFocus(selection.rows[0] as Record<string, unknown>)
    : null;
  const mainFocus = manual ?? candidates[0] ?? fallbackFocus();
  const tasks = taskData.rows as Array<Record<string, unknown>>;
  const nextReminder = tasks
    .filter((task) => task.remind_at && !["done", "completed", "canceled"].includes(String(task.status)))
    .sort((a, b) => new Date(String(a.remind_at)).getTime() - new Date(String(b.remind_at)).getTime())[0] ?? null;
  const countRow = counts.rows[0];
  const budgetRows = budget.rows as Array<Record<string, unknown>>;
  const budgetTotals = budgetSummary(budgetRows);

  return {
    build: "webapp-core-v2",
    local_time: new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: user.timezone,
    }).format(new Date()),
    timezone: user.timezone,
    checkin: checkin.rows[0] ?? null,
    main_focus: mainFocus,
    main_focus_candidates: candidates.slice(0, 6),
    tasks,
    notes: notes.rows,
    next_reminder: nextReminder,
    active_goal: activeGoal.rows[0] ?? null,
    counts: {
      open_tasks: Number(countRow?.open_tasks ?? 0),
      today_tasks: Number(countRow?.today_tasks ?? 0),
      reminders: Number(countRow?.reminders ?? 0),
      notes: Number(countRow?.notes ?? 0),
      open_decisions: Number(countRow?.open_decisions ?? 0),
    },
    budget: { ...budgetTotals, recent: budgetRows.slice(0, 8) },
    insight,
    hub: {
      budget: `Расходы за месяц: ${rubles(budgetTotals.expense_minor)}`,
      reports: "Итоги целей и фокус-сессий доступны",
    },
  };
}

async function automaticFocusCandidates(db: Database, user: OwnedUser): Promise<MainFocus[]> {
  const { rows } = await db.query<{
    source_type: string;
    source_id: string | null;
    title: string;
    source_label: string;
    expected_result: string | null;
    first_step: string | null;
    reason: string;
    work_block_id: string | null;
    work_block_status: string | null;
    rank: number;
  }>(
    `WITH candidates AS (
       SELECT 'work_block'::text AS source_type,
              wb.id::text AS source_id,
              COALESCE(wb.intention, wb.completion_criterion, g.title) AS title,
              'Цель: ' || g.title AS source_label,
              wb.completion_criterion AS expected_result,
              wb.first_physical_step AS first_step,
              CASE wb.status WHEN 'active' THEN 'Продолжение активной работы'
                   ELSE 'Запланированный рабочий блок' END AS reason,
              wb.id::text AS work_block_id,
              wb.status AS work_block_status,
              CASE wb.status WHEN 'active' THEN 0 ELSE 1 END AS rank
         FROM work_blocks wb
         JOIN goals g ON g.id = wb.goal_id AND g.user_id = wb.user_id
        WHERE wb.user_id = $1 AND wb.status IN ('active','planned')
       UNION ALL
       SELECT 'goal_result', r.id::text, COALESCE(r.first_action, r.title),
              'Цель: ' || g.title, COALESCE(r.result_artifact, r.title),
              r.first_action, 'Ближайший незавершённый результат цели',
              NULL, NULL, 10 + g.priority
         FROM goals g
         JOIN LATERAL (
           SELECT id, title, result_artifact, first_action
             FROM goal_results
            WHERE user_id = g.user_id AND goal_id = g.id
              AND status NOT IN ('completed','skipped')
            ORDER BY is_critical_path DESC, sort_order, id LIMIT 1
         ) r ON true
        WHERE g.user_id = $1 AND g.status = 'active'
       UNION ALL
       SELECT 'task', t.id::text, t.title,
              CASE WHEN t.due_at IS NOT NULL THEN 'Задача со сроком' ELSE 'Открытая задача' END,
              t.title, NULL,
              CASE WHEN t.due_at < now() THEN 'Просроченная задача'
                   WHEN (t.due_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date THEN 'Задача на сегодня'
                   ELSE 'Ближайшая открытая задача' END,
              t.work_block_id::text, NULL,
              30 + t.priority
         FROM tasks t
        WHERE t.user_id = $1 AND t.status IN ('open','in_progress')
     )
     SELECT source_type, source_id, title, source_label, expected_result,
            first_step, reason, work_block_id, work_block_status, rank
       FROM candidates
      WHERE title IS NOT NULL AND btrim(title) <> ''
      ORDER BY rank,
               CASE WHEN source_type = 'task' THEN source_id::bigint ELSE 0 END
      LIMIT 10`,
    [user.id, user.timezone],
  );
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = row.title.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      id: `${row.source_type}:${row.source_id ?? row.title}`,
      title: row.title,
      source_type: row.source_type,
      source_id: row.source_id,
      source_label: row.source_label,
      expected_result: row.expected_result,
      first_step: row.first_step,
      reason: row.reason,
      work_block_id: row.work_block_id,
      work_block_status: row.work_block_status,
      manual: false,
    }));
}

async function buildInsight(db: Database, user: OwnedUser): Promise<{ text: string; observations: number }> {
  const { rows } = await db.query<{
    observations: string;
    avg_energy: string | null;
    avg_tension: string | null;
    high_tension_days: string;
  }>(
    `SELECT count(*) AS observations,
            round(avg(energy), 1)::text AS avg_energy,
            round(avg(tension), 1)::text AS avg_tension,
            count(*) FILTER (WHERE tension >= 7) AS high_tension_days
       FROM user_checkins
      WHERE user_id = $1
        AND local_date >= (now() AT TIME ZONE $2)::date - 29`,
    [user.id, user.timezone],
  );
  const row = rows[0];
  const observations = Number(row?.observations ?? 0);
  if (observations < 5) {
    return {
      observations,
      text: `Ещё ${5 - observations} ${russianPlural(5 - observations, "отметка", "отметки", "отметок")} — и здесь появится первое наблюдение о состоянии.`,
    };
  }
  const energy = Number(row?.avg_energy ?? 0);
  const tension = Number(row?.avg_tension ?? 0);
  const high = Number(row?.high_tension_days ?? 0);
  if (high >= 3) {
    return {
      observations,
      text: `За 30 дней напряжение было высоким в ${high} ${russianPlural(high, "день", "дня", "дней")}. Это наблюдение, а не диагноз; полезно проверить связь со сном, нагрузкой и событиями.`,
    };
  }
  if (energy >= tension + 2) {
    return { observations, text: `Средняя энергия (${energy}/10) выше напряжения (${tension}/10). В такие дни можно проверять более содержательный первый шаг, сохраняя разумный объём.` };
  }
  return { observations, text: `Средняя энергия ${energy}/10, напряжение ${tension}/10. Ева будет учитывать это при размере следующего шага; причинные выводы по этим данным не делаются.` };
}

function selectionToFocus(row: Record<string, unknown>): MainFocus {
  return {
    id: `selection:${String(row.id ?? "today")}`,
    title: String(row.title ?? "Главное на сегодня"),
    source_type: String(row.source_type ?? "manual"),
    source_id: row.source_id == null ? null : String(row.source_id),
    source_label: String(row.source_label ?? "Выбрано вручную"),
    expected_result: row.expected_result == null ? null : String(row.expected_result),
    first_step: null,
    reason: "Ручной выбор пользователя",
    work_block_id: null,
    work_block_status: null,
    manual: true,
  };
}

function fallbackFocus(): MainFocus {
  return {
    id: "eva:choose",
    title: "Выбрать главное вместе с Евой",
    source_type: "eva",
    source_id: null,
    source_label: "Пока нет активной цели или задачи",
    expected_result: null,
    first_step: null,
    reason: "Недостаточно структурированного контекста",
    work_block_id: null,
    work_block_status: null,
    manual: false,
  };
}

async function ownedUser(db: Database, telegramId: number): Promise<OwnedUser> {
  const { rows } = await db.query<{ id: string; timezone: string }>(
    "SELECT id::text, timezone FROM users WHERE telegram_id = $1",
    [telegramId],
  );
  if (!rows[0]) throw unauthorized("Сначала откройте основную сессию Mini App");
  return { id: Number(rows[0].id), telegramId, timezone: rows[0].timezone };
}

function publicUser(request: FastifyRequest): TelegramWebAppUser {
  const user = (request as WebAppRequest).telegramWebAppUser;
  if (!user) throw unauthorized("Сессия Telegram Mini App не проверена");
  return user;
}

function buildTaskPatch(body: Record<string, unknown>): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    sets.push(sql.replace("?", `$${values.length + 2}`));
  };
  if (Object.hasOwn(body, "title")) add("title = ?", requiredText(body.title, "Название задачи", 500));
  if (Object.hasOwn(body, "description")) add("description = ?", optionalText(body.description, 5_000));
  if (Object.hasOwn(body, "priority")) add("priority = ?", integer(body.priority, "Приоритет", 1, 5));
  if (Object.hasOwn(body, "due_at")) {
    const index = values.length + 3;
    values.push(optionalTimestamp(body.due_at, "Срок"));
    sets.push(`due_at = $${index}::timestamptz`);
  }
  if (Object.hasOwn(body, "remind_at")) {
    const index = values.length + 3;
    values.push(optionalTimestamp(body.remind_at, "Напоминание"));
    sets.push(`remind_at = $${index}::timestamptz`);
  }
  if (Object.hasOwn(body, "status")) {
    const status = enumValue(body.status, ["open", "in_progress", "done"], "Статус задачи");
    add("status = ?", status);
    if (status === "done") sets.push("completed_at = now()");
    else sets.push("completed_at = NULL");
  }
  return { sets, values };
}

function budgetSummary(rows: Array<Record<string, unknown>>): { income_minor: number; expense_minor: number } {
  return rows.reduce<{ income_minor: number; expense_minor: number }>(
    (sum, row) => {
      const amount = Number(row.amount_minor ?? 0);
      if (row.entry_type === "income") sum.income_minor += amount;
      else sum.expense_minor += amount;
      return sum;
    },
    { income_minor: 0, expense_minor: 0 },
  );
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return {};
  return request.body as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${name} не заполнено`);
  if (value.trim().length > max) throw badRequest(`${name}: максимум ${max} символов`);
  return value.trim();
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest("Ожидалась строка");
  const clean = value.trim();
  if (clean.length > max) throw badRequest(`Максимум ${max} символов`);
  return clean || null;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} должно быть целым числом от ${min} до ${max}`);
  }
  return parsed;
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  return integer(value, "Число", min, max);
}

function number(value: unknown, name: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} должно быть числом от ${min} до ${max}`);
  }
  return parsed;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${name}: недопустимое значение`);
  }
  return value as T;
}

function optionalTimestamp(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw badRequest(`${name}: некорректная дата и время`);
  return new Date(value).toISOString();
}

function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest("Некорректная дата");
  return value;
}

function stringArray(value: unknown, limit: number, itemLimit: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest("Ожидался массив строк");
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => item.slice(0, itemLimit));
}

function queryString(request: FastifyRequest, key: string): string | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function queryInteger(request: FastifyRequest, key: string, fallback: number, min: number, max: number): number {
  const value = queryString(request, key);
  return value === null ? fallback : integer(value, key, min, max);
}

function positiveId(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest(`Некорректный ID ${name}`);
  return parsed;
}

function rubles(minor: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

function russianPlural(numberValue: number, one: string, few: string, many: string): string {
  const n10 = numberValue % 10;
  const n100 = numberValue % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return few;
  return many;
}
