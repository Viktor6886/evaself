import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import type { AgentRuntimeContext, Database } from "./db.js";
import { GoalToolFactory } from "./goals/goal-tools.js";
import { GoalProgramToolFactory } from "./goals/goal-program-tools.js";
import { GoalProgramService } from "./goals/goal-program-service.js";
import { GoalService } from "./goals/goal-service.js";
import type { Logger } from "./logger.js";
import { ProfileToolFactory } from "./profile/profile-tools.js";
import { UserProfileService } from "./profile/profile-service.js";
import type { TelegramClient } from "./telegram.js";
import { CoreToolFactory, type RuntimeObserver } from "./tools/core-tools.js";
import { EffectJournal } from "./turns/effect-journal.js";
import { TaskToolFactory } from "./tools/task-tools.js";
import { SubscriptionStatusService } from "./subscriptions/status-service.js";
import { SubscriptionToolFactory } from "./subscriptions/subscription-tools.js";
import { OsintToolFactory } from "./osint/tools.js";
import type { OsintService } from "./osint/service.js";
import type { McpHttpInvoker, McpServerPolicyRepository } from "./tools/mcp.js";
import type { MandatoryApprovalCategory, ToolRisk } from "./tools/approvals.js";
import { bridgeTools } from "./tools/bridge-tools.js";
import {
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
  TOOL_SEARCH_NAME,
  ToolRegistry,
  type RegisteredTool,
  type ToolAssembly,
} from "./tools/registry.js";
import {
  ToolExecutor,
  type ApprovalCompletion,
  type ExecutionGate,
} from "./tools/tool-executor.js";
import type { ToolHookChain } from "./tools/tool-hooks.js";
import { neutralizeUntrusted, untrustedResult } from "./tools/untrusted.js";
import type { McpDiscovery } from "./tools/mcp-discovery.js";
import type { ToolBuilder } from "./tools/tool-kit.js";

export class AgentToolFactory {
  private readonly core: CoreToolFactory;
  private readonly profile: ProfileToolFactory;
  private readonly goals: GoalToolFactory;
  private readonly goalPrograms: GoalProgramToolFactory;
  private readonly tasks: TaskToolFactory;
  private readonly subscriptions: SubscriptionToolFactory;
  private readonly mcpTools = new Map<string, RegisteredTool[]>();
  private osint?: OsintToolFactory;
  private readonly vectorGoalsEnabled: boolean;
  private approvalCompletion?: ApprovalCompletion;
  private executionGate?: ExecutionGate;
  private readonly executor: ToolExecutor;
  readonly registry: ToolRegistry;
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
    effects?: EffectJournal,
    private readonly mcp?: {
      policies: Pick<McpServerPolicyRepository, "listEnabled">;
      invoker: Pick<McpHttpInvoker, "invokeServer">;
      /** Без обнаружения MCP-инструментов нет: схема и имя берутся только у сервера. */
      discovery?: Pick<McpDiscovery, "effective" | "retain">;
    },
    /** Наблюдатель рантайма для самопроверки. Без него инструмент честно откажет. */
    observer?: RuntimeObserver,
    private readonly runtimeInvalidator?: { invalidate(userId: number): void },
    hooks?: ToolHookChain,
  ) {
    this.vectorGoalsEnabled = config.vectorGoalsEnabled !== false;
    this.core = new CoreToolFactory(config, db, telegram, undefined, observer);
    this.profile = new ProfileToolFactory(profile ?? new UserProfileService(db));
    this.goals = new GoalToolFactory(goals ?? new GoalService(db));
    // Курсор программ идёт рядом с целями и под тем же флагом: без
    // VECTOR-целей структурированной программе не к чему привязываться.
    this.goalPrograms = new GoalProgramToolFactory(new GoalProgramService(db));
    this.tasks = new TaskToolFactory(db);
    this.subscriptions = new SubscriptionToolFactory(new SubscriptionStatusService(db));
    this.executor = new ToolExecutor({
      db,
      logger,
      ...(effects ? { effects } : {}),
      context: async (conversationId) => await this.context(conversationId),
      onContextMutation: (conversationId, userId) => {
        this.invalidate(conversationId);
        this.runtimeInvalidator?.invalidate(userId);
      },
      riskFor: toolRisk,
      approvalCompletion: () => this.approvalCompletion,
      gate: () => this.executionGate,
      ...(hooks ? { hooks } : {}),
    });
    // Порядок регистрации — порядок старшинства при коллизии имён:
    // продуктовые инструменты первыми, их не подменит одноимённый MCP.
    this.registry = new ToolRegistry({ toolSearchEnabled: () => config.toolSearchEnabled === true });
    this.registry.register({ id: "product", tools: () => this.productTools() });
    this.registry.register({ id: "mcp", tools: (conversationId) => this.mcpTools.get(conversationId) ?? [] });
  }

  setApprovalCompletionCallback(callback: ApprovalCompletion): void {
    this.approvalCompletion = callback;
  }

  /**
   * Проверка согласия при выполнении вызова через `tool_call`. Вторая,
   * независимая от `canUseTool` граница: мост не выполнит инструмент,
   * требующий согласия, без записанного согласия на этот вызов.
   */
  setExecutionGate(gate: ExecutionGate): void {
    this.executionGate = gate;
  }

  /**
   * OSINT подключается после сборки: сервис существует, когда есть слой
   * заданий. Инструменты попадают в набор, только пока флаг включён, —
   * модели незачем видеть то, что заведомо откажет.
   */
  setOsint(service: OsintService): void {
    this.osint = new OsintToolFactory(service);
  }

  /** Дополнительный источник инструментов: браузер. Регистрируется кодом сервиса. */
  registerSource(provider: Parameters<ToolRegistry["register"]>[0]): void {
    this.registry.register(provider);
  }

  /**
   * Инструменты сессии SDK.
   *
   * Продуктовые инструменты регистрируются полной схемой, как раньше.
   * Отложенные — MCP и браузер при включённом поиске инструментов —
   * попадают в каталог, и модель видит вместо них три моста. Мосты
   * появляются, только если каталог не пуст: искать в пустом незачем.
   */
  forConversation(conversationId: string): AnyAgentTool[] {
    const assembly = this.registry.assemble(conversationId);
    const tools = assembly.direct.map((tool) => this.executor.agentTool(conversationId, tool));
    if (assembly.deferred.length === 0) return tools;
    const bridge = bridgeTools({
      conversationId,
      executor: this.executor,
      catalog: () => this.registry.assemble(conversationId).deferred,
      directNames: () => new Set(this.registry.assemble(conversationId).direct.map((tool) => tool.name)),
    });
    return [
      ...tools,
      this.executor.agentTool(conversationId, bridge.search),
      this.executor.agentTool(conversationId, bridge.describe),
      bridge.call,
    ];
  }

  /**
   * Инструменты рабочего агента делегирования (`letta/subagents.ts`).
   *
   * Только чтение, и это проверка, а не договорённость: имя проходит,
   * лишь если его риск — `read`. Владелец — тот, кто заказал работу, и
   * выполнение идёт той же цепочкой с его областью арендатора и его
   * квотами. Conversation рабочего агента служебный и в продуктовой
   * таблице не записан, поэтому владелец передаётся явно.
   */
  forDelegation(input: {
    conversationId: string;
    runtime: AgentRuntimeContext;
    toolNames: readonly string[];
  }): AnyAgentTool[] {
    const allowed = input.toolNames.filter((name) => toolRisk(name) === "read");
    const assembly = this.registry.assemble(input.conversationId);
    return [...assembly.direct, ...assembly.deferred]
      .filter((tool) => allowed.includes(tool.name))
      .map((tool) => this.executor.agentTool(input.conversationId, tool, { runtime: input.runtime, allowedTools: allowed }));
  }

  /** Снимок каталога для панели и готовности: имена и происхождение, без схем. */
  assembly(conversationId: string): ToolAssembly {
    return this.registry.assemble(conversationId);
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

  /**
   * Продуктовые инструменты. Фабрики строят их прежним `ToolBuilder`;
   * здесь он лишь собирает описания в реестр — выполнение идёт через
   * общую цепочку `ToolExecutor`.
   */
  private productTools(): RegisteredTool[] {
    const specs: RegisteredTool[] = [];
    const collect: ToolBuilder = (name, label, description, parameters, execute) => {
      const spec: RegisteredTool = {
        name, label, description, parameters, execute,
        source: "product", group: "product", exposure: "direct",
      };
      specs.push(spec);
      return spec as unknown as AnyAgentTool;
    };
    this.core.build(collect);
    this.profile.build(collect);
    if (this.vectorGoalsEnabled) {
      this.goals.build(collect);
      this.goalPrograms.build(collect);
    }
    this.tasks.build(collect);
    // Статус подписки — безопасное чтение владельца conversation. Он
    // нужен Еве независимо от rollout-флага покупки/апгрейда тарифов.
    this.subscriptions.build(collect);
    if (this.osint && this.config.osintEnabled) this.osint.build(collect);
    return specs;
  }

  /**
   * Инструменты MCP для conversation: объявленные сервером (`tools/list`)
   * и разрешённые администратором. Имя, описание и схема — от сервера;
   * описание обезвреживается, потому что модель читает его как часть
   * инструкций. Без обнаружения набор пуст: инструмент со схемой «любой
   * объект» модель вызывала вслепую.
   */
  private async loadMcpTools(conversationId: string): Promise<void> {
    if (!this.mcp?.discovery) { this.mcpTools.delete(conversationId); return; }
    const discovery = this.mcp.discovery;
    const enabled = await this.mcp.policies.listEnabled();
    discovery.retain(enabled.map(({ name }) => name));
    const perServer = await Promise.all(enabled.map(async ({ name: serverName, policy }) => {
      const discovered = await discovery.effective(serverName, policy).catch((error: unknown) => {
        this.logger.warn("MCP-инструменты сервера недоступны", {
          server: serverName, code: error instanceof Error ? error.name : "unknown_error",
        });
        return [];
      });
      return discovered.map((remote): RegisteredTool => ({
        name: `mcp__${serverName}__${remote.name}`,
        label: remote.name,
        description: neutralizeUntrusted(`[MCP ${serverName}] ${remote.description || remote.name}`),
        parameters: neutralizeUntrusted(remote.inputSchema),
        source: "mcp",
        group: `mcp:${serverName}`,
        exposure: "deferred",
        // Ответ MCP-сервера пишет третья сторона: модель получает его
        // в конверте недоверенного содержимого.
        execute: async (args) => untrustedResult(
          `mcp:${serverName}`,
          await this.mcp!.invoker.invokeServer(serverName, remote.name, args),
        ),
      }));
    }));
    this.mcpTools.set(conversationId, perServer.flat());
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
  send_sticker: "low_risk_write",
  // Самопроверка рантайма ничего не меняет: она только складывает уже
  // наблюдаемые факты. Спрашивать за неё подтверждение значило бы
  // требовать разрешения на вопрос «что у меня с памятью».
  inspect_eva_runtime: "read",
  // Поиск и чтение страниц ничего не меняют ни у человека, ни снаружи:
  // тратят только квоту поиска. Для делегирования это важно — рабочему
  // агенту исследования достаются инструменты с риском `read`.
  web_search: "read",
  web_read: "read",
  get_subscription_status: "read",
  knowledge_search: "read",
  get_goal_program_context: "read",
  upsert_user_profile_field: "sensitive_write",
  confirm_user_profile_field: "sensitive_write",
  decline_user_profile_field: "sensitive_write",
  upsert_goal: "sensitive_write",
  confirm_goal: "sensitive_write",
  upsert_goal_result: "sensitive_write",
  // Исследование третьего лица — не обычная запись: человек подтверждает
  // его явно, даже если модель поняла просьбу правильно.
  osint_investigate: "sensitive_write",
  osint_get_status: "read",
  osint_get_report: "read",
  osint_list: "read",
  osint_search_entity: "read",
  osint_cancel: "low_risk_write",
  osint_delete: "destructive",
  // Мосты к отложенным инструментам сами ничего не меняют. Риск вызова
  // через `tool_call` считается по настоящему инструменту
  // (`unwrapBridgeCall`), а не по мосту.
  [TOOL_SEARCH_NAME]: "read",
  [TOOL_DESCRIBE_NAME]: "read",
  // Браузер только читает: запросы с методом, отличным от GET, сервис
  // браузера отменяет, в поля пароля и карты не вводит. Нажатие и ввод
  // меняют лишь вкладку этого разговора — обычная запись без согласия.
  browser_open: "read",
  browser_snapshot: "read",
  browser_scroll: "read",
  browser_back: "read",
  browser_close: "read",
  browser_click: "low_risk_write",
  browser_type: "low_risk_write",
});

const TOOL_APPROVAL_CATEGORY: Readonly<Record<string, MandatoryApprovalCategory>> = Object.freeze({
  delete_notes: "data_deletion",
  delete_budget_records: "data_deletion",
  delete_tasks: "data_deletion",
  osint_delete: "data_deletion",
});

export function toolRisk(name: string): ToolRisk {
  // Инструмент MCP-сервера обращается к чужой системе, и её последствие
  // отсюда не видно: он всегда идёт через подтверждение.
  if (name.startsWith("mcp__")) return "external_side_effect";
  // Мост без развёрнутой цели оценивается по худшему случаю: если
  // разворот где-то не случился, подтверждение спросится, а не пропустится.
  if (name === TOOL_CALL_NAME) return "destructive";
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
