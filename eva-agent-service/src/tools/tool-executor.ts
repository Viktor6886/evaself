/**
 * Цепочка выполнения инструмента Evaself.
 *
 * Одна на все пути вызова: прямой вызов инструмента моделью, вызов через
 * мост `tool_call` и вызов из рабочего агента исследования. Порядок
 * звеньев фиксирован и не зависит от того, как вызов пришёл:
 *
 *   область арендатора → уровень риска → подтверждение → журнал эффектов
 *   (идемпотентность) → аудит и остальные хуки → выполнение.
 *
 * Мост не получает собственной, более короткой цепочки: иначе `tool_call`
 * стал бы обходным путём мимо подтверждения и журнала. Подтверждение
 * прямого вызова спрашивает SDK до выполнения (`canUseTool`), и для
 * `tool_call` оно спрашивается там же — по настоящему инструменту
 * (`unwrapBridgeCall`). Здесь для моста стоит вторая, независимая
 * проверка: выполнить инструмент, требующий согласия, можно только при
 * записанном согласии на этот инструмент с этими аргументами.
 */

import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import { purposePolicy, type ConversationPurpose } from "../conversations/purpose-service.js";
import type { AgentRuntimeContext, Database } from "../db.js";
import type { Logger } from "../logger.js";
import { currentScope } from "../tenancy/index.js";
import { EffectJournal, effectKey } from "../turns/effect-journal.js";
import { turnOf } from "../turns/turn-context.js";
import type { ToolRisk } from "./approvals.js";
import type { RegisteredTool } from "./registry.js";
import { TOOL_CALL_NAME } from "./registry.js";
import { ToolHookChain, type ToolCallInfo } from "./tool-hooks.js";
import { asObject, withToolTurn } from "./tool-kit.js";

/**
 * Инструменты, после которых кэш контекста хода устаревает: они меняют
 * то, из чего собирается продуктовый контекст следующего хода.
 */
export const CONTEXT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
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
  "update_goal_program",
  "save_task",
  "save_tasks_bulk",
  "update_task",
  "mark_task_completed",
  "snooze_task_reminder",
  "delete_tasks",
]);

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

export function toolResult(value: unknown): ToolResult {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: serialized }], details: value };
}

/** Итог проверки согласия для вызова через мост. */
export type ExecutionVerdict = "allow" | "deny" | "approval_missing";

export type ExecutionGate = (input: {
  userId: number;
  conversationId: string;
  toolName: string;
  args: unknown;
}) => Promise<ExecutionVerdict>;

export type ApprovalCompletion = (input: {
  userId: number;
  conversationId: string;
  toolName: string;
  args: unknown;
  outcome: "executed" | "failed";
}) => Promise<unknown>;

export interface ToolExecutorDependencies {
  db: Pick<Database, "withUserScope">;
  logger: Logger;
  effects?: EffectJournal;
  /** Каноническая принадлежность conversation. */
  context(conversationId: string): Promise<AgentRuntimeContext>;
  /** Инструмент поменял то, из чего собирается контекст хода. */
  onContextMutation?(conversationId: string, userId: number): void;
  riskFor(name: string): ToolRisk;
  approvalCompletion?(): ApprovalCompletion | undefined;
  gate?(): ExecutionGate | undefined;
  hooks?: ToolHookChain;
}

export interface ToolInvocation {
  conversationId: string;
  tool: Pick<RegisteredTool, "name" | "source" | "group" | "execute">;
  rawArgs: unknown;
  toolCallId: string;
  /** Мост, через который пришёл вызов. */
  via?: typeof TOOL_CALL_NAME;
  /**
   * Владелец, заданный вызывающим, а не найденный по conversation. Нужен
   * рабочему агенту исследования: его conversation — служебный, в
   * продуктовой таблице его нет, а владелец известен заданию.
   */
  runtime?: AgentRuntimeContext;
  /**
   * Точный набор вместо политики назначения conversation. Нужен рабочему
   * агенту делегирования: его набор задаёт задание, и он уже политики
   * назначения — только чтение.
   */
  allowedTools?: readonly string[];
}

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDependencies) {}

  agentTool(
    conversationId: string,
    tool: RegisteredTool,
    options: { runtime?: AgentRuntimeContext; allowedTools?: readonly string[] } = {},
  ): AnyAgentTool {
    return {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (toolCallId: string, rawArgs: unknown) => await this.run({
        conversationId, tool, rawArgs, toolCallId: String(toolCallId ?? ""),
        ...(options.runtime ? { runtime: options.runtime } : {}),
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      }),
    } as AnyAgentTool;
  }

  async run(invocation: ToolInvocation): Promise<ToolResult> {
    const { conversationId, tool } = invocation;
    // Affinity фиксируется в момент входа callback, до любого await.
    // Иначе чтение runtime даёт следующему ходу время заменить scope.
    const turn = turnOf(conversationId);
    const startedAt = Date.now();
    let executionUserId: number | undefined;
    let info: ToolCallInfo | undefined;
    let completionAttempted = false;
    // Вызов вынесен в отдельную функцию, чтобы ранний выход —
    // отменённый ход, повтор из журнала — проходил через тот же учёт
    // исхода, что и обычное выполнение.
    const call = async (): Promise<ToolResult> => {
      const runtime = invocation.runtime ?? await this.deps.context(conversationId);
      executionUserId = runtime.userId;
      // Служебная conversation — не разговор с человеком. Её
      // назначение перечисляет, что в ней вообще позволено; список
      // объявлен один раз в purpose-service и записан вместе с самой
      // conversation, поэтому проверка идёт по нему, а не по имени.
      // Через мост проверяются оба имени: и сам мост, и инструмент.
      const policy = invocation.allowedTools
        ? { allowedTools: [...invocation.allowedTools], deniedTools: null }
        : purposePolicy(runtime.purpose as ConversationPurpose);
      for (const name of invocation.via ? [invocation.via, tool.name] : [tool.name]) {
        if ((policy.allowedTools !== null && !policy.allowedTools.includes(name)) || policy.deniedTools?.includes(name)) {
          throw new Error(`Инструмент ${name} недоступен в служебном conversation purpose=${runtime.purpose}`);
        }
      }
      // Владельцем хода инструмент считает только каноническую
      // запись conversation. Аргументы модели на выбор пользователя
      // не влияют, а расхождение с уже открытой областью — признак
      // перепутанного conversation, и работа останавливается.
      const ambient = currentScope();
      if (ambient?.kind === "user" && ambient.userId !== null && ambient.userId !== runtime.userId) {
        throw new Error("Conversation принадлежит другому пользователю, чем текущий ход");
      }
      const risk = this.deps.riskFor(tool.name);
      info = {
        name: tool.name, source: tool.source, group: tool.group, risk,
        userId: runtime.userId, conversationId, purpose: String(runtime.purpose),
        toolCallId: invocation.toolCallId, runId: turn?.runId ?? null,
        path: invocation.via === TOOL_CALL_NAME ? "bridge" : invocation.allowedTools ? "delegation" : "direct",
        startedAt,
      };
      if (invocation.via === TOOL_CALL_NAME) {
        const gate = this.deps.gate?.();
        const verdict = gate
          ? await gate({ userId: runtime.userId, conversationId, toolName: tool.name, args: invocation.rawArgs })
          : "allow";
        if (verdict === "deny") return toolResult({ ok: false, error: `Вызов ${tool.name} запрещён политикой подтверждений` });
        if (verdict === "approval_missing") {
          return toolResult({
            ok: false,
            error: `Действие ${tool.name} требует согласия человека, а согласия на этот вызов нет. `
              + "Не выполняй его и не сообщай о результате, которого не было.",
          });
        }
      }
      // Барьер отмены перед побочным эффектом. Отменённый ход не
      // должен делать того, что потом нельзя отменить.
      if (turn && await turn.isCancelled()) return toolResult({ ok: false, error: "ход отменён" });
      // Побочный эффект выполняется не более одного раза на вызов.
      // Ключ детерминированный, поэтому повтор хода после сбоя
      // возвращает прежний результат, а не делает действие второй раз.
      // Ход берётся и по контексту, и по conversation: инструменты
      // регистрируются при открытии сессии, и до их вызова из
      // обработчика сокета SDK AsyncLocalStorage не дотягивается.
      const key = turn?.recorded && invocation.toolCallId.trim()
        ? effectKey(turn.runId, invocation.toolCallId, tool.name)
        : null;
      const effects = key ? this.deps.effects : undefined;
      if (key && effects) {
        const decision = await effects.begin({
          key, runId: turn!.runId, userId: runtime.userId, toolName: tool.name,
          toolCallId: invocation.toolCallId || "no-call-id",
        });
        if (decision.action === "replay") return toolResult(decision.result);
        if (decision.action === "skip") {
          return toolResult({
            ok: false,
            error: decision.reason === "in_flight"
              ? "этот вызов уже выполняется"
              : `предыдущая попытка отказала: ${decision.errorCode ?? "неизвестно"}`,
          });
        }
      }
      const denied = await this.deps.hooks?.before(info);
      if (denied) {
        if (key && effects) await effects.fail(key, runtime.userId, "hook_denied", true);
        return toolResult({ ok: false, error: denied });
      }
      let output: unknown;
      try {
        output = await this.deps.db.withUserScope(
          { userId: runtime.userId, telegramId: runtime.telegramId, label: `tool:${tool.name}` },
          async () => await tool.execute(asObject(invocation.rawArgs), withToolTurn(runtime, turn), invocation.toolCallId),
        );
      } catch (error) {
        if (key && effects) {
          // Повторять можно то, что сорвалось по дороге, а не то, что
          // модель попросила неправильно.
          await effects.fail(
            key, runtime.userId,
            error instanceof Error ? error.name : "unknown_error",
            !(error instanceof Error && error.name === "TypeError"),
          );
        }
        throw error;
      }
      if (key && effects) await effects.succeed(key, runtime.userId, output);
      if (CONTEXT_MUTATING_TOOLS.has(tool.name)) this.deps.onContextMutation?.(conversationId, runtime.userId);
      await this.deps.hooks?.after(info, { durationMs: Date.now() - startedAt, refused: refusedResult(output) });
      return toolResult(output);
    };
    try {
      const called = await call();
      if (executionUserId !== undefined) {
        completionAttempted = true;
        await this.recordOutcome({ userId: executionUserId, conversationId, toolName: tool.name, args: invocation.rawArgs, outcome: "executed" });
      }
      return called;
    } catch (error) {
      if (executionUserId !== undefined && !completionAttempted) {
        completionAttempted = true;
        await this.recordOutcome({ userId: executionUserId, conversationId, toolName: tool.name, args: invocation.rawArgs, outcome: "failed" });
      }
      if (info) {
        await this.deps.hooks?.error(info, {
          durationMs: Date.now() - startedAt,
          code: error instanceof Error ? error.name : "unknown_error",
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn("Инструмент Agent SDK завершился ошибкой", { tool: tool.name, conversationId, message });
      return toolResult({ ok: false, error: message });
    }
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
  private async recordOutcome(input: Parameters<ApprovalCompletion>[0]): Promise<void> {
    try {
      await this.deps.approvalCompletion?.()?.(input);
    } catch (error) {
      this.deps.logger.warn("Учёт исхода инструмента не выполнен", {
        tool: input.toolName,
        conversationId: input.conversationId,
        stage: "approval",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function refusedResult(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && (output as { ok?: unknown }).ok === false);
}
