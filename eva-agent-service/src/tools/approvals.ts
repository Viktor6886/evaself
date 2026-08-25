import type { Database } from "../db.js";
import type { CanUseToolCallback } from "@letta-ai/letta-agent-sdk";
import type { OutboxDelivery } from "../delivery/outbox.js";
import { createHash } from "node:crypto";

/**
 * Уровень последствия вызова. Он нужен единственному потребителю —
 * подтверждению действия человеком: столбцы `tool_approvals.risk` и
 * `tool_approval_rules.max_risk` хранят те же значения.
 */
export const TOOL_RISKS = ["read", "low_risk_write", "sensitive_write", "external_side_effect", "destructive"] as const;
export type ToolRisk = typeof TOOL_RISKS[number];

export const APPROVAL_STATUSES = ["pending", "approved_once", "approved_session", "denied", "expired", "cancelled", "executed", "failed"] as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];
export type ApprovalDecision = "allow" | "deny";
export type MandatoryApprovalCategory = "data_deletion" | "subscription_change" | "third_party_transfer" | "new_service" | "bulk_task_change" | "memory_export" | "irreversible_admin";

interface ApprovalRow {
  user_id: number;
  conversation_id: string | null;
  sdk_request_id: string;
  tool_name: string;
  risk: ToolRisk;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
}

interface ApprovalRuleRow {
  decision: ApprovalDecision;
  scope: "standing" | "session";
  max_risk: ToolRisk;
}

const RISK_RANK: Record<ToolRisk, number> = {
  read: 0, low_risk_write: 1, sensitive_write: 2, external_side_effect: 3, destructive: 4,
};

const SECRET_KEY = /(?:secret|token|password|authorization|cookie|api[_-]?key|credential)/i;

function canonicalApprovalArguments(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ["number", "NaN"];
    if (value === Infinity) return ["number", "+Infinity"];
    if (value === -Infinity) return ["number", "-Infinity"];
    if (Object.is(value, -0)) return ["number", "-0"];
    return ["number", value];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "undefined") return ["undefined"];
  if (typeof value === "symbol" || typeof value === "function") return [typeof value, String(value)];

  if (ancestors.has(value)) throw new TypeError("Approval arguments must not contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return ["array", value.map((entry) => canonicalApprovalArguments(entry, ancestors))];
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalApprovalArguments((value as Record<string, unknown>)[key], ancestors)]);
    return ["object", entries];
  } finally {
    ancestors.delete(value);
  }
}

/** Digests complete canonical arguments; only the digest, never raw or secret values, is persisted. */
export function fingerprintApprovalArguments(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalApprovalArguments(args))).digest("hex");
}
export function describeApprovalAction(toolName: string, args: unknown): { description: string; affectedData: Record<string, unknown> } {
  const safeName = toolName.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80) || "tool";
  const affectedData: Record<string, unknown> = {};
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [rawKey, value] of Object.entries(args as Record<string, unknown>).slice(0, 20)) {
      const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
      if (!key || SECRET_KEY.test(key)) continue;
      if (typeof value === "number" || typeof value === "boolean" || value === null) affectedData[key] = value;
      else if (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === "number" || typeof item === "boolean")) affectedData[key] = value;
      else if (typeof value === "string") affectedData[key] = { type: "text", length: value.length };
      else affectedData[key] = { type: Array.isArray(value) ? "list" : "object", count: Array.isArray(value) ? value.length : Object.keys(value as object).length };
    }
  }
  return { description: `Подтвердите действие инструмента «${safeName}»`, affectedData };
}

export function approvalRequiredFor(risk: ToolRisk, category?: MandatoryApprovalCategory): boolean {
  return category !== undefined || ["sensitive_write", "external_side_effect", "destructive"].includes(risk);
}

/** Fixed order: a lower-priority grant can never override an earlier denial. */
export function approvalDecision(input: {
  explicitDeny: boolean;
  actorAllowed: boolean;
  toolAllowed: boolean;
  persistent: ApprovalDecision | null;
  temporary: ApprovalDecision | null;
  riskAtOrBelowThreshold: boolean;
}): ApprovalDecision | "approval_required" {
  if (input.explicitDeny || !input.actorAllowed || !input.toolAllowed) return "deny";
  if (input.persistent) return input.persistent;
  if (input.temporary) return input.temporary;
  return input.riskAtOrBelowThreshold ? "allow" : "approval_required";
}

export class ApprovalService {
  private readonly waiters = new Map<string, Set<(decision: ApprovalDecision) => void>>();
  constructor(private readonly db: Database, private readonly enabled: boolean, private readonly dependencies: {
    outbox?: Pick<OutboxDelivery, "send">;
    lifecycle?: { transition(turn: unknown, state: "approval_pending" | "tools_pending"): Promise<boolean> };
    /**
     * Журнал. Без него ход, остановленный подтверждением, не оставляет
     * следа: человек видит молчание, а оператор — ничего. Пишется только
     * метаданные — имя инструмента, риск и отпечаток аргументов; сами
     * аргументы могут содержать текст человека и в журнал не попадают
     * (инвариант 19).
     */
    logger?: { info(message: string, meta?: Record<string, unknown>): void };
    pollIntervalMs?: number;
    waitTimeoutMs?: number;
  } = {}) {}

  private scoped<T>(userId: number, work: () => Promise<T>): Promise<T> {
    return this.db.withUserScope({ userId, label: "tool.approvals", inherit: true }, work);
  }

  async request(input: { userId: number; conversationId?: string | null; sdkRequestId: string; toolName: string; risk: ToolRisk; description: string; affectedData?: Record<string, unknown>; argumentFingerprint?: string }): Promise<ApprovalRow> {
    if (!this.enabled) throw new Error("Tool approvals are disabled");
    if (!input.sdkRequestId) throw new Error("SDK request id is required");
    return await this.scoped(input.userId, async () => {
      const { rows } = await this.db.query<ApprovalRow>(
        `INSERT INTO tool_approvals (user_id, conversation_id, sdk_request_id, tool_name, risk, argument_fingerprint, status, action_description, affected_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         ON CONFLICT (user_id, sdk_request_id) DO UPDATE SET sdk_request_id = EXCLUDED.sdk_request_id
         RETURNING user_id, conversation_id, sdk_request_id, tool_name, risk, status, decision`,
        [input.userId, input.conversationId ?? null, input.sdkRequestId, input.toolName, input.risk, input.argumentFingerprint ?? fingerprintApprovalArguments({}), input.description.slice(0, 240), input.affectedData ?? {}],
      );
      return rows[0]!;
    });
  }

  /**
   * Сколько живёт незакрытая строка подтверждения.
   *
   * Ожидание решения ограничено `waitTimeoutMs` (по умолчанию пятнадцать
   * минут), поэтому всё, что старше часа, к живому ходу отношения уже не
   * имеет: либо процесс умер между решением и его исполнением, либо
   * закрытие подтверждения отказало и было записано только в журнал.
   */
  private get staleAfterMs(): number {
    return Math.max(this.dependencies.waitTimeoutMs ?? 15 * 60_000, 1) * 4;
  }

  /**
   * Примирение незакрытых подтверждений.
   *
   * Без него строка, чьё закрытие не состоялось, остаётся `approved_once`
   * навсегда: восстановление открывает её conversation при каждом старте,
   * а разовое разрешение продолжает висеть выданным. Разрешение снимается
   * в сторону отказа — не выполненным считать нельзя, зато повторный
   * вызов спросит человека заново, а не воспользуется старым «да».
   *
   * Отказ человека (`denied`) не трогаем: это его решение и оно остаётся
   * в истории; из восстановления такие строки уходят по сроку.
   */
  async reconcileStaleApprovals(): Promise<number> {
    if (!this.enabled) return 0;
    const result = await this.db.withSystemScope(
      "tool.approvals.reconcile",
      async () => await this.db.query(
        `-- tenant: system — общесистемная сверка незакрытых подтверждений,
         -- владелец каждой строки остаётся её собственным
         UPDATE tool_approvals
            SET status = 'expired', decision = 'deny',
                decided_at = COALESCE(decided_at, now())
          WHERE status IN ('pending', 'approved_once', 'approved_session')
            AND COALESCE(decided_at, created_at) < now() - make_interval(secs => $1)`,
        [Math.ceil(this.staleAfterMs / 1000)],
      ),
      { crossUser: true },
    );
    return result.rowCount ?? 0;
  }

  /**
   * Восстановление после перезапуска: conversation открывается заново,
   * чтобы SDK получил уже принятое решение, а не спрашивал второй раз.
   *
   * Сначала примирение, потом выборка — иначе застрявшая строка открывала
   * бы свою conversation при каждом старте до конца жизни установки. По
   * той же причине выборка ограничена сроком: решение, которому больше
   * часа, живому ходу уже не принадлежит.
   */
  async recoverPendingApprovals(reacquire: (conversationId: string) => Promise<void>): Promise<number> {
    if (!this.enabled) return 0;
    await this.reconcileStaleApprovals();
    const { rows } = await this.db.withSystemScope(
      "tool.approvals.recovery",
      async () => await this.db.query<{ user_id: number; conversation_id: string }>(
        `-- tenant: system — enumerate canonical owners before reopening exact conversations
         SELECT DISTINCT user_id, conversation_id FROM tool_approvals
          WHERE status IN ('pending', 'approved_once', 'approved_session', 'denied')
            AND conversation_id IS NOT NULL
            AND COALESCE(decided_at, created_at) >= now() - make_interval(secs => $1)`,
        [Math.ceil(this.staleAfterMs / 1000)],
      ),
      { crossUser: true },
    );
    for (const row of rows) await this.scoped(Number(row.user_id), async () => await reacquire(row.conversation_id));
    return rows.length;
  }

  async completeApprovedExecution(input: { userId: number; conversationId: string; toolName: string; args: unknown; outcome: "executed" | "failed" }): Promise<boolean> {
    // Выключенная подсистема учёта не ведёт: строк подтверждения нет, а
    // обращение к таблице шло бы после каждого вызова инструмента.
    if (!this.enabled) return false;
    return await this.scoped(input.userId, async () => {
      const result = await this.db.query(
        // Владелец назван в обеих частях запроса. Границе арендатора видна
        // только сама цель UPDATE: связь `approval.user_id =
        // claimed.user_id` уводит ограничение в CTE, и запрос считается
        // неограниченным — в области пользователя он отвергается целиком,
        // а вместе с ним отказывает и уже выполненный инструмент.
        `WITH matching_approval AS (
           SELECT user_id, sdk_request_id
             FROM tool_approvals
            WHERE user_id = $2 AND conversation_id = $3 AND tool_name = $4
              AND argument_fingerprint = $5
              AND status IN ('approved_once', 'approved_session')
            ORDER BY created_at, sdk_request_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE tool_approvals AS approval SET status = $1
          FROM matching_approval AS claimed
         WHERE approval.user_id = $2
           AND approval.user_id = claimed.user_id
           AND approval.sdk_request_id = claimed.sdk_request_id
         RETURNING approval.sdk_request_id`,
        [input.outcome, input.userId, input.conversationId, input.toolName, fingerprintApprovalArguments(input.args)],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async lookup(userId: number, sdkRequestId: string): Promise<ApprovalRow | null> {
    return await this.scoped(userId, async () => {
      const { rows } = await this.db.query<ApprovalRow>(
        `SELECT user_id, sdk_request_id, tool_name, risk, status, decision
           FROM tool_approvals WHERE user_id = $1 AND sdk_request_id = $2`,
        [userId, sdkRequestId],
      );
      return rows[0] ?? null;
    });
  }

  async decide(input: { userId: number; sdkRequestId: string; status: "approved_once" | "approved_session" | "denied" | "cancelled"; actorDecision: ApprovalDecision }): Promise<ApprovalRow> {
    const decision: ApprovalDecision = input.status === "denied" || input.status === "cancelled" ? "deny" : input.actorDecision;
    return await this.scoped(input.userId, async () => {
      const { rows } = await this.db.query<ApprovalRow>(
        `UPDATE tool_approvals SET status = $1, decision = $2, decided_at = now()
          WHERE user_id = $3 AND sdk_request_id = $4 AND status = 'pending'
          RETURNING user_id, sdk_request_id, tool_name, risk, status, decision`,
        [input.status, decision, input.userId, input.sdkRequestId],
      );
      if (!rows[0]) throw new Error("Pending approval not found");
      const row = rows[0];
      for (const resolve of this.waiters.get(`${input.userId}:${input.sdkRequestId}`) ?? []) resolve(decision);
      this.waiters.delete(`${input.userId}:${input.sdkRequestId}`);
      return row;
    });
  }

  async decideByTelegram(input: { telegramId: number; sdkRequestId: string; decision: ApprovalDecision }): Promise<ApprovalRow> {
    return await this.db.withUserScope({ telegramId: input.telegramId, label: "tool.approvals.decision" }, async () => {
      const { rows } = await this.db.query<{ id: number }>("SELECT id FROM users WHERE telegram_id = $1", [input.telegramId]);
      const userId = rows[0]?.id;
      if (!userId) throw new Error("Approval owner not found");
      this.db.bindScopeUserId(userId);
      return await this.decide({ userId, sdkRequestId: input.sdkRequestId,
        status: input.decision === "allow" ? "approved_once" : "denied", actorDecision: input.decision });
    });
  }

  async sdkDecision(userId: number, sdkRequestId: string): Promise<ApprovalDecision | null> {
    const row = await this.lookup(userId, sdkRequestId);
    if (!row || row.status === "pending") return null;
    return row.decision ?? (row.status.startsWith("approved_") ? "allow" : "deny");
  }

  async evaluatePolicy(input: {
    userId: number; toolName: string; risk: ToolRisk; sessionId: string | null;
    actorAllowed: boolean; toolAllowed: boolean; riskThreshold?: ToolRisk; category?: MandatoryApprovalCategory;
  }): Promise<ApprovalDecision | "approval_required"> {
    if (input.toolName.includes("*") || !input.toolName.trim()) return "deny";
    const rules = await this.scoped(input.userId, async () => {
      const { rows } = await this.db.query<ApprovalRuleRow>(
        `SELECT decision, scope, max_risk FROM tool_approval_rules
          WHERE user_id = $1 AND tool_name = $2
            AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
            AND (scope = 'standing' OR (scope = 'session' AND session_id = $3))`,
        [input.userId, input.toolName, input.sessionId],
      );
      return rows.filter((rule) => RISK_RANK[input.risk] <= RISK_RANK[rule.max_risk]);
    });
    const decision = approvalDecision({
      explicitDeny: rules.some((rule) => rule.decision === "deny"),
      actorAllowed: input.actorAllowed,
      toolAllowed: input.toolAllowed,
      persistent: rules.find((rule) => rule.scope === "standing")?.decision ?? null,
      temporary: rules.find((rule) => rule.scope === "session")?.decision ?? null,
      riskAtOrBelowThreshold: RISK_RANK[input.risk] <= RISK_RANK[input.riskThreshold ?? "low_risk_write"],
    });
    if (decision === "deny") return "deny";
    return input.category ? "approval_required" : decision;
  }

  private async finishPending(userId: number, sdkRequestId: string, status: "expired" | "cancelled"): Promise<void> {
    await this.scoped(userId, async () => {
      await this.db.query(
        `UPDATE tool_approvals SET status = $1, decision = $2, decided_at = now()
          WHERE user_id = $3 AND sdk_request_id = $4 AND status = 'pending'`,
        [status, "deny", userId, sdkRequestId],
      );
    });
  }

  private async waitForDecision(userId: number, sdkRequestId: string, signal?: AbortSignal): Promise<ApprovalDecision | null> {
    const key = `${userId}:${sdkRequestId}`;
    const deadline = Date.now() + Math.max(1, this.dependencies.waitTimeoutMs ?? 15 * 60_000);
    const pollMs = Math.max(1, this.dependencies.pollIntervalMs ?? 1_000);
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let localDecision: ApprovalDecision | null = null;
    const listener = (decision: ApprovalDecision) => { localDecision = decision; wake?.(); };
    const listeners = this.waiters.get(key) ?? new Set();
    listeners.add(listener);
    this.waiters.set(key, listeners);
    const abort = () => wake?.();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Register first and then recheck durable state: neither commit ordering can lose the wakeup.
      while (!signal?.aborted && Date.now() < deadline) {
        if (localDecision) return localDecision;
        const durable = await this.sdkDecision(userId, sdkRequestId);
        if (durable) return durable;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now())));
        });
        if (timer) clearTimeout(timer);
        timer = undefined;
        wake = undefined;
      }
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const current = this.waiters.get(key);
      current?.delete(listener);
      if (current?.size === 0) this.waiters.delete(key);
    }
  }

  canUseTool(input: { userId: number; chatId: number; turn: unknown; riskFor(toolName: string): ToolRisk;
    categoryFor?(toolName: string): MandatoryApprovalCategory | undefined; signal?: AbortSignal;
    conversationId?: string | null; sessionId?: string | null; actorAllowed?: boolean; toolAllowed?: boolean; riskThreshold?: ToolRisk }): CanUseToolCallback {
    return async (toolName, toolInput, context) => {
      if (!this.enabled) return { behavior: "allow", message: "Tool approvals disabled" };
      const requestId = context?.requestId;
      if (!requestId) return { behavior: "deny", message: "SDK approval request id is required", interrupt: false };
      const risk = input.riskFor(toolName);
      const policy = await this.evaluatePolicy({ userId: input.userId, toolName, risk,
        sessionId: input.sessionId ?? null, actorAllowed: input.actorAllowed ?? true,
        toolAllowed: input.toolAllowed ?? true, riskThreshold: input.riskThreshold,
        category: input.categoryFor?.(toolName) });
      if (policy === "deny") return { behavior: "deny", message: "Denied by tool approval policy", interrupt: false };
      if (policy === "allow") return { behavior: "allow", message: "Allowed by tool approval policy" };
      const action = describeApprovalAction(toolName, toolInput);
      const fingerprint = fingerprintApprovalArguments(toolInput);
      this.dependencies.logger?.info("Ход остановлен подтверждением инструмента", {
        tool: toolName,
        risk,
        conversationId: input.conversationId ?? null,
        argumentFingerprint: fingerprint,
      });
      await this.request({ userId: input.userId, conversationId: input.conversationId, sdkRequestId: requestId, toolName, risk,
        description: action.description, affectedData: action.affectedData, argumentFingerprint: fingerprint });
      await this.dependencies.lifecycle?.transition(input.turn, "approval_pending");
      await this.dependencies.outbox?.send({ method: "sendMessage", chatId: input.chatId, userId: input.userId,
        idempotencyKey: `tool-approval:${input.userId}:${requestId}`, priority: "command",
        payload: { chat_id: input.chatId, text: `Ева просит подтвердить: ${action.description}. Данные: ${JSON.stringify(action.affectedData)}. Откройте Mini App, чтобы разрешить или отклонить.` } });
      const decision = await this.waitForDecision(input.userId, requestId, input.signal);
      await this.dependencies.lifecycle?.transition(input.turn, "tools_pending");
      if (!decision) {
        await this.finishPending(input.userId, requestId, input.signal?.aborted ? "cancelled" : "expired");
        return { behavior: "deny", message: "Approval expired or was cancelled", interrupt: false };
      }
      return decision === "allow"
        ? { behavior: "allow", message: "Approved by user" }
        : { behavior: "deny", message: "Denied by user", interrupt: false };
    };
  }
}
