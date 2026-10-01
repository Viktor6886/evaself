import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import type { PoolClient } from "pg";

import { assertCronExpression, nextCronDate } from "../background.js";
import type { AgentRuntimeContext, Database } from "../db.js";
import { localDateTimeToUtc } from "../time/local-date-time.js";
import { OwnMessagesService } from "../runtime/own-messages.js";
import { TaskEventService } from "../tasks/task-event-service.js";
import { recordToolFallback } from "../turns/tool-fallback.js";
import {
  asObject,
  boolean,
  integer,
  objectSchema,
  optionalInteger,
  optionalLink,
  optionalString,
  requiredString,
  text,
  type JsonObject,
  type ToolBuilder,
} from "./tool-kit.js";

interface PreparedTask {
  title: string;
  description: string | null;
  priority: number;
  dueAt: string | null;
  remindAt: string | null;
  cron: string | null;
  repeat: boolean;
  nextRunAt: string | null;
  goalId: number | null;
  resultId: number | null;
  blockId: number | null;
  estimated: number | null;
  energy: number | null;
  kind: "reminder" | "action";
}

export class TaskToolFactory {
  private readonly events: TaskEventService;
  private readonly ownMessages: OwnMessagesService;
  constructor(
    private readonly db: Database,
  ) {
    this.events = new TaskEventService(db);
    this.ownMessages = new OwnMessagesService(db);
  }

  build(tool: ToolBuilder): AnyAgentTool[] {
    const schema = taskSchema();
    const save = async (args: JsonObject, runtime: AgentRuntimeContext) => {
      try {
        const saved = await this.save(args, runtime);
        recordToolFallback(runtime.userId, "save_task", saved);
        return saved;
      } catch (error) {
        recordToolFallback(runtime.userId, "save_task", { ok: false });
        throw error;
      }
    };
    const saveBulk = async (args: JsonObject, runtime: AgentRuntimeContext) => {
      try {
        const saved = await this.saveBulk(args, runtime);
        recordToolFallback(runtime.userId, "save_tasks_bulk", saved);
        return saved;
      } catch (error) {
        recordToolFallback(runtime.userId, "save_tasks_bulk", { ok: false });
        throw error;
      }
    };
    const list = async (args: JsonObject, runtime: AgentRuntimeContext) =>
      await this.list(args, runtime);
    return [
      tool(
      "save_task",
      "Сохранить задачу",
      "Создаёт напоминание человеку (kind=reminder) или отложенное дело, "
      + "которое Ева выполнит сама и пришлёт результат (kind=action).",
      schema,
      save,
    ),
      tool(
        "save_tasks_bulk",
        "Сохранить несколько задач",
        "Атомарно создаёт до 50 задач: либо сохраняются все задачи, либо ни одна.",
        objectSchema({ tasks: { type: "array", items: schema, minItems: 1, maxItems: 50 } }, ["tasks"]),
        saveBulk,
      ),
      tool(
        "get_tasks",
        "Получить задачи",
        "Возвращает задачи текущего пользователя. По умолчанию — ближайшие по расписанию, "
        + "одной страницей; total — сколько задач всего. Весь список: order=id, затем "
        + "after_id=next_after_id из прошлого ответа, пока next_after_id не станет null.",
        listSchema(),
        list,
      ),
      tool(
        "set_task_reminders",
        "Включить или выключить напоминания задач",
        "Выключает или включает напоминания у задач, не трогая сами задачи: они остаются "
        + "в списке со своими сроками. Выключенная задача не напоминает и по расписанию "
        + "не выполняется; включённая возвращается к расписанию. Срок, прошедший пока "
        + "напоминания были выключены, задним числом не срабатывает: повторяющаяся задача "
        + "продолжит со следующего раза, разовые вернутся в overdue_ids — им нужно новое "
        + "время через snooze_task_reminder. До 100 задач за вызов.",
        objectSchema({
          ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 100 },
          enabled: boolean("true — напоминать, false — не напоминать"),
        }, ["ids", "enabled"]),
        async (args, runtime) => await this.setReminders(args, runtime),
      ),
      tool(
        "get_recent_reminders",
        "Недавние напоминания",
        "Возвращает недавние события напоминаний текущего пользователя.",
        objectSchema({ limit: integer("Количество, максимум 100") }),
        async (args, runtime) => ({
          ok: true,
          events: await this.events.recent(
            runtime.userId,
            Math.min(Math.max(optionalInteger(args, "limit") ?? 20, 1), 100),
          ),
        }),
      ),
      // Проверка отсутствия эквивалента (инвариант 20): `get_recent_reminders`
      // отдаёт события задач и о heartbeat, check-in и сообщении в
      // выбранное человеком окно не знает вовсе — они живут в
      // `proactive_messages`. Инструмент отвечает на другой вопрос:
      // «что я отправила сама», независимо от того, каким механизмом.
      tool(
        "get_my_sent_messages",
        "Мои отправленные сообщения",
        "Возвращает сообщения, которые Ева отправила сама: напоминания, "
        + "результаты выполненных задач и сообщения по своей инициативе. "
        + "Нужен, когда человек ссылается на сообщение Евы, а в ходе виден "
        + "только его укороченный текст.",
        objectSchema({
          limit: integer("Количество, максимум 20"),
          since_hours: integer("За сколько последних часов, максимум 168"),
        }),
        async (args, runtime) => {
          const hours = Math.min(Math.max(optionalInteger(args, "since_hours") ?? 24, 1), 168);
          const messages = await this.ownMessages.since(
            runtime.userId,
            new Date(Date.now() - hours * 3_600_000),
            Math.min(Math.max(optionalInteger(args, "limit") ?? 10, 1), 20),
          );
          return {
            ok: true,
            messages: messages.map((message) => ({
              sent_at: message.sentAt.toISOString(),
              source: message.source,
              text: message.text,
            })),
          };
        },
      ),
      tool(
        "get_task_events",
        "История задачи",
        "Возвращает историю конкретной задачи только текущего пользователя.",
        objectSchema({ task_id: integer("ID задачи"), limit: integer("Количество") }, ["task_id"]),
        async (args, runtime) => ({
          ok: true,
          events: await this.events.forTask(
            runtime.userId,
            requireInteger(args, "task_id"),
            Math.min(Math.max(optionalInteger(args, "limit") ?? 50, 1), 100),
          ),
        }),
      ),
      tool(
        "get_task_activity",
        "Активность задач",
        "Возвращает компактную недавнюю активность задач текущего пользователя.",
        objectSchema({}),
        async (_args, runtime) => ({ ok: true, activity: await this.events.contextLines(runtime.userId, runtime.timezone) }),
      ),
      tool(
        "mark_task_completed",
        "Завершить задачу",
        "Отмечает принадлежащую текущему пользователю задачу выполненной.",
        objectSchema({ task_id: integer("ID задачи") }, ["task_id"]),
        async (args, runtime) => {
          const task = await this.events.complete(runtime.userId, requireInteger(args, "task_id"));
          return task ? { ok: true, task } : { ok: false, error: "Задача не найдена" };
        },
      ),
      tool(
        "snooze_task_reminder",
        "Перенести напоминание",
        "Переносит напоминание текущего пользователя на указанное время.",
        objectSchema({
          task_id: integer("ID задачи"),
          remind_at: text("Дата и время ISO 8601 в местном времени пользователя"),
          remind_in_minutes: integer("Через сколько минут напомнить; время считает сервер"),
        }, ["task_id"]),
        async (args, runtime) => {
          const inMinutes = bounded(
            optionalInteger(args, "remind_in_minutes"), "remind_in_minutes", 1, 60 * 24 * 30,
          );
          const until = inMinutes !== null
            ? new Date(Date.now() + inMinutes * 60_000)
            : new Date(localDateTimeToUtc(requiredString(args, "remind_at", 100), runtime.timezone));
          const task = await this.events.snooze(runtime.userId, requireInteger(args, "task_id"), until);
          return task ? { ok: true, task } : { ok: false, error: "Задача не найдена" };
        },
      ),
      tool(
        "update_task",
        "Изменить задачу",
        "Меняет статус, текст или срок принадлежащей пользователю задачи.",
        updateSchema("title", "description", "due_at"),
        async (args, runtime) => await this.update(args, runtime, false),
      ),
      tool(
        "delete_tasks",
        "Удалить задачи",
        "Удаляет выбранные задачи только после confirm=DELETE.",
        deleteSchema(),
        async (args, runtime) => await this.remove(args, runtime),
      ),
    ];
  }

  private prepareTask(args: JsonObject, runtime: AgentRuntimeContext): PreparedTask {
    const priority = Math.min(Math.max(optionalInteger(args, "priority") ?? 3, 1), 5);
    // Род задачи решает, что произойдёт в назначенное время: напомнить
    // человеку или сделать дело самой. Значение по умолчанию — прежнее
    // поведение: задача, о роде которой не сказано, остаётся напоминанием.
    const kindValue = optionalString(args, "kind", 20) ?? "reminder";
    if (kindValue !== "reminder" && kindValue !== "action") {
      throw new Error("kind должен быть reminder или action");
    }
    const kind: "reminder" | "action" = kindValue;
    const dueInput = optionalString(args, "due_at", 100);
    const remindInput = optionalString(args, "remind_at", 100);
    const cron = optionalString(args, "cron", 100);
    const requestedTimezone = optionalString(args, "timezone", 100);
    if (requestedTimezone && requestedTimezone !== runtime.timezone) {
      throw new Error("Часовой пояс задачи должен совпадать с подтверждённым timezone пользователя");
    }
    const dueAt = dueInput ? localDateTimeToUtc(dueInput, runtime.timezone) : null;
    // «Через N минут» считает сервер. Модель называет интервал, который
    // услышала, и не пересчитывает его в стенные часы: там она ошибается,
    // а ошибка выглядит как «напоминание не установилось».
    const remindIn = bounded(
      optionalInteger(args, "remind_in_minutes"), "remind_in_minutes", 1, 60 * 24 * 30,
    );
    const remindAt = remindIn !== null
      ? new Date(Date.now() + remindIn * 60_000).toISOString()
      : remindInput ? localDateTimeToUtc(remindInput, runtime.timezone) : null;
    const repeat = args.repeat === true;
    if (repeat && !cron) throw new Error("Для повторяющейся задачи требуется cron");
    // Validated before the row is written: an expression that can never fire
    // (or an unknown timezone) is a bad request, not a scheduler problem
    // discovered minutes later in the background loop.
    if (cron) assertCronExpression(cron, runtime.timezone);
    const nextRunAt = remindAt ?? dueAt ??
      (repeat && cron ? nextCronDate(cron, runtime.timezone, new Date()).toISOString() : null);

    return {
      title: requiredString(args, "title", 500),
      description: optionalString(args, "description", 5_000),
      priority,
      dueAt,
      remindAt,
      cron,
      repeat,
      nextRunAt,
      goalId: optionalLink(args, "goal_id"),
      resultId: optionalLink(args, "goal_result_id"),
      blockId: optionalLink(args, "work_block_id"),
      estimated: bounded(optionalInteger(args, "estimated_minutes"), "estimated_minutes", 1, 1440),
      energy: bounded(optionalInteger(args, "energy_required"), "energy_required", 1, 5),
      kind,
    };
  }

  private async insertPreparedTask(
    prepared: PreparedTask,
    runtime: AgentRuntimeContext,
    client: PoolClient,
  ): Promise<Record<string, unknown>> {
    // Связи проверяются в той же транзакции, что и INSERT. Для bulk это
    // означает all-or-nothing даже при ошибке в последней из 50 задач.
    let goalId = prepared.goalId;
    let resultId = prepared.resultId;
    const blockId = prepared.blockId;

    if (goalId !== null) {
      const owned = await client.query(
        "SELECT id FROM goals WHERE id = $1 AND user_id = $2",
        [goalId, runtime.userId],
      );
      if (!owned.rows[0]) {
        throw new Error(
          `Цель ${goalId} не найдена. Если задача ни к какой цели не относится, `
          + "поле goal_id не заполняется вовсе",
        );
      }
    }
    if (resultId !== null) {
      const owned = await client.query<{ goal_id: string }>(
        "SELECT goal_id FROM goal_results WHERE id = $1 AND user_id = $2",
        [resultId, runtime.userId],
      );
      if (!owned.rows[0]) {
        throw new Error(
          `Результат ${resultId} не найден. Если задача ни к какому результату не `
          + "относится, поле goal_result_id не заполняется вовсе",
        );
      }
      const ownedGoalId = Number(owned.rows[0].goal_id);
      if (goalId !== null && goalId !== ownedGoalId) {
        throw new Error("Результат не принадлежит выбранной цели");
      }
      goalId = ownedGoalId;
    }
    if (blockId !== null) {
      const owned = await client.query<{ goal_id: string; goal_result_id: string | null }>(
        "SELECT goal_id, goal_result_id FROM work_blocks WHERE id = $1 AND user_id = $2",
        [blockId, runtime.userId],
      );
      if (!owned.rows[0]) {
        throw new Error(
          `Рабочий блок ${blockId} не найден. Если задача ни к какому блоку не `
          + "относится, поле work_block_id не заполняется вовсе",
        );
      }
      const ownedGoalId = Number(owned.rows[0].goal_id);
      const ownedResultId = Number(owned.rows[0].goal_result_id) || null;
      if (goalId !== null && goalId !== ownedGoalId) {
        throw new Error("Рабочий блок не принадлежит выбранной цели");
      }
      if (resultId !== null && resultId !== ownedResultId) {
        throw new Error("Рабочий блок не принадлежит выбранному результату");
      }
      goalId = ownedGoalId;
      resultId = resultId ?? ownedResultId;
    }

    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO tasks (
         user_id, title, description, priority, due_at, remind_at,
         cron_expression, repeat_enabled, timezone, next_run_at,
         goal_id, goal_result_id, work_block_id, estimated_minutes, energy_required,
         kind
       ) VALUES (
         $1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
         $7, $8, $9, $10::timestamptz, $11, $12, $13, $14, $15,
         $16
       ) RETURNING *`,
      [
        runtime.userId,
        prepared.title,
        prepared.description,
        prepared.priority,
        prepared.dueAt,
        prepared.remindAt,
        prepared.cron,
        prepared.repeat,
        runtime.timezone,
        prepared.nextRunAt,
        goalId,
        resultId,
        blockId,
        prepared.estimated,
        prepared.energy,
        prepared.kind,
      ],
    );
    const task = rows[0];
    if (!task || task.id === undefined || task.id === null) {
      throw new Error("Созданная задача не вернула идентификатор");
    }

    // Событие created — часть той же транзакции. Раньше задача могла
    // сохраниться, а запись события упасть после COMMIT; инструмент тогда
    // сообщал об ошибке и повтор запроса создавал дубликаты.
    await client.query(
      `INSERT INTO task_events (user_id, task_id, event_type, scheduled_at, metadata)
       VALUES ($1, $2, 'created', $3::timestamptz, '{}'::jsonb)`,
      [runtime.userId, task.id, prepared.remindAt ?? prepared.dueAt],
    );
    return task;
  }

  private async save(args: JsonObject, runtime: AgentRuntimeContext): Promise<unknown> {
    const prepared = this.prepareTask(args, runtime);
    const task = await this.db.transaction(async (client) =>
      await this.insertPreparedTask(prepared, runtime, client));
    return { ok: true, task };
  }

  private async saveBulk(args: JsonObject, runtime: AgentRuntimeContext): Promise<unknown> {
    if (!Array.isArray(args.tasks)) throw new Error("tasks должен быть массивом");
    // Сначала полностью валидируем вход. Ошибка в 41-й записи не должна
    // открывать транзакцию после того, как 40 предыдущих уже подготовлены к записи.
    const prepared = args.tasks.slice(0, 50).map((item) =>
      this.prepareTask(asObject(item), runtime));

    const tasks = await this.db.transaction(async (client) => {
      const created: Record<string, unknown>[] = [];
      for (const task of prepared) {
        created.push(await this.insertPreparedTask(task, runtime, client));
      }
      return created;
    });

    // Полные строки PostgreSQL не возвращаются модели: на десятках задач
    // такой tool_result раздувал контекст и провоцировал завершение хода
    // без финального assistant_message.
    return {
      ok: true,
      created: tasks.length,
      task_ids: tasks.map((task) => task.id),
    };
  }

  /**
   * Список задач.
   *
   * Полные строки (`SELECT *`) и потолок в 100 без продолжения не давали
   * пройти большой список: сотня строк со всеми колонками намного длиннее
   * 32 000 знаков, на которых Letta Code обрезает ответ инструмента, и
   * список обрывался на середине; задачи дальше сотой были недоступны.
   *
   * Два порядка. По расписанию — ближайшие задачи, одной страницей: это
   * ответ на «что у меня дальше». По id — весь список страницами с
   * курсором `after_id`. Курсор держится за неизменяемый id: смещение по
   * сроку плыло бы, стоит планировщику сдвинуть `next_run_at` или
   * человеку завести задачу между страницами, — задача повторилась бы или
   * пропала. Страница сама укорачивается до бюджета знаков ответа.
   */
  private async list(args: JsonObject, runtime: AgentRuntimeContext): Promise<unknown> {
    const status = optionalString(args, "status", 30);
    const limit = Math.min(Math.max(optionalInteger(args, "limit") ?? 50, 1), 100);
    const byId = args.order === "id";
    const afterId = byId ? Math.max(optionalInteger(args, "after_id") ?? 0, 0) : 0;
    const withDescription = args.include_description === true;
    const { rows } = await this.db.query<TaskListRow>(
      `SELECT id, left(title, ${TITLE_PREVIEW}) AS title, status, kind, priority, due_at, remind_at, next_run_at,
              cron_expression, repeat_enabled, reminders_enabled, goal_id,
              ${withDescription ? `left(description, ${DESCRIPTION_PREVIEW})` : "NULL::text"} AS description
         FROM tasks
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) AND id > $4
        ORDER BY ${byId ? "id" : "COALESCE(next_run_at, remind_at, due_at) NULLS LAST, created_at DESC, id DESC"}
        LIMIT $3`,
      // Одна строка сверх страницы — признак, что продолжение есть.
      [runtime.userId, status, limit + 1, afterId],
    );
    const counted = await this.db.query<{ total: string }>(
      "SELECT count(*) AS total FROM tasks WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)",
      [runtime.userId, status],
    );
    const total = Number(counted.rows[0]?.total ?? 0);
    const page = {
      ok: true,
      order: byId ? "id" : "schedule",
      total,
      returned: 0,
      next_after_id: null as number | null,
      tasks: [] as Record<string, unknown>[],
    };
    const candidates = rows.slice(0, limit).map(compactTask);
    for (const row of candidates) {
      page.tasks.push(row);
      page.returned = page.tasks.length;
      // Меряется ровно то, что уйдёт модели: `toolResult` сериализует с
      // отступами. Хотя бы одна задача уходит всегда, иначе курсор не
      // сдвинулся бы.
      if (page.tasks.length > 1 && JSON.stringify(page, null, 2).length > TASK_PAGE_CHARS) {
        page.tasks.pop();
        break;
      }
    }
    page.returned = page.tasks.length;
    const more = rows.length > limit || page.tasks.length < candidates.length;
    if (byId) {
      const last = page.tasks.at(-1);
      page.next_after_id = more && last ? Number(last.id) : null;
    }
    return {
      ...page,
      ...(!byId && total > page.returned
        ? { note: "Это ближайшие задачи. Весь список — order=id и after_id=next_after_id, пока он не станет null." }
        : {}),
    };
  }

  /**
   * Напоминания задач — отдельно от самих задач. Раньше погасить
   * напоминание можно было только закрыв или удалив задачу: даже без
   * времени напоминания срок сам приводил к напоминанию.
   *
   * Срок, прошедший пока напоминания были выключены, при включении
   * задним числом не срабатывает: иначе включение сотни задач сразу
   * отправило бы сотню напоминаний, а просроченное действие закрылось бы
   * сообщением «не получилось». Повторяющаяся задача продолжает со
   * следующего раза, у разовой этот срок считается прошедшим, и её id
   * возвращаются в `overdue_ids` — новое время назначает
   * `snooze_task_reminder`.
   *
   * Изменение, сдвиг и события — одна транзакция: история задачи не
   * расходится с её состоянием. Захват планировщика (`locked_at`) не
   * трогается: уже взятую задачу исполнитель перепроверяет сам.
   */
  private async setReminders(args: JsonObject, runtime: AgentRuntimeContext): Promise<unknown> {
    if (typeof args.enabled !== "boolean") throw new Error("enabled должен быть true или false");
    const enabled = args.enabled;
    const ids = Array.isArray(args.ids)
      ? [...new Set(args.ids.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))]
      : [];
    if (ids.length === 0) throw new Error("ids: нужен хотя бы один целый ID задачи");
    if (ids.length > 100) throw new Error("ids: не больше 100 задач за вызов");
    const now = new Date();
    const result = await this.db.transaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        cron_expression: string | null;
        repeat_enabled: boolean;
        timezone: string | null;
        scheduled_at: Date | null;
        last_run_at: Date | null;
      }>(
        `UPDATE tasks SET reminders_enabled = $3
          WHERE user_id = $1 AND id = ANY($2::bigint[]) AND reminders_enabled IS DISTINCT FROM $3
          RETURNING id, cron_expression, repeat_enabled, timezone,
                    COALESCE(next_run_at, remind_at, due_at) AS scheduled_at, last_run_at`,
        [runtime.userId, ids, enabled],
      );
      const overdue: number[] = [];
      for (const row of enabled ? rows : []) {
        const scheduled = row.scheduled_at ? new Date(row.scheduled_at) : null;
        if (!scheduled || scheduled > now) continue;
        if (row.last_run_at && new Date(row.last_run_at) >= scheduled) continue;
        const id = Number(row.id);
        if (row.repeat_enabled && row.cron_expression) {
          const next = nextCronDate(row.cron_expression, row.timezone ?? runtime.timezone, now);
          await client.query(
            "UPDATE tasks SET next_run_at = $3 WHERE id = $1 AND user_id = $2",
            [id, runtime.userId, next.toISOString()],
          );
        } else {
          // Срок прошёл, пока напоминания были выключены: этот раз
          // считается состоявшимся, как после отправленного напоминания.
          await client.query(
            "UPDATE tasks SET last_run_at = $3 WHERE id = $1 AND user_id = $2",
            [id, runtime.userId, scheduled.toISOString()],
          );
          overdue.push(id);
        }
      }
      const changed = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
      if (changed.length > 0) {
        await client.query(
          `INSERT INTO task_events (user_id, task_id, event_type, metadata)
           SELECT $1, changed.id, 'updated',
                  jsonb_build_object('reminders_enabled', $3::boolean, 'overdue', changed.id = ANY($4::bigint[]))
             FROM unnest($2::bigint[]) AS changed(id)`,
          [runtime.userId, changed, enabled, overdue],
        );
      }
      return { changed, overdue };
    });
    // Ответ компактный: числа и id, без строк задач — на сотне задач
    // полные строки снова упёрлись бы в предел ответа инструмента.
    return {
      ok: true,
      enabled,
      changed: result.changed.length,
      task_ids: result.changed,
      ...(result.overdue.length > 0
        ? {
          overdue_ids: result.overdue.sort((a, b) => a - b),
          note: "Срок этих разовых задач прошёл, пока напоминания были выключены: задним числом они не сработают. Новое время — snooze_task_reminder.",
        }
        : {}),
    };
  }

  private async update(
    args: JsonObject,
    runtime: AgentRuntimeContext,
    legacy: boolean,
  ): Promise<unknown> {
    const titleKey = legacy ? "task" : "title";
    const dueKey = legacy ? "due_date" : "due_at";
    const dueInput = optionalString(args, dueKey, 100);
    const task = await this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE tasks SET
           title = COALESCE($3, title),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           status = COALESCE($6, status),
           due_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE due_at END,
           next_run_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE next_run_at END,
           completed_at = CASE WHEN $6 = 'done' THEN now()
                               WHEN $6 IS NOT NULL THEN NULL ELSE completed_at END
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          optionalInteger(args, "id"),
          runtime.userId,
          optionalString(args, titleKey, 500),
          Object.hasOwn(args, "description"),
          optionalString(args, "description", 5_000),
          optionalString(args, "status", 30),
          Object.hasOwn(args, dueKey),
          dueInput ? localDateTimeToUtc(dueInput, runtime.timezone) : null,
        ],
      );
      return rows[0];
    });
    if (task) {
      const status = String((task as Record<string, unknown>).status ?? "");
      await this.events.record({
        userId: runtime.userId,
        taskId: String((task as Record<string, unknown>).id),
        eventType: status === "done" ? "completed"
          : status === "canceled" ? "cancelled" : "updated",
      });
    }
    return task ? { ok: true, task } : { ok: false, error: "Задача не найдена" };
  }

  private async remove(args: JsonObject, runtime: AgentRuntimeContext): Promise<unknown> {
    if (requiredString(args, "confirm", 20) !== "DELETE") {
      throw new Error("Удаление задач требует confirm=DELETE");
    }
    const ids = Array.isArray(args.ids)
      ? args.ids.map(Number).filter(Number.isSafeInteger).slice(0, 100)
      : optionalInteger(args, "id") !== null
        ? [optionalInteger(args, "id")!]
        : [];
    const deleted = await this.db.transaction(async (client) => {
      if (ids.length === 0) return 0;
      const result = await client.query(
        "DELETE FROM tasks WHERE user_id = $1 AND id = ANY($2::bigint[])",
        [runtime.userId, ids],
      );
      return result.rowCount ?? 0;
    });
    return { ok: true, deleted };
  }
}

function taskSchema(): JsonObject {
  return objectSchema({
    title: text("Название"),
    description: text("Описание"),
    due_at: text("Дата и время ISO 8601"),
    remind_at: text("Дата напоминания ISO 8601 в местном времени пользователя"),
    remind_in_minutes: integer(
      "Через сколько минут напомнить. Для «через 3 минуты», «через полчаса»: "
      + "время считает сервер, и высчитывать его самой не нужно",
    ),
    kind: {
      type: "string",
      enum: ["reminder", "action"],
      description:
        "Что произойдёт в назначенное время. reminder — напомнить человеку, "
        + "дело делает он сам. action — сделать дело самой и прислать результат: "
        + "«через десять минут найди новости в Перми», «каждое утро присылай погоду», "
        + "«вечером подбери мне упражнения», «в пятницу собери итоги недели». "
        + "Просьба сделать что-то позже — это action; reminder на неё вернёт "
        + "человеку его же поручение. По умолчанию reminder.",
    },
    cron: text("Cron из пяти полей"),
    repeat: boolean("Повторять"),
    priority: integer("Приоритет 1–5"),
    timezone: text("IANA timezone"),
    goal_id: integer("Связанная цель. Бытовая задача ни к какой цели не привязана — поле пропускается"),
    goal_result_id: integer("Связанный результат; необязательно"),
    work_block_id: integer("Связанный рабочий блок; необязательно"),
    estimated_minutes: integer("Оценка минут"),
    energy_required: integer("Энергия 1–5"),
  }, ["title"]);
}

function listSchema(): JsonObject {
  return objectSchema({
    status: { type: "string", enum: ["open", "in_progress", "done", "canceled"] },
    limit: integer("Задач на странице, максимум 100; по умолчанию 50"),
    order: {
      type: "string",
      enum: ["schedule", "id"],
      description: "schedule — ближайшие по расписанию (по умолчанию); id — весь список страницами",
    },
    after_id: integer("Только для order=id: next_after_id из прошлого ответа"),
    include_description: boolean("Добавить начало описания задачи"),
  });
}

/** Знаков описания в списке: начало, по которому задачу узнают, а не весь текст. */
const DESCRIPTION_PREVIEW = 200;

/**
 * Знаков названия в списке. Инструменты и Mini App пишут до 500, но
 * колонка не ограничена: одно огромное название иначе вынесло бы
 * страницу за предел ответа.
 */
const TITLE_PREVIEW = 500;

/**
 * Бюджет страницы в знаках ответа инструмента. Letta Code обрезает ответ
 * на 32 000 знаках; запас оставлен на её собственную обёртку.
 */
const TASK_PAGE_CHARS = 28_000;

interface TaskListRow {
  id: string | number;
  title: string;
  status: string;
  kind: string;
  priority: number;
  due_at: Date | null;
  remind_at: Date | null;
  next_run_at: Date | null;
  cron_expression: string | null;
  repeat_enabled: boolean;
  reminders_enabled: boolean;
  goal_id: string | number | null;
  description: string | null;
}

/** Только то, что нужно, чтобы узнать задачу и её расписание. Пустые поля не выводятся. */
function compactTask(row: TaskListRow): Record<string, unknown> {
  const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
  const entry: Record<string, unknown> = {
    id: Number(row.id),
    title: row.title,
    status: row.status,
    kind: row.kind,
    priority: row.priority,
    reminders_enabled: row.reminders_enabled,
  };
  const optional: Record<string, unknown> = {
    due_at: iso(row.due_at),
    remind_at: iso(row.remind_at),
    next_run_at: iso(row.next_run_at),
    cron: row.cron_expression,
    repeat: row.repeat_enabled || null,
    goal_id: row.goal_id === null ? null : Number(row.goal_id),
    description: row.description,
  };
  for (const [key, value] of Object.entries(optional)) if (value !== null && value !== undefined && value !== "") entry[key] = value;
  return entry;
}

function updateSchema(title: string, description: string, due: string): JsonObject {
  return objectSchema({
    id: integer("ID задачи"),
    [title]: text("Название"),
    [description]: text("Описание"),
    status: { type: "string", enum: ["open", "in_progress", "done", "canceled"] },
    [due]: text("Срок ISO 8601"),
  }, ["id"]);
}

function deleteSchema(includeSingle = false): JsonObject {
  return objectSchema({
    ids: { type: "array", items: { type: "integer" }, maxItems: 100 },
    ...(includeSingle ? { id: integer("Один ID") } : {}),
    confirm: text("Точное слово DELETE"),
  }, ["confirm"]);
}

function bounded(value: number | null, name: string, min: number, max: number): number | null {
  if (value === null) return null;
  if (value < min || value > max) throw new Error(`${name} должен быть от ${min} до ${max}`);
  return value;
}

function requireInteger(args: JsonObject, name: string): number {
  const value = optionalInteger(args, name);
  if (value === null) throw new Error(`${name} обязателен`);
  return value;
}
