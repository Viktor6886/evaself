import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import type { AgentRuntimeContext, Database } from "./db.js";
import { GoalToolFactory } from "./goals/goal-tools.js";
import { GoalService } from "./goals/goal-service.js";
import type { Logger } from "./logger.js";
import type { GraphRepository } from "./memory/graph-repository.js";
import { ProfileToolFactory } from "./profile/profile-tools.js";
import { UserProfileService } from "./profile/profile-service.js";
import type { TelegramClient } from "./telegram.js";
import { currentScope } from "./tenancy/index.js";
import { CoreToolFactory } from "./tools/core-tools.js";
import { EffectJournal, effectKey } from "./turns/effect-journal.js";
import { currentTurn } from "./turns/turn-context.js";
import { TaskToolFactory } from "./tools/task-tools.js";
import { TodoistToolFactory } from "./tools/todoist-tools.js";
import { McpHttpInvoker, McpServerPolicyRepository, selectVisibleTools, ToolGateway, ToolGatewayStateStore, ToolManifestRegistry, type ToolManifest, type ToolRisk } from "./tools/gateway.js";
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
  readonly manifests: ToolManifestRegistry;
  private readonly gateway: ToolGateway;
  private readonly core: CoreToolFactory;
  private readonly profile: ProfileToolFactory;
  private readonly goals: GoalToolFactory;
  private readonly tasks: TaskToolFactory;
  private readonly todoist: TodoistToolFactory;
  private readonly dynamicTools = new Map<string, AnyAgentTool[]>();
  private readonly vectorGoalsEnabled: boolean;
  private approvalCompletion?: (input: { userId: number; conversationId: string; toolName: string; args: unknown; outcome: "executed" | "failed" }) => Promise<unknown>;
  private verifiedOutcome?: (input: { userId:number; conversationId:string; toolName:string; toolCallId:string; runId?:string; outcome:"executed"|"failed" }) => Promise<unknown>;
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
    /**
     * Журнал побочных эффектов. Необязателен: без него инструменты
     * работают ровно как раньше.
     */
    private readonly effects?: EffectJournal,
    private readonly mcp?: { policies: McpServerPolicyRepository; invoker: Pick<McpHttpInvoker, "invokeServer"> },
  ) {
    this.vectorGoalsEnabled = config.vectorGoalsEnabled !== false;
    this.core = new CoreToolFactory(config, db, telegram);
    this.profile = new ProfileToolFactory(profile ?? new UserProfileService(db));
    this.goals = new GoalToolFactory(goals ?? new GoalService(db));
    this.tasks = new TaskToolFactory(db, graph);
    this.todoist = new TodoistToolFactory(config);
    this.manifests = createCanonicalToolManifestRegistry();
    this.gateway = new ToolGateway(this.manifests, { stateStore: config.toolGatewayEnabled ? new ToolGatewayStateStore(db) : undefined });
  }

  setApprovalCompletionCallback(callback: (input: { userId: number; conversationId: string; toolName: string; args: unknown; outcome: "executed" | "failed" }) => Promise<unknown>): void {
    this.approvalCompletion = callback;
  }

  setVerifiedOutcomeCallback(callback: (input: { userId:number; conversationId:string; toolName:string; toolCallId:string; runId?:string; outcome:"executed"|"failed" }) => Promise<unknown>):void {
    this.verifiedOutcome=callback;
  }

  forConversation(conversationId: string): AnyAgentTool[] {
    const tool = this.builder(conversationId);
    return [
      ...this.core.build(tool),
      ...this.profile.build(tool),
      ...(this.vectorGoalsEnabled ? this.goals.build(tool) : []),
      ...this.tasks.build(tool),
      ...(this.config.toolGatewayEnabled ? [tool("skill_scenario_complete", "Complete skill scenario", "Mark the active server-owned skill scenario complete", { type:"object", additionalProperties:false }, async()=>({ok:true}))] : []),
      // Registering Todoist tools without a token only teaches the model
      // about nine actions that always fail on the first call.
      ...(this.config.todoistApiToken ? this.todoist.build(tool) : []),
      ...(this.dynamicTools.get(conversationId) ?? []),
    ];
  }

  /** Resolve canonical ownership and purpose before a live SDK session opens. */
  async sessionPolicy(conversationId: string): Promise<{
    runtime: AgentRuntimeContext;
    visibleTools: string[];
  }> {
    // A fresh conversation has no task/skill decision yet. Persist the
    // deployment's canonical purpose boundary once, rather than treating NULL
    // as an implicit grant on every session.
    await this.loadMcpTools(conversationId);
    const available = new Set(this.forConversation(conversationId).map((tool) => tool.name));
    let runtime = await this.context(conversationId);
    const allowedTools = [...available].filter((name) => this.manifests.get(name)?.purposes.includes(runtime.purpose));
    if (this.config.toolGatewayEnabled
        && (runtime.currentTaskTools == null || runtime.selectedSkillTools == null)) {
      const { rows } = await this.db.withUserScope(
        { userId: runtime.userId, telegramId: runtime.telegramId, label: "tools.materializeConversationSelectors" },
        async () => await this.db.query<{ current_task_tools: string[]; selected_skill_tools: string[] }>(
          `UPDATE agent_conversations
              SET current_task_tools = COALESCE(current_task_tools, $3::text[]),
                  selected_skill_tools = COALESCE(selected_skill_tools, $3::text[]),
                  updated_at = now()
            WHERE conversation_id = $1 AND user_id = $2
            RETURNING current_task_tools, selected_skill_tools`,
          [conversationId, runtime.userId, allowedTools],
        ),
      );
      const persisted = rows[0];
      if (!persisted || !Array.isArray(persisted.current_task_tools) || !Array.isArray(persisted.selected_skill_tools)) {
        throw new Error("Conversation tool selectors could not be materialized");
      }
      runtime = {
        ...runtime,
        currentTaskTools: persisted.current_task_tools,
        selectedSkillTools: persisted.selected_skill_tools,
      };
      this.runtimeContexts.set(conversationId, { expiresAt: Date.now() + 45_000, value: Promise.resolve(runtime) });
    }
    const fallbackTools = this.config.toolGatewayEnabled ? [] : allowedTools;
    return {
      runtime,
      visibleTools: selectVisibleTools(this.manifests, {
        purpose: runtime.purpose,
        taskTools: runtime.currentTaskTools ?? fallbackTools,
        skillTools: runtime.selectedSkillTools ?? fallbackTools,
        allowedTools,
        trusted: true,
      }).map((manifest) => manifest.name),
    };
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
    ): AnyAgentTool => {
      return ({
      name,
      label,
      description,
      parameters,
      execute: async (toolCallId, rawArgs) => {
        let executionUserId: number | undefined;
        let approvalCompletionAttempted = false;
        try {
          const gatewayResult = await this.gateway.execute(name, async (signal) => {
          signal.throwIfAborted();
          const runtime = await this.context(conversationId);
          executionUserId = runtime.userId;
          const manifest = this.manifests.get(name)!;
          if (this.config.toolGatewayEnabled && manifest.sideEffect
              && (!this.effects?.strict || !currentTurn()?.recorded || !String(toolCallId ?? "").trim())) {
            throw new Error(`Effect journal strict mode requires canonical owner, run and call key for ${name}`);
          }
          if (!manifest.purposes.includes(runtime.purpose)) {
            throw new Error(
              `Инструмент ${name} недоступен в служебном conversation purpose=${runtime.purpose}`,
            );
          }
          // Владельцем хода инструмент считает только каноническую
          // запись conversation. Аргументы модели на выбор пользователя
          // не влияют, а расхождение с уже открытой областью — признак
          // перепутанного conversation, и работа останавливается.
          const ambient = currentScope();
          if (
            ambient?.kind === "user" &&
            ambient.userId !== null &&
            ambient.userId !== runtime.userId
          ) {
            throw new Error(
              `Conversation принадлежит другому пользователю, чем текущий ход`,
            );
          }
          // Побочный эффект выполняется не более одного раза на вызов.
          // Ключ детерминированный, поэтому повтор хода после сбоя
          // возвращает прежний результат, а не делает действие второй раз.
          const turn = currentTurn();
          // Барьер отмены перед побочным эффектом. Отменённый ход не
          // должен делать того, что потом нельзя отменить: генерацию мы
          // остановим, а созданную задачу или отправленное сообщение —
          // уже нет.
          if (turn && await turn.isCancelled()) {
            return result({ ok: false, error: "ход отменён" });
          }
          signal.throwIfAborted();
          const key = turn?.recorded && String(toolCallId ?? "").trim()
            ? effectKey(turn.runId, String(toolCallId), name)
            : null;
          if (key && this.effects) {
            const decision = await this.effects.begin({
              key,
              runId: turn!.runId,
              userId: runtime.userId,
              toolName: name,
              toolCallId: String(toolCallId ?? "no-call-id"),
            });
            if (decision.action === "replay") return result(decision.result);
            if (decision.action === "skip") {
              return result({
                ok: false,
                error: decision.reason === "in_flight"
                  ? "этот вызов уже выполняется"
                  : `предыдущая попытка отказала: ${decision.errorCode ?? "неизвестно"}`,
              });
            }
          }

          let output: unknown;
          try {
            output = await this.db.withUserScope(
              {
                userId: runtime.userId,
                telegramId: runtime.telegramId,
                label: `tool:${name}`,
              },
              async () => { signal.throwIfAborted(); return await execute(asObject(rawArgs), runtime); },
            );
          } catch (error) {
            if (key && this.effects) {
              await this.effects.fail(
                key,
                runtime.userId,
                error instanceof Error ? error.name : "unknown_error",
                // Индивидуальная политика: повторять можно то, что
                // сорвалось по дороге, а не то, что модель попросила
                // неправильно.
                !(error instanceof Error && error.name === "TypeError"),
              );
            }
            throw error;
          }
          if (key && this.effects) await this.effects.succeed(key, runtime.userId, output);
          if (CONTEXT_MUTATING_TOOLS.has(name)) {
            this.invalidate(conversationId);
          }
          return result(output);
          });
          if (executionUserId !== undefined) {
            approvalCompletionAttempted = true;
            await this.approvalCompletion?.({ userId: executionUserId, conversationId, toolName: name, args: rawArgs, outcome: "executed" });
            await this.verifiedOutcome?.({userId:executionUserId,conversationId,toolName:name,toolCallId:String(toolCallId),runId:currentTurn()?.runId,outcome:"executed"});
          }
          return gatewayResult;
        } catch (error) {
          if (executionUserId !== undefined && !approvalCompletionAttempted) {
            approvalCompletionAttempted = true;
            await this.approvalCompletion?.({ userId: executionUserId, conversationId, toolName: name, args: rawArgs, outcome: "failed" });
          }
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
    };
  }

  private async loadMcpTools(conversationId: string): Promise<void> {
    if (!this.config.toolGatewayEnabled || !this.mcp) { this.dynamicTools.delete(conversationId); return; }
    const builder = this.builder(conversationId);
    const tools: AnyAgentTool[] = [];
    for (const { name: serverName, policy } of await this.mcp.policies.listEnabled()) {
      for (const remoteName of policy.allowedTools) {
        const name = `mcp__${serverName}__${remoteName}`;
        if (!this.manifests.get(name)) this.manifests.register({
          name, version: "1.0.0", inputSchema: { type: "object", additionalProperties: true }, outputSchema: { type: "object" },
          owner: `mcp:${serverName}`, purposes: ["chat", "research"], risk: "external_side_effect", approvalRequired: true,
          idempotent: false, timeoutMs: policy.timeoutMs, limits: { maxResultBytes: policy.maxResultBytes }, sideEffect: true,
        });
        tools.push(builder(name, remoteName, `Allowlisted MCP tool ${remoteName} on ${serverName}`, { type: "object", additionalProperties: true },
          async (args) => await this.mcp!.invoker.invokeServer(serverName, remoteName, args)));
      }
    }
    this.dynamicTools.set(conversationId, tools);
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


type ManifestPolicy = Pick<ToolManifest, "purposes" | "risk" | "approvalRequired" | "idempotent" | "sideEffect"> & {
  mandatoryApprovalCategory?: string;
};

const policy = (risk: ToolRisk, purposes: string[] = ["chat"]): ManifestPolicy => ({
  purposes, risk, approvalRequired: risk === "sensitive_write" || risk === "external_side_effect" || risk === "destructive",
  idempotent: risk === "read", sideEffect: risk !== "read",
  ...(risk === "destructive" ? { mandatoryApprovalCategory: "data_deletion" } : {}),
});

/**
 * Canonical inventory is obtained from the same factory registrations that
 * build live SDK tools. Factory-local exact declarations avoid both a second
 * central name list and security policy inferred from naming conventions.
 */
export function createCanonicalToolManifestRegistry(): ToolManifestRegistry {
  const registry = new ToolManifestRegistry();
  const register = (declarations: Record<string, ManifestPolicy>, fallback: ManifestPolicy): ToolBuilder =>
    (name, _label, _description, parameters) => {
      const declaration = declarations[name] ?? fallback;
      const manifest = { name, version: "1.0.0", inputSchema: parameters, outputSchema: { type: "object" },
        owner: "eva-agent-service", timeoutMs: 30_000, limits: { maxResultBytes: 1_048_576 }, ...declaration };
      registry.register(manifest);
      return { name } as AnyAgentTool;
    };
  const noop = {} as never;
  new CoreToolFactory({ searxngUrl: "" } as Config, noop, noop).build(register({
    get_notes: policy("read"), get_budget_records: policy("read"), web_search: policy("read", ["chat", "research"]),
    PERPLEXITY_SEARCH: policy("read", ["chat", "research"]), brave_search: policy("read", ["chat", "research"]),
    LIGHTRAG_QUERY: policy("read", ["chat", "research"]), LIGHTRAG_INSERT: policy("external_side_effect"),
    delete_notes: policy("destructive"), delete_budget_records: policy("destructive"), set_reaction: policy("external_side_effect"),
  }, policy("low_risk_write")));
  new ProfileToolFactory(noop).build(register({}, policy("sensitive_write", ["chat", "profile"])));
  new GoalToolFactory(noop).build(register({ get_goals: policy("read", ["chat", "goal_review"]) }, policy("sensitive_write", ["chat", "goal_review"])));
  new TaskToolFactory(noop).build(register({
    get_tasks: policy("read"), get_tasks_from_nocodb: policy("read"), get_recent_reminders: policy("read"),
    get_task_events: policy("read"), get_task_activity: policy("read"), delete_tasks: policy("destructive"),
    delete_tasks_from_nocodb: policy("destructive"), save_tasks_bulk_to_nocodb: { ...policy("sensitive_write"), mandatoryApprovalCategory: "bulk_task_change" },
  }, policy("low_risk_write")));
  new TodoistToolFactory({ todoistApiUrl: "", todoistApiToken: "catalog", todoistProjectId: "" } as Config).build(register({
    TODOIST_GET_ALL_TASKS: policy("read"), TODOIST_GET_ACTIVE_TASK: policy("read"), TODOIST_GET_TASK: policy("read"),
    TODOIST_DELETE_TASK: policy("destructive"), TODOIST_DELETE_ALL_TASKS: policy("destructive"),
  }, policy("external_side_effect")));
  registry.register({
    name: "skill_scenario_complete", version: "1.0.0",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object" },
    owner: "eva-agent-service", purposes: ["chat"], risk: "low_risk_write",
    approvalRequired: false, idempotent: true, timeoutMs: 30_000,
    limits: { maxResultBytes: 1024 }, sideEffect: true,
  });
  return registry;
}
