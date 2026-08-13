/**
 * Универсальный фоновый ход агента.
 *
 * Рефлексия, отчёты и исследования — это одна и та же механика с разными
 * инструкциями: выделенная conversation по назначению, объявленный
 * бюджет, ограниченный набор инструментов и структурированный ответ.
 * Три отдельные реализации разошлись бы по бюджетам и по тому, что
 * считается допустимым результатом, и первая же правка политики
 * применилась бы к одной из них. Поэтому механизм здесь один, а шаги 21
 * и 24 приносят только спецификации.
 *
 * Чего agent job не делает — важнее того, что делает:
 *
 *   1. Не пишет каноническую память (инвариант 18). Он возвращает
 *      типизированное предложение, а записывает его серверный код —
 *      позже и отдельно.
 *   2. Не пишет пользователю. Назначение conversation выбирается из тех,
 *      у которых `canSendToUser = false`, и это проверяется, а не
 *      подразумевается.
 *   3. Не выходит за бюджет. Токены, время и стоимость объявляются до
 *      хода; превышение — валидный исход, а не исключение.
 *
 * «Ничего не предлагать» — тоже успех. Фоновый ход, обязанный что-то
 * вернуть, начинает придумывать: пустой результат должен быть дешевле
 * выдуманного.
 */

import type { ConversationPurpose, ConversationPurposeService } from "../conversations/purpose-service.js";
import { purposePolicy } from "../conversations/purpose-service.js";
import type { Database } from "../db.js";
import type { LettaService } from "../letta.js";
import type { Logger } from "../logger.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";

/**
 * Назначение фонового хода. `chat` исключён типом, а не проверкой:
 * основная conversation человека — это его разговор, и служить рабочим
 * местом фонового задания она не может.
 */
export type AgentJobPurpose = Exclude<ConversationPurpose, "chat">;

export interface AgentJobBudget {
  /** Legacy combined cap retained for existing job specifications. */
  maxTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxDurationMs: number;
  /** Микроединицы валюты: доли копейки складываются, целые — теряются. */
  maxCostMicros: number;
}

export interface AgentJobSpec {
  /** Тип задания. Он же имя обработчика в `JobRuntime`. */
  jobType: string;
  purpose: AgentJobPurpose;
  budget: AgentJobBudget;
  /**
   * Инструкция модели. Пишется в коде, а не приходит из данных
   * пользователя: инструкция из данных — это и есть внедрение промпта.
   */
  instruction: string;
  /** Какие виды предложений допустимы. Всё остальное — невалидный результат. */
  resultKinds: readonly string[];
  /** Сколько предложений имеет смысл принять за один ход. */
  maxItems?: number;
  /**
   * Собственный разбор ответа.
   *
   * Общий формат предложения — «вид, ссылка, выжимка» — годится для
   * рефлексии и отчётов, но не для заданий с собственной строгой
   * схемой: Curator обязан вернуть периоды действительности, ссылки на
   * сообщения и режим приватности, и уложить их в `summary` значило бы
   * снова разбирать свободный текст. Спецификация приносит свой
   * разборщик, а механизм фонового хода остаётся один (инвариант 3).
   */
  parseResult?: (reply: string) => ProposalParse;
  /** Инструкция про формат ответа задаётся спецификацией целиком. */
  responseContract?: readonly string[];
  /** Retry one malformed structured response with a schema-only repair instruction. */
  repairInvalidResult?: boolean;
  modelPolicy?: "economy" | "auto" | "quality";
  allowedTools?: readonly string[];
  allowedSkills?: readonly string[];
  memoryScopes?: readonly string[];
}

export interface AgentProposalItem {
  kind: string;
  /** Ссылка на сущность: узел памяти, цель, задача. Не пересказ. */
  ref: string | null;
  summary: string;
  confidence: number;
}

export interface AgentProposal {
  kind: string;
  /** Модель сочла, что предлагать нечего. Валидный успех. */
  empty: boolean;
  items: AgentProposalItem[];
  confidence: number;
  /**
   * Проверенная схемой полезная нагрузка задания со своим форматом.
   * Заполняется только собственным разборщиком спецификации; общий
   * разбор её не создаёт.
   */
  payload?: Record<string, unknown>;
}

export interface AgentJobUsage {
  /** Combined projection retained for persisted consumers. */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costMicros: number;
}

export type AgentJobOutcome =
  | { status: "succeeded"; proposal: AgentProposal; usage: AgentJobUsage }
  | { status: "empty"; usage: AgentJobUsage }
  | { status: "budget_exceeded"; usage: AgentJobUsage; limit: keyof AgentJobBudget }
  | { status: "invalid_result"; usage: AgentJobUsage; code: string }
  | { status: "failed"; usage: AgentJobUsage; code: string };

export interface AgentJobInput {
  runId: string;
  userId: number;
  agentId: string;
  /** Основная conversation человека: от неё наследуется служебная. */
  parentConversationId: string;
  spec: AgentJobSpec;
  /** Прерывание по сроку задания, потере аренды или отмене. */
  signal: AbortSignal;
  /** Дополнительные безопасные факты запроса: только идентификаторы. */
  facts?: Record<string, string | number | boolean | null>;
}

export class AgentJobError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AgentJobError";
  }
}

const MAX_SUMMARY = 400;

export class AgentJobRunner {
  constructor(
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly purposes: ConversationPurposeService,
    private readonly runtimeContext: RuntimeContextBuilder,
    private readonly logger: Logger,
    private readonly enabled: boolean,
  ) {}

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Выполнить фоновый ход.
   *
   * Метод не бросает: исход возвращается значением, потому что
   * «превысил бюджет» и «вернул мусор» — это результаты работы, а не
   * поломка, и обработчик задания решает по ним, повторять ли.
   */
  async run(input: AgentJobInput): Promise<AgentJobOutcome> {
    const startedAt = Date.now();
    const empty: AgentJobUsage = { tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, costMicros: 0 };
    if (!this.enabled) {
      return { status: "failed", usage: empty, code: "agent_jobs_disabled" };
    }
    const policy = purposePolicy(input.spec.purpose);
    if (policy.canSendToUser) {
      // Назначение, из которого можно писать человеку, для фонового хода
      // не годится: агент отправил бы сообщение сам, минуя outbox и
      // проверку тихих часов.
      return { status: "failed", usage: empty, code: "agent_job_purpose_forbidden" };
    }
    if (input.signal.aborted) {
      return { status: "failed", usage: empty, code: "aborted" };
    }

    try {
      const conversation = await this.purposes.ensure({
        userId: input.userId,
        agentId: input.agentId,
        purpose: input.spec.purpose,
        parentConversationId: input.parentConversationId,
      });
      const instruction = this.buildInstruction(input);
      const context = await this.runtimeContext.build({
        userId: input.userId,
        conversationId: conversation.conversationId,
        userMessage: instruction,
        detectLanguage: false,
        memoryScopes: input.spec.memoryScopes,
        allowedSkills: input.spec.allowedSkills,
        modelPolicy: input.spec.modelPolicy,
      });
      const prompt = this.runtimeContext.wrapUserMessage(context, instruction, {
        internalOperationType: input.spec.jobType,
        correlationId: input.runId,
      });

      const deadline = new AbortController();
      const abortFromParent = () => deadline.abort(input.signal.reason);
      input.signal.addEventListener("abort", abortFromParent, { once: true });
      const timeout = setTimeout(() => deadline.abort(new AgentJobError("agent_job_timeout")), Math.max(1, input.spec.budget.maxDurationMs));
      const turnPromise = this.letta.runTurn(conversation.conversationId, prompt, {
        isCancelled: async () => deadline.signal.aborted,
        cancelPollMs: 50,
        allowedTools: input.spec.allowedTools,
        canUseTool: async (toolName) => input.spec.allowedTools?.includes(toolName)
          ? { behavior: "allow", updatedInput: {} }
          : { behavior: "deny", message: `Tool ${toolName} is outside the job allowlist` },
      });
      const aborted = new Promise<never>((_resolve, reject) => deadline.signal.addEventListener("abort", () => {
        void this.letta.abortTurn(conversation.conversationId).catch(() => undefined).finally(() => {
          reject(deadline.signal.reason instanceof Error ? deadline.signal.reason : new AgentJobError("aborted"));
        });
      }, { once: true }));
      const turn = await Promise.race([turnPromise, aborted]).finally(() => {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abortFromParent);
      });

      let usage = this.usageOf(turn.usage, startedAt);
      const overspent = this.overBudget(usage, input.spec.budget);
      if (overspent) {
        // Результат при превышении не принимается: принять его значило бы
        // объявить бюджет пожеланием.
        await this.persist(input, conversation.conversationId, "budget_exceeded", null, usage, true);
        return { status: "budget_exceeded", usage, limit: overspent };
      }

      let parsed = input.spec.parseResult
        ? input.spec.parseResult(turn.reply)
        : parseProposal(turn.reply, input.spec);
      if (!parsed.ok && input.spec.repairInvalidResult) {
        const repairInstruction = `${instruction}\n\nПредыдущий ответ отклонён валидатором (${parsed.code}). Исправь только формат: верни ОДИН JSON по контракту, не цитируя предыдущий ответ.`;
        const repairContext = await this.runtimeContext.build({ userId: input.userId, conversationId: conversation.conversationId, userMessage: repairInstruction, detectLanguage: false, memoryScopes: input.spec.memoryScopes, allowedSkills: input.spec.allowedSkills, modelPolicy: input.spec.modelPolicy });
        const repairPrompt = this.runtimeContext.wrapUserMessage(repairContext, repairInstruction, { internalOperationType: input.spec.jobType, correlationId: input.runId });
        const repairedTurn = await this.letta.runTurn(conversation.conversationId, repairPrompt, { isCancelled: async () => deadline.signal.aborted, cancelPollMs: 50, allowedTools: input.spec.allowedTools, canUseTool: async (toolName) => input.spec.allowedTools?.includes(toolName) ? { behavior: "allow", updatedInput: {} } : { behavior: "deny", message: `Tool ${toolName} is outside the job allowlist` } });
        const repairedUsage = this.usageOf(repairedTurn.usage, startedAt);
        usage = {
          tokens: usage.tokens + repairedUsage.tokens,
          inputTokens: usage.inputTokens + repairedUsage.inputTokens,
          outputTokens: usage.outputTokens + repairedUsage.outputTokens,
          durationMs: repairedUsage.durationMs,
          costMicros: usage.costMicros + repairedUsage.costMicros,
        };
        const repairOverspent = this.overBudget(usage, input.spec.budget);
        if (repairOverspent) {
          await this.persist(input, conversation.conversationId, "budget_exceeded", null, usage, true);
          return { status: "budget_exceeded", usage, limit: repairOverspent };
        }
        parsed = input.spec.parseResult ? input.spec.parseResult(repairedTurn.reply) : parseProposal(repairedTurn.reply, input.spec);
      }
      if (!parsed.ok) {
        await this.persist(input, conversation.conversationId, "invalid_result", null, usage, false, parsed.code);
        return { status: "invalid_result", usage, code: parsed.code };
      }
      if (parsed.proposal.empty || parsed.proposal.items.length === 0) {
        await this.persist(input, conversation.conversationId, "empty", parsed.proposal, usage, false);
        return { status: "empty", usage };
      }
      await this.persist(input, conversation.conversationId, "succeeded", parsed.proposal, usage, false);
      return { status: "succeeded", proposal: parsed.proposal, usage };
    } catch (error) {
      const usage = { tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - startedAt, costMicros: 0 };
      const code = error instanceof Error ? (error.name === "AgentJobError" ? (error as AgentJobError).code : error.name) : "unknown_error";
      await this.persist(input, input.parentConversationId, "failed", null, usage, false, code);
      this.logger.warn("Фоновый ход агента не выполнен", {
        jobType: input.spec.jobType,
        code,
      });
      return { status: "failed", usage, code };
    }
  }

  /**
   * Текст запроса.
   *
   * Факты передаются как пары «ключ: значение» и только из безопасного
   * набора: идентификаторы, числа и флаги. Пользовательский текст в
   * инструкцию не подставляется — иначе фоновый ход стал бы каналом
   * внедрения промпта из данных.
   */
  private buildInstruction(input: AgentJobInput): string {
    const facts = Object.entries(input.facts ?? {})
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("\n");
    if (input.spec.responseContract) {
      return [
        input.spec.instruction,
        facts ? `\nДанные запроса:\n${facts}` : "",
        "",
        ...input.spec.responseContract,
      ].filter(Boolean).join("\n");
    }
    return [
      input.spec.instruction,
      facts ? `\nДанные запроса:\n${facts}` : "",
      "",
      "Ответь ОДНИМ объектом JSON и ничем больше:",
      `{"kind": "<один из: ${input.spec.resultKinds.join(", ")}>",`,
      ` "empty": <true, если предлагать нечего>,`,
      ` "confidence": <0..1>,`,
      ` "items": [{"kind": "...", "ref": "<идентификатор или null>",`,
      `            "summary": "<до ${MAX_SUMMARY} знаков>", "confidence": <0..1>}]}`,
      "Если полезного предложения нет, верни empty=true и пустой items.",
      "Это предложение, а не действие: ничего не сохраняй и не отправляй.",
    ].filter(Boolean).join("\n");
  }

  private usageOf(usage: Record<string, unknown> | null, startedAt: number): AgentJobUsage {
    const number = (value: unknown): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    };
    const inputTokens = usage ? number(usage.input_tokens) || number(usage.prompt_tokens) : 0;
    const outputTokens = usage ? number(usage.output_tokens) || number(usage.completion_tokens) : 0;
    const tokens = usage ? number(usage.total_tokens) || inputTokens + outputTokens : 0;
    return {
      tokens, inputTokens, outputTokens,
      durationMs: Date.now() - startedAt,
      costMicros: usage ? number(usage.cost_micros) : 0,
    };
  }

  private overBudget(usage: AgentJobUsage, budget: AgentJobBudget): keyof AgentJobBudget | null {
    if ((budget.maxInputTokens ?? 0) > 0 && usage.inputTokens > budget.maxInputTokens!) return "maxInputTokens";
    if ((budget.maxOutputTokens ?? 0) > 0 && usage.outputTokens > budget.maxOutputTokens!) return "maxOutputTokens";
    if (budget.maxTokens && usage.tokens > budget.maxTokens) return "maxTokens";
    if (budget.maxDurationMs > 0 && usage.durationMs > budget.maxDurationMs) return "maxDurationMs";
    if (budget.maxCostMicros > 0 && usage.costMicros > budget.maxCostMicros) return "maxCostMicros";
    return null;
  }

  /**
   * Записать исход.
   *
   * Отказ записи не отменяет результат хода: вызывающий уже получил
   * предложение, и терять его из-за журнала неправильно. Но и молча
   * терять запись нельзя — она уходит в лог.
   */
  private async persist(
    input: AgentJobInput,
    conversationId: string,
    status: string,
    proposal: AgentProposal | null,
    usage: AgentJobUsage,
    budgetExceeded: boolean,
    errorCode?: string,
  ): Promise<void> {
    try {
      await this.db.withUserScope(
        { userId: input.userId, label: "jobs.agent.result", inherit: true },
        async () => await this.db.query(
          `INSERT INTO agent_job_results (
             run_id, user_id, job_type, conversation_id, purpose, status,
             result, tokens_used, duration_ms, cost_micros, budget_exceeded, error_code
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
           ON CONFLICT (run_id) DO NOTHING`,
          [
            input.runId,
            input.userId,
            input.spec.jobType,
            conversationId,
            input.spec.purpose,
            status,
            JSON.stringify(proposal ?? {}),
            usage.inputTokens + usage.outputTokens,
            usage.durationMs,
            usage.costMicros,
            budgetExceeded,
            errorCode ?? null,
          ],
        ),
      );
    } catch (error) {
      this.logger.warn("Результат фонового хода не записан", {
        jobType: input.spec.jobType,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}

export type ProposalParse =
  | { ok: true; proposal: AgentProposal }
  | { ok: false; code: string };

/**
 * Разобрать ответ модели.
 *
 * Проверяет серверный код, а не модель (инвариант 18): вид предложения
 * должен входить в объявленный спецификацией список, уверенность —
 * лежать в [0, 1], число предложений — не превышать предел. Модель,
 * вернувшая «почти правильный» ответ, получает `invalid_result`, а не
 * снисхождение.
 */
export function parseProposal(reply: string, spec: AgentJobSpec): ProposalParse {
  const raw = extractJson(reply);
  if (!raw) return { ok: false, code: "agent_result_not_json" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "agent_result_not_json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "agent_result_not_object" };
  }
  const candidate = value as Record<string, unknown>;
  const kind = typeof candidate.kind === "string" ? candidate.kind : "";
  if (!spec.resultKinds.includes(kind)) return { ok: false, code: "agent_result_kind_unknown" };

  const empty = candidate.empty === true;
  const confidence = clamp01(candidate.confidence);
  if (confidence === null) return { ok: false, code: "agent_result_confidence_invalid" };

  const rawItems = Array.isArray(candidate.items) ? candidate.items : [];
  if (rawItems.length > (spec.maxItems ?? 10)) {
    return { ok: false, code: "agent_result_too_many_items" };
  }
  const items: AgentProposalItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, code: "agent_result_item_invalid" };
    }
    const item = entry as Record<string, unknown>;
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    if (!summary) return { ok: false, code: "agent_result_item_empty" };
    const itemKind = typeof item.kind === "string" && item.kind ? item.kind : kind;
    const itemConfidence = item.confidence === undefined ? confidence : clamp01(item.confidence);
    if (itemConfidence === null) return { ok: false, code: "agent_result_confidence_invalid" };
    items.push({
      kind: itemKind,
      ref: typeof item.ref === "string" && item.ref ? item.ref.slice(0, 200) : null,
      // Длина ограничивается здесь: предложение — это выжимка, а не
      // пересказ разговора, и хранить его целиком незачем.
      summary: summary.slice(0, MAX_SUMMARY),
      confidence: itemConfidence,
    });
  }
  return { ok: true, proposal: { kind, empty: empty || items.length === 0, items, confidence } };
}

function clamp01(value: unknown): number | null {
  if (value === undefined || value === null) return 0.5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}

/**
 * Вырезать объект JSON из ответа.
 *
 * Модель регулярно оборачивает ответ в ```json — это не повод считать
 * результат невалидным. А вот текст вокруг объекта уже повод: он
 * означает, что инструкцию «ответь одним объектом» модель не выполнила,
 * и остальное содержимое может быть чем угодно.
 */
function extractJson(reply: string): string | null {
  const text = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
  return candidate;
}
