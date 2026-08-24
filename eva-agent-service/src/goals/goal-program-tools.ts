import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type {
  GoalProgramAction,
  GoalProgramResumePolicy,
  GoalProgramService,
} from "./goal-program-service.js";
import {
  integer,
  objectSchema,
  optionalInteger,
  optionalString,
  requiredString,
  text,
  type JsonObject,
  type ToolBuilder,
} from "../tools/tool-kit.js";

/**
 * Два инструмента продуктового курсора длинных программ.
 *
 * SQL модели не отдаётся, `user_id` берётся из доверенного runtime, а не
 * из аргументов, и ни один из инструментов не решает за Letta, какой
 * навык открыть и уместно ли сейчас продолжать программу. Они отвечают
 * ровно на два вопроса: где мы внутри методики и что этот ход изменил.
 */
export class GoalProgramToolFactory {
  constructor(private readonly programs: GoalProgramService) {}

  build(tool: ToolBuilder): AnyAgentTool[] {
    return [
      tool(
        "get_goal_program_context",
        "Где идёт длинная программа",
        "Возвращает курсор запущенных структурированных программ текущего пользователя: "
        + "методика, фаза, шаг, что уже пройдено и что дальше. Целей, результатов и "
        + "истории разговора здесь нет.",
        objectSchema({
          program_key: text("Необязательный ключ конкретной методики"),
        }),
        async (args, runtime) => ({
          ok: true,
          ...(await this.programs.getContext(
            runtime.userId,
            optionalString(args, "program_key", 100) ?? undefined,
          )),
        }),
      ),
      tool(
        "update_goal_program",
        "Сдвинуть курсор программы",
        "Отмечает, что программа запущена, продвинулась, поставлена на паузу, "
        + "возобновлена, завершена или отменена. Повторный start незакрытой программы "
        + "возвращает сохранённое место, а не начинает методику заново.",
        objectSchema({
          action: {
            type: "string",
            enum: ["start", "advance", "pause", "resume", "complete", "cancel"],
            description: "Что произошло с программой",
          },
          program_key: text("Ключ методики, например planning-30d"),
          program_version: integer("Версия методики, по умолчанию 1"),
          primary_goal_id: integer("ID связанной цели VECTOR, если она есть"),
          phase_key: text("Текущая фаза методики"),
          step_key: text("Текущий шаг"),
          last_completed_step_key: text("Последний пройденный шаг"),
          next_step_key: text("Следующий шаг"),
          next_action_hint: text("Короткая подсказка о следующем шаге, до 300 знаков"),
          resume_policy: {
            type: "string",
            enum: ["contextual", "on_request", "scheduled"],
            description: "Как возвращаться к программе",
          },
          expected_revision: integer(
            "Ревизия, которую вернул get_goal_program_context. Защищает от "
            + "затирания чужого шага",
          ),
        }, ["action", "program_key"]),
        async (args, runtime) => ({
          ok: true,
          ...(await this.programs.update({
            userId: runtime.userId,
            action: requiredString(args, "action", 20) as GoalProgramAction,
            programKey: requiredString(args, "program_key", 100),
            programVersion: optionalInteger(args, "program_version") ?? undefined,
            ...(Object.hasOwn(args, "primary_goal_id")
              ? { primaryGoalId: optionalInteger(args, "primary_goal_id") }
              : {}),
            ...field(args, "phase_key", "phaseKey", 100),
            ...field(args, "step_key", "stepKey", 100),
            ...field(args, "last_completed_step_key", "lastCompletedStepKey", 100),
            ...field(args, "next_step_key", "nextStepKey", 100),
            ...field(args, "next_action_hint", "nextActionHint", 300),
            resumePolicy: (optionalString(args, "resume_policy", 20) ?? undefined) as
              | GoalProgramResumePolicy
              | undefined,
            expectedRevision: optionalInteger(args, "expected_revision") ?? undefined,
          })),
        }),
      ),
    ];
  }
}

/**
 * Не присланное поле сохраняет прежнее значение курсора.
 *
 * Без этого различия любое продвижение стирало бы фазу и подсказку,
 * которых модель в этом вызове просто не назвала, — и следующий ход
 * снова не знал бы, где остановилась работа.
 */
function field(
  args: JsonObject,
  source: string,
  target: string,
  max: number,
): Record<string, string | null> {
  if (!Object.hasOwn(args, source)) return {};
  return { [target]: optionalString(args, source, max) };
}
