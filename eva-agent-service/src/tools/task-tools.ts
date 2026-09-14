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
        "Возвращает задачи текущего пользователя.",
        listSchema(),
        list,
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

  private async list(args: JsonObject, runtime: AgentRuntimeContext): Promise<unknown> {
    const { rows } = await this.db.query(
      `SELECT * FROM tasks
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY COALESCE(next_run_at, remind_at, due_at) NULLS LAST, created_at DESC
        LIMIT $3`,
      [
        runtime.userId,
        optionalString(args, "status", 30),
        Math.min(Math.max(optionalInteger(args, "limit") ?? 30, 1), 100),
      ],
    );
    return { ok: true, tasks: rows };
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
    limit: integer("Количество, максимум 100"),
  });
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
