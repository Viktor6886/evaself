import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { GoalService, UpsertGoalInput, UpsertGoalResultInput } from "./goal-service.js";
import {
  asObject,
  boolean,
  integer,
  json,
  objectSchema,
  optionalInteger,
  optionalLink,
  optionalString,
  requiredString,
  text,
  type JsonObject,
  type ToolBuilder,
} from "../tools/tool-kit.js";

export class GoalToolFactory {
  constructor(private readonly goals: GoalService) {}

  build(tool: ToolBuilder): AnyAgentTool[] {
    return [
      tool(
        "get_goal_context",
        "Получить контекст целей",
        "Возвращает цели, результаты, действия и обзоры только текущего пользователя.",
        objectSchema({ goal_id: integer("Необязательный ID конкретной цели") }),
        async (args, runtime) => ({
          ok: true,
          ...(await this.goals.getGoalContext(
            runtime.userId,
            optionalInteger(args, "goal_id") ?? undefined,
          )),
        }),
      ),
      tool(
        "upsert_goal",
        "Сохранить паспорт цели",
        "Создаёт черновик или обновляет цель VECTOR. Активация выполняется отдельным confirm_goal.",
        goalSchema(),
        async (args, runtime) => ({
          ok: true,
          goal: await this.goals.upsertGoal(goalInput(args, runtime.userId)),
        }),
      ),
      tool(
        "confirm_goal",
        "Подтвердить цель",
        "Активирует паспорт цели только после явного подтверждения пользователя.",
        objectSchema({ goal_id: integer("ID подтверждаемой цели") }, ["goal_id"]),
        async (args, runtime) => ({
          ok: true,
          goal: await this.goals.confirmGoal(
            runtime.userId,
            optionalInteger(args, "goal_id") ?? 0,
          ),
        }),
      ),
      tool(
        "upsert_goal_result",
        "Сохранить результат карты",
        "Создаёт или обновляет промежуточный результат и его зависимости внутри цели пользователя.",
        resultSchema(),
        async (args, runtime) => ({
          ok: true,
          result: await this.goals.upsertGoalResult(resultInput(args, runtime.userId)),
        }),
      ),
      tool(
        "record_work_block",
        "Записать рабочий блок",
        "Планирует, запускает или завершает действие; при завершении сохраняет факт, артефакт, препятствие, помощь и продолжение.",
        workBlockSchema(),
        async (args, runtime) => ({
          ok: true,
          work_block: await this.goals.recordWorkBlock({
            userId: runtime.userId,
            action: requiredString(args, "action", 20) as
              | "plan"
              | "start"
              | "complete"
              | "cancel",
            goalId: optionalInteger(args, "goal_id") ?? 0,
            // Ноль означает «связи нет»: так модель заполняет пустое поле.
            goalResultId: optionalLink(args, "goal_result_id"),
            workBlockId: optionalLink(args, "work_block_id") ?? undefined,
            intention: optionalString(args, "intention", 2_000) ?? undefined,
            firstPhysicalStep: optionalString(args, "first_physical_step", 2_000),
            plannedStartAt: optionalString(args, "planned_start_at", 100),
            plannedMinutes: optionalInteger(args, "planned_minutes"),
            ifThenRule: optionalString(args, "if_then_rule", 2_000),
            completionCriterion: optionalString(args, "completion_criterion", 2_000),
            energyBefore: optionalInteger(args, "energy_before"),
            energyAfter: optionalInteger(args, "energy_after"),
            actualMinutes: optionalInteger(args, "actual_minutes"),
            actualResult: optionalString(args, "actual_result", 10_000),
            artifact: optionalString(args, "artifact", 10_000),
            obstacle: optionalString(args, "obstacle", 5_000),
            helpfulFactor: optionalString(args, "helpful_factor", 5_000),
            nextStep: optionalString(args, "next_step", 5_000),
            resultCompleted: args.result_completed === true,
            progressPercent: optionalInteger(args, "progress_percent") ?? undefined,
          }),
        }),
      ),
      tool(
        "record_goal_review",
        "Записать обзор цели",
        "Сохраняет факт, сигнал системы, один изменяемый элемент и следующий малый шаг без перестройки истории.",
        objectSchema({
          goal_id: integer("ID цели"),
          work_block_id: integer("Связанный рабочий блок"),
          review_type: {
            type: "string",
            enum: ["feedback", "deviation", "checkpoint", "weekly", "completion"],
          },
          fact: text("Наблюдаемый факт без оценки личности"),
          system_signal: text("Что показывает текущая система"),
          changed_element: text("Один изменяемый элемент"),
          next_small_step: text("Следующий малый шаг"),
          plan_snapshot: { type: "object" },
          fact_snapshot: { type: "object" },
        }, ["goal_id", "fact"]),
        async (args, runtime) => ({
          ok: true,
          review: await this.goals.recordGoalReview({
            userId: runtime.userId,
            goalId: optionalInteger(args, "goal_id") ?? 0,
            workBlockId: optionalInteger(args, "work_block_id"),
            reviewType: optionalString(args, "review_type", 30) ?? undefined,
            fact: requiredString(args, "fact", 10_000),
            systemSignal: optionalString(args, "system_signal", 5_000),
            changedElement: optionalString(args, "changed_element", 5_000),
            nextSmallStep: optionalString(args, "next_small_step", 5_000),
            planSnapshot: args.plan_snapshot,
            factSnapshot: args.fact_snapshot,
          }),
        }),
      ),
    ];
  }
}

function goalSchema(): JsonObject {
  return objectSchema({
    id: integer("ID существующей цели"),
    parent_goal_id: integer("ID родительской цели"),
    life_area: text("Область жизни"),
    horizon: text("Горизонт"),
    title: text("Краткое название"),
    why_it_matters: text("Почему это важно"),
    result_artifact: text("Конкретный результат или артефакт"),
    target_date: text("Дата YYYY-MM-DD"),
    success_criteria: json("Проверяемые критерии успеха"),
    minimum_version: text("Минимально приемлемая версия"),
    target_version: text("Целевая версия"),
    constraints: json("Ограничения"),
    learning_goal: text("Что важно узнать"),
    review_condition: text("Условие пересмотра"),
    stop_condition: text("Условие остановки"),
    priority: integer("Приоритет 1–5"),
    status: { type: "string", enum: ["draft", "paused", "completed", "abandoned"] },
    vector_stage: {
      type: "string",
      enum: ["north", "result", "map", "action", "feedback", "review"],
    },
    next_review_at: text("Дата и время обзора ISO 8601"),
    north: {
      type: "object",
      additionalProperties: false,
      properties: {
        desired_direction: text("Желаемое направление"),
        why_it_matters: text("Почему оно важно"),
        values: json("Ценности"),
        acceptable_cost: text("Приемлемая цена"),
        unacceptable_cost: text("Неприемлемая цена"),
        conflicts: json("Конфликты"),
        reduce_list: json("Что следует уменьшить"),
        user_confirmed: boolean("Направление явно подтверждено"),
      },
    },
  });
}

function resultSchema(): JsonObject {
  return objectSchema({
    id: integer("ID результата"),
    goal_id: integer("ID цели"),
    parent_result_id: integer("ID родительского результата"),
    title: text("Название результата"),
    result_artifact: text("Проверяемый артефакт"),
    success_criteria: json("Критерии успеха"),
    minimum_version: text("Минимальная версия"),
    target_date: text("Дата YYYY-MM-DD"),
    sort_order: integer("Порядок на карте"),
    status: {
      type: "string",
      enum: ["draft", "ready", "in_progress", "completed", "blocked", "skipped"],
    },
    is_checkpoint: boolean("Контрольная точка"),
    is_external: boolean("Внешняя зависимость"),
    external_dependency: text("Описание внешней зависимости"),
    is_critical_path: boolean("Критический путь"),
    fallback_plan: text("Резервный вариант"),
    first_action: text("Первое физическое действие"),
    progress_percent: integer("Прогресс 0–100"),
    depends_on_result_ids: { type: "array", items: { type: "integer" }, maxItems: 30 },
  }, ["goal_id"]);
}

function workBlockSchema(): JsonObject {
  return objectSchema({
    action: { type: "string", enum: ["plan", "start", "complete", "cancel"] },
    goal_id: integer("ID цели"),
    goal_result_id: integer("ID результата"),
    work_block_id: integer("ID рабочего блока"),
    intention: text("Ожидаемый артефакт"),
    first_physical_step: text("Первый физический шаг"),
    planned_start_at: text("Время ISO 8601 с offset"),
    planned_minutes: integer("Длительность"),
    if_then_rule: text("Правило если-то"),
    completion_criterion: text("Критерий завершения"),
    energy_before: integer("Энергия до 1–5"),
    energy_after: integer("Энергия после 1–5"),
    actual_minutes: integer("Фактическое время"),
    actual_result: text("Что удалось сделать в итоге"),
    artifact: text("Получившийся артефакт"),
    obstacle: text("Что мешало"),
    helpful_factor: text("Что помогло"),
    next_step: text("Продолжение"),
    result_completed: boolean("Результат завершён"),
    progress_percent: integer("Прогресс 0–100"),
  }, ["action", "goal_id"]);
}

function goalInput(args: JsonObject, userId: number): UpsertGoalInput {
  const input: UpsertGoalInput = { userId };
  assign(input, args, "id", "id", () => optionalInteger(args, "id") ?? undefined);
  assign(input, args, "parentGoalId", "parent_goal_id", () => optionalInteger(args, "parent_goal_id"));
  assign(input, args, "lifeArea", "life_area", () => optionalString(args, "life_area", 200));
  assign(input, args, "horizon", "horizon", () => optionalString(args, "horizon", 100));
  assign(input, args, "title", "title", () => optionalString(args, "title", 500) ?? undefined);
  assign(input, args, "whyItMatters", "why_it_matters", () => optionalString(args, "why_it_matters", 5_000));
  assign(input, args, "resultArtifact", "result_artifact", () => optionalString(args, "result_artifact", 5_000));
  assign(input, args, "targetDate", "target_date", () => optionalString(args, "target_date", 10));
  assign(input, args, "successCriteria", "success_criteria", () => args.success_criteria);
  assign(input, args, "minimumVersion", "minimum_version", () => optionalString(args, "minimum_version", 5_000));
  assign(input, args, "targetVersion", "target_version", () => optionalString(args, "target_version", 5_000));
  assign(input, args, "constraints", "constraints", () => args.constraints);
  assign(input, args, "learningGoal", "learning_goal", () => optionalString(args, "learning_goal", 5_000));
  assign(input, args, "reviewCondition", "review_condition", () => optionalString(args, "review_condition", 5_000));
  assign(input, args, "stopCondition", "stop_condition", () => optionalString(args, "stop_condition", 5_000));
  assign(input, args, "priority", "priority", () => optionalInteger(args, "priority") ?? undefined);
  assign(input, args, "status", "status", () => optionalString(args, "status", 30) ?? undefined);
  assign(input, args, "vectorStage", "vector_stage", () => optionalString(args, "vector_stage", 30) ?? undefined);
  assign(input, args, "nextReviewAt", "next_review_at", () => optionalString(args, "next_review_at", 100));
  if (args.north != null) {
    const north = asObject(args.north);
    input.north = {};
    assign(input.north, north, "desiredDirection", "desired_direction", () => optionalString(north, "desired_direction", 5_000));
    assign(input.north, north, "whyItMatters", "why_it_matters", () => optionalString(north, "why_it_matters", 5_000));
    assign(input.north, north, "values", "values", () => north.values);
    assign(input.north, north, "acceptableCost", "acceptable_cost", () => optionalString(north, "acceptable_cost", 5_000));
    assign(input.north, north, "unacceptableCost", "unacceptable_cost", () => optionalString(north, "unacceptable_cost", 5_000));
    assign(input.north, north, "conflicts", "conflicts", () => north.conflicts);
    assign(input.north, north, "reduceList", "reduce_list", () => north.reduce_list);
    assign(input.north, north, "userConfirmed", "user_confirmed", () => north.user_confirmed === true);
  }
  return input;
}

function resultInput(args: JsonObject, userId: number): UpsertGoalResultInput {
  const input: UpsertGoalResultInput = {
    userId,
    goalId: optionalInteger(args, "goal_id") ?? 0,
  };
  assign(input, args, "id", "id", () => optionalInteger(args, "id") ?? undefined);
  assign(input, args, "parentResultId", "parent_result_id", () => optionalInteger(args, "parent_result_id"));
  assign(input, args, "title", "title", () => optionalString(args, "title", 500) ?? undefined);
  assign(input, args, "resultArtifact", "result_artifact", () => optionalString(args, "result_artifact", 5_000));
  assign(input, args, "successCriteria", "success_criteria", () => args.success_criteria);
  assign(input, args, "minimumVersion", "minimum_version", () => optionalString(args, "minimum_version", 5_000));
  assign(input, args, "targetDate", "target_date", () => optionalString(args, "target_date", 10));
  assign(input, args, "sortOrder", "sort_order", () => optionalInteger(args, "sort_order") ?? undefined);
  assign(input, args, "status", "status", () => optionalString(args, "status", 30) ?? undefined);
  assign(input, args, "isCheckpoint", "is_checkpoint", () => args.is_checkpoint === true);
  assign(input, args, "isExternal", "is_external", () => args.is_external === true);
  assign(input, args, "externalDependency", "external_dependency", () => optionalString(args, "external_dependency", 2_000));
  assign(input, args, "isCriticalPath", "is_critical_path", () => args.is_critical_path === true);
  assign(input, args, "fallbackPlan", "fallback_plan", () => optionalString(args, "fallback_plan", 5_000));
  assign(input, args, "firstAction", "first_action", () => optionalString(args, "first_action", 2_000));
  assign(input, args, "progressPercent", "progress_percent", () => optionalInteger(args, "progress_percent") ?? undefined);
  if (Array.isArray(args.depends_on_result_ids)) {
    input.dependsOnResultIds = args.depends_on_result_ids
      .map(Number)
      .filter(Number.isSafeInteger);
  }
  return input;
}

function assign(
  target: object,
  source: JsonObject,
  targetKey: string,
  sourceKey: string,
  value: () => unknown,
): void {
  if (Object.hasOwn(source, sourceKey)) {
    (target as JsonObject)[targetKey] = value();
  }
}
