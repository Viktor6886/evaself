import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { Config } from "../config.js";
import type { AgentRuntimeContext } from "../db.js";
import {
  integer,
  objectSchema,
  optionalInteger,
  optionalString,
  requiredString,
  text,
  type JsonObject,
  type ToolBuilder,
} from "./tool-kit.js";

export class TodoistToolFactory {
  constructor(private readonly config: Config) {}

  build(tool: ToolBuilder): AnyAgentTool[] {
    const userLabel = (runtime: AgentRuntimeContext) => `eva-${runtime.telegramId}`;
    const requireOwnedTask = async (
      taskId: string,
      runtime: AgentRuntimeContext,
    ) => {
      const task = (await this.request(
        "GET",
        `/tasks/${encodeURIComponent(taskId)}`,
      )) as { id?: string; labels?: string[]; [key: string]: unknown };
      if (!task.labels?.includes(userLabel(runtime))) {
        throw new Error("Todoist task не принадлежит текущему пользователю");
      }
      return task;
    };
    const list = async (runtime: AgentRuntimeContext) => {
      const query = new URLSearchParams({ limit: "200" });
      if (this.config.todoistProjectId) {
        query.set("project_id", this.config.todoistProjectId);
      }
      const raw = (await this.request("GET", `/tasks?${query}`)) as
        | unknown[]
        | { results?: unknown[] };
      const tasks = Array.isArray(raw) ? raw : raw.results ?? [];
      return tasks.filter((task) => {
        const labels = (task as { labels?: unknown }).labels;
        return Array.isArray(labels) && labels.includes(userLabel(runtime));
      });
    };

    return [
      tool(
        "TODOIST_CREATE_TASK",
        "Создать задачу Todoist",
        "Создаёт задачу в настроенном Todoist и изолирует её меткой пользователя.",
        objectSchema(
          {
            content: text("Название задачи"),
            due_string: text("Срок естественным языком или датой"),
            priority: integer("Приоритет Todoist 1–4"),
            description: text("Описание"),
          },
          ["content"],
        ),
        async (args, runtime) => {
          const payload: JsonObject = {
            content: requiredString(args, "content", 500),
            description: optionalString(args, "description", 5_000) ?? "",
            labels: [userLabel(runtime)],
            priority: Math.min(
              Math.max(optionalInteger(args, "priority") ?? 1, 1),
              4,
            ),
          };
          const due = optionalString(args, "due_string", 300);
          if (due) payload.due_string = due;
          if (this.config.todoistProjectId) {
            payload.project_id = this.config.todoistProjectId;
          }
          return { ok: true, task: await this.request("POST", "/tasks", payload) };
        },
      ),
      tool(
        "TODOIST_GET_ALL_TASKS",
        "Все задачи Todoist",
        "Возвращает задачи Todoist текущего пользователя.",
        objectSchema({}),
        async (_args, runtime) => ({ ok: true, tasks: await list(runtime) }),
      ),
      tool(
        "TODOIST_GET_ACTIVE_TASK",
        "Активные задачи Todoist",
        "Возвращает активные задачи Todoist текущего пользователя.",
        objectSchema({}),
        async (_args, runtime) => ({ ok: true, tasks: await list(runtime) }),
      ),
      tool(
        "TODOIST_GET_TASK",
        "Получить задачу Todoist",
        "Возвращает одну задачу после проверки пользовательской метки.",
        objectSchema({ task_id: text("ID задачи Todoist") }, ["task_id"]),
        async (args, runtime) => ({
          ok: true,
          task: await requireOwnedTask(
            requiredString(args, "task_id", 200),
            runtime,
          ),
        }),
      ),
      tool(
        "TODOIST_UPDATE_TASK",
        "Изменить задачу Todoist",
        "Изменяет задачу Todoist текущего пользователя.",
        objectSchema(
          {
            task_id: text("ID задачи"),
            content: text("Новое название"),
            description: text("Новое описание"),
            due_string: text("Новый срок"),
            priority: integer("Приоритет 1–4"),
          },
          ["task_id"],
        ),
        async (args, runtime) => {
          const id = requiredString(args, "task_id", 200);
          const existing = await requireOwnedTask(id, runtime);
          const payload: JsonObject = {
            labels: Array.from(
              new Set([
                ...((existing.labels as string[] | undefined) ?? []),
                userLabel(runtime),
              ]),
            ),
          };
          for (const field of ["content", "description", "due_string"]) {
            const value = optionalString(
              args,
              field,
              field === "description" ? 5_000 : 500,
            );
            if (value !== null) payload[field] = value;
          }
          const priority = optionalInteger(args, "priority");
          if (priority !== null) {
            payload.priority = Math.min(Math.max(priority, 1), 4);
          }
          return {
            ok: true,
            task: await this.request(
              "POST",
              `/tasks/${encodeURIComponent(id)}`,
              payload,
            ),
          };
        },
      ),
      tool(
        "TODOIST_CLOSE_TASK",
        "Завершить задачу Todoist",
        "Закрывает принадлежащую пользователю задачу Todoist.",
        objectSchema({ task_id: text("ID задачи") }, ["task_id"]),
        async (args, runtime) => {
          const id = requiredString(args, "task_id", 200);
          await requireOwnedTask(id, runtime);
          await this.request("POST", `/tasks/${encodeURIComponent(id)}/close`);
          return { ok: true, task_id: id, closed: true };
        },
      ),
      tool(
        "TODOIST_DELETE_TASK",
        "Удалить задачу Todoist",
        "Удаляет задачу Todoist только после confirm=DELETE.",
        objectSchema(
          {
            task_id: text("ID задачи"),
            confirm: text("Точное слово DELETE"),
          },
          ["task_id", "confirm"],
        ),
        async (args, runtime) => {
          requireDelete(args);
          const id = requiredString(args, "task_id", 200);
          await requireOwnedTask(id, runtime);
          await this.request("DELETE", `/tasks/${encodeURIComponent(id)}`);
          return { ok: true, task_id: id, deleted: true };
        },
      ),
      tool(
        "TODOIST_DELETE_ALL_TASKS",
        "Удалить все задачи Todoist",
        "Удаляет только задачи с меткой текущего пользователя после confirm=DELETE.",
        objectSchema({ confirm: text("Точное слово DELETE") }, ["confirm"]),
        async (args, runtime) => {
          requireDelete(args);
          const tasks = (await list(runtime)) as Array<{ id?: string }>;
          let deleted = 0;
          for (const task of tasks) {
            if (!task.id) continue;
            await this.request("DELETE", `/tasks/${encodeURIComponent(task.id)}`);
            deleted += 1;
          }
          return { ok: true, deleted };
        },
      ),
    ];
  }

  private async request(
    method: string,
    path: string,
    body?: JsonObject,
  ): Promise<unknown> {
    if (!this.config.todoistApiToken) {
      throw new Error("TODOIST_API_TOKEN не настроен администратором");
    }
    const response = await fetch(
      `${this.config.todoistApiUrl.replace(/\/+$/, "")}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.todoistApiToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(
        `Todoist вернул HTTP ${response.status}: ${raw.slice(0, 500)}`,
      );
    }
    if (response.status === 204) return null;
    const raw = await response.text();
    return raw ? (JSON.parse(raw) as unknown) : null;
  }
}

function requireDelete(args: JsonObject): void {
  if (args.confirm !== "DELETE") {
    throw new Error("Удаление требует confirm=DELETE");
  }
}
