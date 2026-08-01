import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import { toolAllowedForPurpose } from "./conversations/purpose-service.js";
import type { AgentRuntimeContext, Database } from "./db.js";
import { GoalToolFactory } from "./goals/goal-tools.js";
import { GoalService } from "./goals/goal-service.js";
import type { Logger } from "./logger.js";
import type { GraphRepository } from "./memory/graph-repository.js";
import { ProfileToolFactory } from "./profile/profile-tools.js";
import { UserProfileService } from "./profile/profile-service.js";
import type { TelegramClient } from "./telegram.js";
import { CoreToolFactory } from "./tools/core-tools.js";
import { TaskToolFactory } from "./tools/task-tools.js";
import { TodoistToolFactory } from "./tools/todoist-tools.js";
import {
  asObject,
  type JsonObject,
  type ToolBuilder,
} from "./tools/tool-kit.js";

const CONTEXT_MUTATING_TOOLS = new Set([
  "update_response_mode",
  "update_llm_quality_mode",
  "upsert_user_profile_field",
  "confirm_user_profile_field",
  "decline_user_profile_field",
  "mark_profile_field_asked",
  "upsert_goal",
  "confirm_goal",
  "upsert_goal_result",
  "record_work_block",
  "record_goal_review",
  "save_task",
  "save_task_to_nocodb",
  "save_tasks_bulk_to_nocodb",
  "update_task",
  "update_task_in_nocodb",
  "mark_task_completed",
  "snooze_task_reminder",
  "delete_tasks",
  "delete_tasks_from_nocodb",
]);

export class AgentToolFactory {
  private readonly core: CoreToolFactory;
  private readonly profile: ProfileToolFactory;
  private readonly goals: GoalToolFactory;
  private readonly tasks: TaskToolFactory;
  private readonly todoist: TodoistToolFactory;
  private readonly vectorGoalsEnabled: boolean;
  private readonly runtimeContexts = new Map<
    string,
    { expiresAt: number; value: Promise<AgentRuntimeContext> }
  >();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    telegram: TelegramClient,
    private readonly logger: Logger,
    profile?: UserProfileService,
    goals?: GoalService,
    graph?: GraphRepository,
  ) {
    this.vectorGoalsEnabled = config.vectorGoalsEnabled !== false;
    this.core = new CoreToolFactory(config, db, telegram);
    this.profile = new ProfileToolFactory(profile ?? new UserProfileService(db));
    this.goals = new GoalToolFactory(goals ?? new GoalService(db));
    this.tasks = new TaskToolFactory(db, graph);
    this.todoist = new TodoistToolFactory(config);
  }

  forConversation(conversationId: string): AnyAgentTool[] {
    const tool = this.builder(conversationId);
    return [
      ...this.core.build(tool),
      ...this.profile.build(tool),
      ...(this.vectorGoalsEnabled ? this.goals.build(tool) : []),
      ...this.tasks.build(tool),
      // Registering Todoist tools without a token only teaches the model
      // about nine actions that always fail on the first call.
      ...(this.config.todoistApiToken ? this.todoist.build(tool) : []),
    ];
  }

  private builder(conversationId: string): ToolBuilder {
    return (
      name: string,
      label: string,
      description: string,
      parameters: JsonObject,
      execute: (
        args: JsonObject,
        runtime: AgentRuntimeContext,
      ) => Promise<unknown>,
    ): AnyAgentTool => ({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, rawArgs) => {
        try {
          const runtime = await this.context(conversationId);
          if (!toolAllowedForPurpose(runtime.purpose, name)) {
            throw new Error(
              `Инструмент ${name} недоступен в служебном conversation purpose=${runtime.purpose}`,
            );
          }
          const output = await execute(asObject(rawArgs), runtime);
          if (CONTEXT_MUTATING_TOOLS.has(name)) {
            this.invalidate(conversationId);
          }
          return result(output);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("Инструмент Agent SDK завершился ошибкой", {
            tool: name,
            conversationId,
            message,
          });
          return result({ ok: false, error: message });
        }
      },
    });
  }

  private async context(conversationId: string): Promise<AgentRuntimeContext> {
    const cached = this.runtimeContexts.get(conversationId);
    if (cached && cached.expiresAt > Date.now()) return await cached.value;

    const value = this.db.getAgentRuntimeContext(conversationId).then((found) => {
      if (!found) {
        throw new Error("Conversation не связан с пользователем Evaself");
      }
      return found;
    });
    this.runtimeContexts.set(conversationId, {
      expiresAt: Date.now() + 45_000,
      value,
    });
    try {
      return await value;
    } catch (error) {
      this.invalidate(conversationId);
      throw error;
    }
  }

  private invalidate(conversationId: string): void {
    this.runtimeContexts.delete(conversationId);
  }
}

function result(value: unknown) {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text: serialized }],
    details: value,
  };
}
