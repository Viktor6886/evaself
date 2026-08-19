import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import { purposePolicy, type ConversationPurpose } from "./conversations/purpose-service.js";
import type { AgentRuntimeContext, Database } from "./db.js";
import { GoalToolFactory } from "./goals/goal-tools.js";
import { GoalService } from "./goals/goal-service.js";
import type { Logger } from "./logger.js";
import { ProfileToolFactory } from "./profile/profile-tools.js";
import { UserProfileService } from "./profile/profile-service.js";
import type { TelegramClient } from "./telegram.js";
import { currentScope } from "./tenancy/index.js";
import { CoreToolFactory, type RuntimeObserver } from "./tools/core-tools.js";
import { EffectJournal, effectKey } from "./turns/effect-journal.js";
import { turnOf } from "./turns/turn-context.js";
import { TaskToolFactory } from "./tools/task-tools.js";
import type { McpHttpInvoker, McpServerPolicyRepository } from "./tools/mcp.js";
import type { MandatoryApprovalCategory, ToolRisk } from "./tools/approvals.js";
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
  "save_tasks_bulk",
  "update_task",
  "mark_task_completed",
  "snooze_task_reminder",
  "delete_tasks",
]);

export class AgentToolFactory {
  private readonly core: CoreToolFactory;
  private readonly profile: ProfileToolFactory;
  private readonly goals: GoalToolFactory;
  private readonly tasks: TaskToolFactory;
  private readonly dynamicTools = new Map<string, AnyAgentTool[]>();
  private readonly vectorGoalsEnabled: boolean;
  private approvalCompletion?: (input: { userId: number; conversationId: string; toolName: string; args: unknown; outcome: "executed" | "failed" }) => Promise<unknown>;
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
    /**
     * Журнал побочных эффектов. Необязателен: без него инструменты
     * работают ровно как раньше.
     */
    private readonly effects?: EffectJournal,
    private readonly mcp?: { policies: McpServerPolicyRepository; invoker: Pick<McpHttpInvoker, "invokeServer"> },
    /** Наблюдатель рантайма для самопроверки. Без него инструмент честно откажет. */
    observer?: RuntimeObserver,
  ) {
    this.vectorGoalsEnabled = config.vectorGoalsEnabled !== false;
    this.core = new CoreToolFactory(config, db, telegram, undefined, observer);
    this.profile = new ProfileToolFactory(profile ?? new UserProfileService(db));
    this.goals = new GoalToolFactory(goals ?? new GoalService(db));
    this.tasks = new TaskToolFactory(db);
  }

  setApprovalCompletionCallback(callback: (input: { userId: number; conversationId: string; toolName: string; args: unknown; outcome: "executed" | "failed" }) => Promise<unknown>): void {
    this.approvalCompletion = callback;
  }

  forConversation(conversationId: string): AnyAgentTool[] {
    const tool = this.builder(conversationId);
    return [
      ...this.core.build(tool),
      ...this.profile.build(tool),
      ...(this.vectorGoalsEnabled ? this.goals.build(tool) : []),
      ...this.tasks.build(tool),
      ...(this.dynamicTools.get(conversationId) ?? []),
    ];
  }

  /**
   * Подготовка сессии SDK: какие инструменты у неё будут и кому она
   * принадлежит.
   *
   * Отбор инструментов здесь не делается — их набор решает Letta. Отсюда
   * приходит только каноническая принадлежность conversation, без которой
   * подтверждение действия не знает, у кого спрашивать.
   */
  async sessionRuntime(conversationId: string): Promise<AgentRuntimeContext> {
    await this.loadMcpTools(conversationId);
    return await this.context(conversationId);
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
        toolCallId: string,
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
        // Вызов вынесен в отдельную функцию, чтобы ранний выход —
        // отменённый ход, повтор из журнала — проходил через тот же учёт
        // исхода, что и обычное выполнение.
        const call = async (): Promise<ReturnType<typeof result>> => {
          const runtime = await this.context(conversationId);
          executionUserId = runtime.userId;
          // Служебная conversation — не разговор с человеком. Её
          // назначение перечисляет, что в ней вообще позволено; список
          // объявлен один раз в purpose-service и записан вместе с самой
          // conversation, поэтому проверка идёт по нему, а не по имени.
          const allowed = purposePolicy(runtime.purpose as ConversationPurpose).allowedTools;
          if (allowed !== null && !allowed.includes(name)) {
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
          // Ход берётся и по контексту, и по conversation: инструменты
          // регистрируются при открытии сессии, и до их вызова из
          // обработчика сокета SDK AsyncLocalStorage не дотягивается.
          // Без этого журнал побочных эффектов оставался бы выключенным:
          // без хода нет ни ключа, ни барьера отмены.
          const turn = turnOf(conversationId);
          // Барьер отмены перед побочным эффектом. Отменённый ход не
          // должен делать того, что потом нельзя отменить: генерацию мы
          // остановим, а созданную задачу или отправленное сообщение —
          // уже нет.
          if (turn && await turn.isCancelled()) {
            return result({ ok: false, error: "ход отменён" });
          }
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
              async () => await execute(
                asObject(rawArgs), runtime, String(toolCallId ?? ""),
              ),
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
        };
        try {
          const called = await call();
          if (executionUserId !== undefined) {
            approvalCompletionAttempted = true;
            await this.recordOutcome({ userId: executionUserId, conversationId, toolName: name, args: rawArgs, outcome: "executed" });
          }
          return called;
        } catch (error) {
          if (executionUserId !== undefined && !approvalCompletionAttempted) {
            approvalCompletionAttempted = true;
            await this.recordOutcome({ userId: executionUserId, conversationId, toolName: name, args: rawArgs, outcome: "failed" });
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

  /**
   * Учёт исхода вызова: закрытие выданного подтверждения.
   *
   * Учёт идёт после того, как побочный эффект уже случился, поэтому его
   * отказ не становится отказом инструмента: модель получила бы ошибку на
   * выполненном действии и позвала бы инструмент второй раз. По той же
   * причине отказ учёта не подменяет собой исходную ошибку инструмента —
   * иначе настоящая причина отказа не доходит ни до модели, ни в журнал.
   */
  private async recordOutcome(input: {
    userId: number;
    conversationId: string;
    toolName: string;
    args: unknown;
    outcome: "executed" | "failed";
  }): Promise<void> {
    const record = async (stage: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        this.logger.warn("Учёт исхода инструмента не выполнен", {
          tool: input.toolName,
          conversationId: input.conversationId,
          stage,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    await record("approval", async () => await this.approvalCompletion?.({
      userId: input.userId, conversationId: input.conversationId,
      toolName: input.toolName, args: input.args, outcome: input.outcome,
    }));
  }

  private async loadMcpTools(conversationId: string): Promise<void> {
    if (!this.mcp) { this.dynamicTools.delete(conversationId); return; }
    const builder = this.builder(conversationId);
    const tools: AnyAgentTool[] = [];
    for (const { name: serverName, policy } of await this.mcp.policies.listEnabled()) {
      for (const remoteName of policy.allowedTools) {
        tools.push(builder(`mcp__${serverName}__${remoteName}`, remoteName,
          `Allowlisted MCP tool ${remoteName} on ${serverName}`, { type: "object", additionalProperties: true },
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


/**
 * Последствие вызова — для подтверждения действия человеком.
 *
 * Это не выбор инструментов и не их видимость: набор инструментов сессии
 * решает Letta. Здесь названы только те, чьё последствие серьёзнее
 * обычной записи, — по ним подтверждение спрашивается, по остальным нет.
 * Имя, которого в таблице нет, считается обычной записью.
 */
const TOOL_RISK: Readonly<Record<string, ToolRisk>> = Object.freeze({
  delete_notes: "destructive",
  delete_budget_records: "destructive",
  delete_tasks: "destructive",
  // Реакция — обратимое и безобидное действие в том же чате, где идёт
  // разговор: снять её можно тем же движением. Пока она числилась
  // внешним последствием, каждая просьба поддержать сообщение эмодзи
  // требовала подтверждения человека — и Ева перестала их ставить вовсе.
  set_reaction: "low_risk_write",
  // Самопроверка рантайма ничего не меняет: она только складывает уже
  // наблюдаемые факты. Спрашивать за неё подтверждение значило бы
  // требовать разрешения на вопрос «что у меня с памятью».
  inspect_eva_runtime: "read",
  knowledge_search: "read",
  upsert_user_profile_field: "sensitive_write",
  confirm_user_profile_field: "sensitive_write",
  decline_user_profile_field: "sensitive_write",
  upsert_goal: "sensitive_write",
  confirm_goal: "sensitive_write",
  upsert_goal_result: "sensitive_write",
});

const TOOL_APPROVAL_CATEGORY: Readonly<Record<string, MandatoryApprovalCategory>> = Object.freeze({
  delete_notes: "data_deletion",
  delete_budget_records: "data_deletion",
  delete_tasks: "data_deletion",
});

export function toolRisk(name: string): ToolRisk {
  // Инструмент MCP-сервера обращается к чужой системе, и её последствие
  // отсюда не видно: он всегда идёт через подтверждение.
  if (name.startsWith("mcp__")) return "external_side_effect";
  return TOOL_RISK[name] ?? "low_risk_write";
}

export function toolApprovalCategory(name: string): MandatoryApprovalCategory | undefined {
  return TOOL_APPROVAL_CATEGORY[name];
}

/**
 * Инструменты, выполняющие произвольный код и произвольную запись в
 * файловую систему хоста.
 *
 * Ева — компаньон в мессенджере. Ни один продуктовый сценарий не просит
 * запустить команду оболочки или переписать файл рядом с состоянием
 * runtime, а последствие такого вызова человек в чате оценить не может:
 * подтверждать «выполнить Bash» бессмысленно. Поэтому граница здесь
 * детерминированная и не зависит от флага подтверждений.
 *
 * Это не выбор инструментов и не их видимость: набор инструментов сессии
 * по-прежнему решает Letta, а память, MemFS, навыки, субагенты, чтение и
 * поиск остаются доступны — они в этот список не входят.
 */
const HOST_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  "Bash", "BashOutput", "KillShell", "KillBash",
  "EnterWorktree", "ExitWorktree",
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "apply_patch", "ApplyPatch", "replace", "Replace",
  "write_file", "WriteFile", "write_file_gemini", "WriteFileGemini",
]);

/**
 * Инструмент памяти узнаётся по префиксу, а не по точному имени: состав
 * зависит от toolset и модели, и закреплять одно имя значило бы отключить
 * память на следующей версии harness.
 */
const MEMORY_TOOL = /^(memory|memfs)/i;

export function isHostExecutionTool(name: string): boolean {
  if (MEMORY_TOOL.test(name)) return false;
  return HOST_EXECUTION_TOOLS.has(name);
}
