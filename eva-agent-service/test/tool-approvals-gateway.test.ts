import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile } from "node:fs/promises";

import { ApprovalService, approvalDecision, approvalRequiredFor, fingerprintApprovalArguments } from "../dist/tools/approvals.js";
import { runInScope, userScope } from "../dist/tenancy/index.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

class ApprovalDb {
  rows = new Map<string, Record<string, unknown>>();
  rules: Record<string, unknown>[] = [];
  scopes: unknown[] = [];
  /** Часы базы: тест сдвигает их, а не спит настоящие минуты. */
  now: () => number = () => Date.now();
  withUserScope<T>(scope: unknown, work: () => Promise<T>) { this.scopes.push(scope); return work(); }
  withSystemScope<T>(label: string, work: () => Promise<T>) { this.scopes.push({ system: label }); return work(); }
  async query<T>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes("FROM tool_approval_rules")) {
      const [userId, toolName, sessionId] = values;
      const rows = this.rules.filter((row) => row.user_id === userId && row.tool_name === toolName
        && row.revoked_at === null && (row.expires_at === null || Number(row.expires_at) > Date.now())
        && (row.scope === "standing" || row.session_id === sessionId));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO tool_approvals")) {
      const key = `${values[0]}:${values[2]}`;
      if (!this.rows.has(key)) this.rows.set(key, { user_id: values[0], conversation_id: values[1], sdk_request_id: values[2], tool_name: values[3], risk: values[4], argument_fingerprint: values[5], status: "pending", decision: null, action_description: values[6], affected_data: values[7], created_at: this.rows.size, created_at_ms: this.now(), decided_at_ms: null });
      return { rows: [this.rows.get(key) as T], rowCount: 1 };
    }
    // Примирение: разовое разрешение и незакрытое ожидание не живут
    // дольше срока. Порядок веток важен — запрос тоже начинается с
    // `UPDATE tool_approvals`, и ветка решения забрала бы его себе.
    if (sql.includes("UPDATE tool_approvals") && sql.includes("'expired'")) {
      const staleBefore = this.now() - Number(values[0]) * 1000;
      let affected = 0;
      for (const row of this.rows.values()) {
        if (!["pending", "approved_once", "approved_session"].includes(String(row.status))) continue;
        if (Number(row.decided_at_ms ?? row.created_at_ms) >= staleBefore) continue;
        Object.assign(row, { status: "expired", decision: "deny", decided_at_ms: row.decided_at_ms ?? this.now() });
        affected += 1;
      }
      return { rows: [], rowCount: affected };
    }
    if (sql.includes("WHERE status IN") && sql.includes("conversation_id")) {
      const freshAfter = this.now() - Number(values[0]) * 1000;
      const rows = [...this.rows.values()].filter((row) => ["pending", "approved_once", "approved_session", "denied"].includes(String(row.status))
        && row.conversation_id
        && Number(row.decided_at_ms ?? row.created_at_ms) >= freshAfter);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("WITH matching_approval")) {
      const [outcome, userId, conversationId, toolName, fingerprint] = values;
      const row = [...this.rows.values()]
        .filter((candidate) => candidate.user_id === userId && candidate.conversation_id === conversationId
          && candidate.tool_name === toolName && candidate.argument_fingerprint === fingerprint
          && ["approved_once", "approved_session"].includes(String(candidate.status)))
        .sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.sdk_request_id).localeCompare(String(b.sdk_request_id)))[0];
      if (!row) return { rows: [], rowCount: 0 };
      row.status = outcome; return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE tool_approvals")) {
      const key = `${values[2]}:${values[3]}`;
      const row = this.rows.get(key);
      if (!row || row.status !== "pending") return { rows: [], rowCount: 0 };
      Object.assign(row, { status: values[0], decision: values[1], decided_at_ms: this.now() });
      return { rows: [row as T], rowCount: 1 };
    }
    const row = this.rows.get(`${values[0]}:${values[1]}`);
    return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
  }
}

test("persistent policy is tenant isolated, exact-tool, deny-first and ignores expired rules", async () => {
  const db = new ApprovalDb();
  db.rules.push(
    { id: 1, user_id: 7, tool_name: "delete_tasks", decision: "allow", scope: "standing", max_risk: "destructive", session_id: null, expires_at: null, revoked_at: null },
    { id: 2, user_id: 7, tool_name: "delete_tasks", decision: "deny", scope: "session", max_risk: "destructive", session_id: "s-1", expires_at: null, revoked_at: null },
    { id: 3, user_id: 8, tool_name: "delete_tasks", decision: "deny", scope: "standing", max_risk: "destructive", session_id: null, expires_at: null, revoked_at: null },
    { id: 4, user_id: 7, tool_name: "other", decision: "deny", scope: "standing", max_risk: "destructive", session_id: null, expires_at: null, revoked_at: null },
    { id: 5, user_id: 7, tool_name: "delete_tasks", decision: "deny", scope: "standing", max_risk: "destructive", session_id: null, expires_at: Date.now() - 1, revoked_at: null },
  );
  const service = new ApprovalService(db as never, true);
  assert.equal(await service.evaluatePolicy({ userId: 7, toolName: "delete_tasks", risk: "destructive", sessionId: "s-1", actorAllowed: true, toolAllowed: true }), "deny");
  assert.equal(await service.evaluatePolicy({ userId: 7, toolName: "delete_tasks", risk: "destructive", sessionId: "s-2", actorAllowed: true, toolAllowed: true }), "allow");
  assert.equal(await service.evaluatePolicy({ userId: 9, toolName: "delete_tasks", risk: "destructive", sessionId: "s-1", actorAllowed: true, toolAllowed: true }), "approval_required");
});

test("ограничения актора и инструмента идут раньше грантов, max_risk правила соблюдается", async () => {
  const db = new ApprovalDb();
  db.rules.push({ id: 1, user_id: 7, tool_name: "save_task", decision: "allow", scope: "standing", max_risk: "low_risk_write", session_id: null, expires_at: null, revoked_at: null });
  const service = new ApprovalService(db as never, true);
  const base = { userId: 7, toolName: "save_task", risk: "sensitive_write" as const, sessionId: null };
  assert.equal(await service.evaluatePolicy({ ...base, actorAllowed: false, toolAllowed: true }), "deny");
  assert.equal(await service.evaluatePolicy({ ...base, actorAllowed: true, toolAllowed: false }), "deny");
  assert.equal(await service.evaluatePolicy({ ...base, actorAllowed: true, toolAllowed: true }), "approval_required");
});

test("dangerous approval is durable by tenant and SDK request id across restart", async () => {
  const db = new ApprovalDb();
  const first = new ApprovalService(db as never, true);
  await first.request({ userId: 7, sdkRequestId: "sdk-1", toolName: "delete_tasks", risk: "destructive", description: "Delete selected tasks" });
  const restarted = new ApprovalService(db as never, true);
  await restarted.decide({ userId: 7, sdkRequestId: "sdk-1", status: "approved_once", actorDecision: "allow" });
  assert.equal((await restarted.lookup(7, "sdk-1"))?.status, "approved_once");
  assert.equal(await restarted.sdkDecision(7, "sdk-1"), "allow");
  assert.equal(await restarted.lookup(8, "sdk-1"), null);
});

test("decision priority is deny, actor restriction, tool policy, persistent, temporary, risk threshold", () => {
  assert.equal(approvalDecision({ explicitDeny: true, actorAllowed: true, toolAllowed: true, persistent: "allow", temporary: "allow", riskAtOrBelowThreshold: true }), "deny");
  assert.equal(approvalDecision({ explicitDeny: false, actorAllowed: false, toolAllowed: true, persistent: "allow", temporary: "allow", riskAtOrBelowThreshold: true }), "deny");
  assert.equal(approvalDecision({ explicitDeny: false, actorAllowed: true, toolAllowed: false, persistent: "allow", temporary: "allow", riskAtOrBelowThreshold: true }), "deny");
  assert.equal(approvalDecision({ explicitDeny: false, actorAllowed: true, toolAllowed: true, persistent: "deny", temporary: "allow", riskAtOrBelowThreshold: true }), "deny");
  assert.equal(approvalDecision({ explicitDeny: false, actorAllowed: true, toolAllowed: true, persistent: null, temporary: "allow", riskAtOrBelowThreshold: false }), "allow");
  assert.equal(approvalDecision({ explicitDeny: false, actorAllowed: true, toolAllowed: true, persistent: null, temporary: null, riskAtOrBelowThreshold: true }), "allow");
});

test("mandatory approval categories and risks cannot be bypassed", () => {
  for (const category of ["data_deletion", "subscription_change", "third_party_transfer", "new_service", "bulk_task_change", "memory_export", "irreversible_admin"] as const) assert.equal(approvalRequiredFor("read", category), true);
  assert.equal(approvalRequiredFor("external_side_effect"), true);
  assert.equal(approvalRequiredFor("read"), false);
});


test("SDK canUseTool uses exact requestId, pauses turn, durable-prompts Telegram and resumes decision", async () => {
  const db = new ApprovalDb(); const sent: unknown[] = []; const states: string[] = [];
  const service = new ApprovalService(db as never, true, {
    outbox: { send: async (message: unknown) => { sent.push(message); return { queued: true }; } },
    lifecycle: { transition: async (_turn: unknown, state: string) => { states.push(state); return true; } },
  });
  const callback = service.canUseTool({ userId: 7, chatId: 77, turn: { runId: "run-1" } as never, riskFor: () => "destructive" });
  const pending = callback("delete_tasks", { private: "must-not-leak" }, { requestId: "sdk-exact" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await service.lookup(7, "sdk-exact"))?.status, "pending");
  assert.deepEqual(states, ["approval_pending"]);
  assert.equal(JSON.stringify(sent).includes("must-not-leak"), false);
  await service.decide({ userId: 7, sdkRequestId: "sdk-exact", status: "approved_once", actorDecision: "allow" });
  assert.deepEqual(await pending, { behavior: "allow", message: "Approved by user" });
  assert.deepEqual(states, ["approval_pending", "tools_pending"]);
});

test("approval prompt and durable affected data redact secrets and raw large text", async () => {
  const db = new ApprovalDb(); const sent: unknown[] = [];
  const service = new ApprovalService(db as never, true, { outbox: { send: async (message: unknown) => { sent.push(message); return { queued: true }; } }, pollIntervalMs: 2, waitTimeoutMs: 10 });
  await service.canUseTool({ userId: 7, chatId: 77, turn: {}, riskFor: () => "destructive" })(
    "delete_tasks", { taskIds: [12, 13], apiToken: "super-secret", note: "private ".repeat(1000) }, { requestId: "safe-prompt" });
  const durable = db.rows.get("7:safe-prompt")!; const serialized = JSON.stringify({ durable, sent });
  assert.match(String(durable.action_description), /delete_tasks/); assert.match(serialized, /taskIds/);
  assert.doesNotMatch(serialized, /super-secret|private private/); assert.match(serialized, /affected|Данные|Параметры/i);
});

test("execution matches approval without assuming SDK request id equals tool call id", async () => {
  const db = new ApprovalDb(); const service = new ApprovalService(db as never, true);
  const args = { taskIds: [12, 13], apiToken: "never-persist-this" };
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "sdk-request-not-tool-call", toolName: "delete_tasks", risk: "destructive", description: "safe", argumentFingerprint: fingerprintApprovalArguments(args) });
  await service.decide({ userId: 7, sdkRequestId: "sdk-request-not-tool-call", status: "approved_once", actorDecision: "allow" });
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "executed" }), true);
  assert.equal((await service.lookup(7, "sdk-request-not-tool-call"))?.status, "executed");
  assert.doesNotMatch(JSON.stringify(db.rows), /never-persist-this/);
});

test("argument digest uses full canonical values, key ordering and JSON type distinctions", () => {
  assert.equal(fingerprintApprovalArguments({ b: [true, null], a: "same" }), fingerprintApprovalArguments({ a: "same", b: [true, null] }));
  assert.notEqual(fingerprintApprovalArguments({ value: "alpha" }), fingerprintApprovalArguments({ value: "bravo" }));
  assert.notEqual(fingerprintApprovalArguments({ value: "1" }), fingerprintApprovalArguments({ value: 1 }));
  assert.notEqual(fingerprintApprovalArguments({ value: 1 }), fingerprintApprovalArguments({ value: true }));
  assert.notEqual(fingerprintApprovalArguments({ value: false }), fingerprintApprovalArguments({ value: null }));
});

test("equal-length and secret-value substitutions cannot consume another approval", async () => {
  const db = new ApprovalDb(); const service = new ApprovalService(db as never, true);
  const approved = { destination: "alpha", apiToken: "secret-one" };
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "exact-args", toolName: "transfer", risk: "external_side_effect", description: "safe", argumentFingerprint: fingerprintApprovalArguments(approved) });
  await service.decide({ userId: 7, sdkRequestId: "exact-args", status: "approved_once", actorDecision: "allow" });

  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "transfer", args: { ...approved, destination: "bravo" }, outcome: "executed" }), false);
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "transfer", args: { ...approved, apiToken: "secret-two" }, outcome: "executed" }), false);
  assert.equal((await service.lookup(7, "exact-args"))?.status, "approved_once");
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "transfer", args: approved, outcome: "executed" }), true);
  assert.doesNotMatch(JSON.stringify(db.rows), /alpha|secret-one|secret-two/);
});

test("concurrent identical executions claim distinct approvals oldest first and only once", async () => {
  const db = new ApprovalDb(); const service = new ApprovalService(db as never, true); const args = { taskIds: [12] };
  for (const requestId of ["sdk-a", "sdk-b"]) {
    await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: requestId, toolName: "delete_tasks", risk: "destructive", description: "safe", argumentFingerprint: fingerprintApprovalArguments(args) });
    await service.decide({ userId: 7, sdkRequestId: requestId, status: "approved_once", actorDecision: "allow" });
  }
  assert.deepEqual(await Promise.all([
    service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "executed" }),
    service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "failed" }),
  ]), [true, true]);
  assert.equal((await service.lookup(7, "sdk-a"))?.status, "executed");
  assert.equal((await service.lookup(7, "sdk-b"))?.status, "failed");
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "executed" }), false);
});

test("failed execution marks one approved match while denied and nonapproval rows remain untouched", async () => {
  const db = new ApprovalDb(); const service = new ApprovalService(db as never, true); const args = { taskIds: [12] };
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "ok", toolName: "delete_tasks", risk: "destructive", description: "safe", argumentFingerprint: fingerprintApprovalArguments(args) });
  await service.decide({ userId: 7, sdkRequestId: "ok", status: "approved_once", actorDecision: "allow" });
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "failed" }), true);
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "denied", toolName: "delete_tasks", risk: "destructive", description: "safe", argumentFingerprint: fingerprintApprovalArguments(args) });
  await service.decide({ userId: 7, sdkRequestId: "denied", status: "denied", actorDecision: "deny" });
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "executed" }), false);
  assert.equal((await service.lookup(7, "denied"))?.status, "denied");
});

test("SDK approval fails closed without context.requestId", async () => {
  const service = new ApprovalService(new ApprovalDb() as never, true);
  const callback = service.canUseTool({ userId: 7, chatId: 77, turn: {} as never, riskFor: () => "destructive" });
  assert.deepEqual(await callback("delete_tasks", {}, {}), { behavior: "deny", message: "SDK approval request id is required", interrupt: false });
});

test("a decision between waiter registration and recheck cannot be lost", async () => {
  const db = new ApprovalDb();
  const services: ApprovalService[] = [];
  let injected = false;
  const originalQuery = db.query.bind(db);
  db.query = async <T>(sql: string, values: unknown[] = []) => {
    if (!injected && sql.includes("SELECT user_id") && sql.includes("tool_approvals")) {
      injected = true;
      await services[0]!.decide({ userId: 7, sdkRequestId: "race-id", status: "approved_once", actorDecision: "allow" });
    }
    return await originalQuery<T>(sql, values);
  };
  const service = new ApprovalService(db as never, true, { pollIntervalMs: 5, waitTimeoutMs: 100 });
  services.push(service);
  const callback = service.canUseTool({ userId: 7, chatId: 77, turn: {}, riskFor: () => "destructive" });
  assert.deepEqual(await callback("delete_tasks", {}, { requestId: "race-id" }), { behavior: "allow", message: "Approved by user" });
});

test("startup recovery reacquires the exact conversation and consumes a decision after process death", async () => {
  const db = new ApprovalDb();
  const deadService = new ApprovalService(db as never, true);
  await deadService.request({ userId: 7, conversationId: "conversation-exact", sdkRequestId: "sdk-restart-exact", toolName: "delete_tasks", risk: "destructive", description: "Delete" });
  await deadService.decide({ userId: 7, sdkRequestId: "sdk-restart-exact", status: "approved_once", actorDecision: "allow" });

  // Nothing from the dead service (including its callback/promise) is retained.
  const restarted = new ApprovalService(db as never, true, { pollIntervalMs: 5, waitTimeoutMs: 50 });
  const recovered: unknown[] = [];
  await restarted.recoverPendingApprovals(async (conversationId) => {
    assert.equal(conversationId, "conversation-exact");
    const callback = restarted.canUseTool({ userId: 7, chatId: 77, conversationId, turn: {}, riskFor: () => "destructive" });
    recovered.push(await callback("delete_tasks", {}, { requestId: "sdk-restart-exact" }));
  });
  assert.deepEqual(recovered, [{ behavior: "allow", message: "Approved by user" }]);
  assert.ok(db.scopes.some((scope) => (scope as { system?: string }).system === "tool.approvals.recovery"));
  assert.ok(db.scopes.some((scope) => (scope as { userId?: number }).userId === 7));
});

test("migration and rollback persist approval conversation plus nullable canonical selectors", async (context) => {
  const upPath = "../postgres/migrations/041_tool_gateway.sql";
  const downPath = "../postgres/migrations/down/041_tool_gateway.sql";
  try {
    await Promise.all([access(upPath), access(downPath)]);
  } catch {
    context.skip("service-only image excludes repository-level migration sources; PostgreSQL CI verifies up/down");
    return;
  }
  const up = await readFile(upPath, "utf8");
  assert.match(up, /conversation_id text REFERENCES agent_conversations\(conversation_id\)/);
  assert.match(up, /argument_fingerprint text NOT NULL/);
  assert.match(up, /idx_tool_approvals_execution_match/);
});

test("approval waiting is bounded and cancellation denies without an infinite promise", async () => {
  const db = new ApprovalDb();
  const timed = new ApprovalService(db as never, true, { pollIntervalMs: 2, waitTimeoutMs: 10 });
  const timedCallback = timed.canUseTool({ userId: 7, chatId: 77, turn: {}, riskFor: () => "destructive" });
  assert.deepEqual(await timedCallback("delete_tasks", {}, { requestId: "expires" }), { behavior: "deny", message: "Approval expired or was cancelled", interrupt: false });
  assert.equal((await timed.lookup(7, "expires"))?.status, "expired");

  const controller = new AbortController();
  const cancelled = new ApprovalService(db as never, true, { pollIntervalMs: 50, waitTimeoutMs: 500 });
  const cancelledCallback = cancelled.canUseTool({ userId: 7, chatId: 77, turn: {}, riskFor: () => "destructive", signal: controller.signal });
  const pending = cancelledCallback("delete_tasks", {}, { requestId: "cancelled" });
  controller.abort();
  assert.deepEqual(await pending, { behavior: "deny", message: "Approval expired or was cancelled", interrupt: false });
  assert.equal((await cancelled.lookup(7, "cancelled"))?.status, "cancelled");
});

test("обязательная категория операции требует подтверждения даже при риске read", async () => {
  const db = new ApprovalDb();
  const service = new ApprovalService(db as never, true, { pollIntervalMs: 2, waitTimeoutMs: 10 });
  const callback = service.canUseTool({ userId: 7, chatId: 77, turn: {}, riskFor: () => "read", categoryFor: () => "memory_export" });
  assert.deepEqual(await callback("export_memory", {}, { requestId: "mandatory-category" }), { behavior: "deny", message: "Approval expired or was cancelled", interrupt: false });
  assert.equal((await service.lookup(7, "mandatory-category"))?.status, "expired");
});

test("выключенная подсистема подтверждений разрешает вызов", async () => {
  const service = new ApprovalService(new ApprovalDb() as never, false);
  const callback = service.canUseTool({ userId: 7, chatId: 77, turn: {}, riskFor: () => "destructive", categoryFor: () => "data_deletion" });
  assert.deepEqual(await callback("delete_tasks", {}, { requestId: "gateway-only" }), { behavior: "allow", message: "Tool approvals disabled" });
});

test("каждый запрос подтверждений проходит границу арендатора внутри хода пользователя", async () => {
  // Поддельная база тестов границу не применяет, поэтому запрос,
  // ограниченный только через CTE, выглядел здесь исправным и отказывал
  // уже в production — после каждого вызова инструмента.
  const db = new ApprovalDb();
  const service = new ApprovalService(withTenantScopes(db as never) as never, true, { pollIntervalMs: 2, waitTimeoutMs: 10 });
  const args = { taskIds: [12] };
  await runInScope(userScope({ userId: 7, telegramId: 100_007, label: "telegram.turn" }), async () => {
    assert.equal(await service.evaluatePolicy({ userId: 7, toolName: "get_notes", risk: "read", sessionId: null, actorAllowed: true, toolAllowed: true }), "allow");
    await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "sdk-scoped", toolName: "delete_tasks", risk: "destructive", description: "safe", argumentFingerprint: fingerprintApprovalArguments(args) });
    await service.decide({ userId: 7, sdkRequestId: "sdk-scoped", status: "approved_once", actorDecision: "allow" });
    assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args, outcome: "executed" }), true);
    assert.equal((await service.lookup(7, "sdk-scoped"))?.status, "executed");
  });
});

test("завершение чужого подтверждения не проходит границу арендатора", async () => {
  const db = new ApprovalDb();
  const service = new ApprovalService(withTenantScopes(db as never) as never, true);
  await runInScope(userScope({ userId: 7, telegramId: 100_007, label: "telegram.turn" }), async () => {
    await assert.rejects(
      service.completeApprovedExecution({ userId: 8, conversationId: "conversation-1", toolName: "delete_tasks", args: {}, outcome: "executed" }),
      /не совпадает с пользователем области|не может быть переназначена/,
    );
  });
});

test("выключенная подсистема не обращается к подтверждениям после вызова инструмента", async () => {
  const db = new ApprovalDb();
  const statements: string[] = [];
  const original = db.query.bind(db);
  db.query = async <T>(sql: string, values: unknown[] = []) => { statements.push(sql); return await original<T>(sql, values); };
  const service = new ApprovalService(db as never, false);
  assert.equal(await service.completeApprovedExecution({ userId: 7, conversationId: "conversation-1", toolName: "delete_tasks", args: {}, outcome: "executed" }), false);
  assert.deepEqual(statements, []);
});

test("незакрытое подтверждение не открывает conversation вечно и не остаётся выданным", async () => {
  // Закрытие подтверждения идёт после самого действия и может отказать
  // (или не состояться вовсе, если процесс умер). Без примирения строка
  // остаётся `approved_once` навсегда: восстановление открывает её
  // conversation при каждом старте, а разовое «да» висит выданным.
  const db = new ApprovalDb();
  const service = new ApprovalService(db as never, true, { waitTimeoutMs: 15 * 60_000 });
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "stranded", toolName: "delete_tasks", risk: "destructive", description: "safe" });
  await service.decide({ userId: 7, sdkRequestId: "stranded", status: "approved_once", actorDecision: "allow" });
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "unanswered", toolName: "delete_tasks", risk: "destructive", description: "safe" });

  const base = Date.now();
  db.now = () => base + 61 * 60_000;
  const reopened: string[] = [];
  assert.equal(await service.recoverPendingApprovals(async (id) => { reopened.push(id); }), 0);

  assert.deepEqual(reopened, []);
  assert.equal((await service.lookup(7, "stranded"))?.status, "expired");
  assert.equal((await service.lookup(7, "stranded"))?.decision, "deny");
  assert.equal((await service.lookup(7, "unanswered"))?.status, "expired");
});

test("свежее решение восстановление по-прежнему доигрывает", async () => {
  const db = new ApprovalDb();
  const service = new ApprovalService(db as never, true);
  await service.request({ userId: 7, conversationId: "conversation-live", sdkRequestId: "fresh", toolName: "delete_tasks", risk: "destructive", description: "safe" });
  await service.decide({ userId: 7, sdkRequestId: "fresh", status: "approved_once", actorDecision: "allow" });

  const reopened: string[] = [];
  assert.equal(await service.recoverPendingApprovals(async (id) => { reopened.push(id); }), 1);
  assert.deepEqual(reopened, ["conversation-live"]);
  assert.equal((await service.lookup(7, "fresh"))?.status, "approved_once");
  assert.equal(await service.sdkDecision(7, "fresh"), "allow");
});

test("отказ человека примирение не переписывает", async () => {
  const db = new ApprovalDb();
  const service = new ApprovalService(db as never, true);
  await service.request({ userId: 7, conversationId: "conversation-1", sdkRequestId: "refused", toolName: "delete_tasks", risk: "destructive", description: "safe" });
  await service.decide({ userId: 7, sdkRequestId: "refused", status: "denied", actorDecision: "deny" });

  const base = Date.now();
  db.now = () => base + 61 * 60_000;
  assert.equal(await service.reconcileStaleApprovals(), 0);
  assert.equal((await service.lookup(7, "refused"))?.status, "denied");
});

test("выключенная подсистема ничего не примиряет", async () => {
  const db = new ApprovalDb();
  const statements: string[] = [];
  const original = db.query.bind(db);
  db.query = async <T>(sql: string, values: unknown[] = []) => { statements.push(sql); return await original<T>(sql, values); };
  assert.equal(await new ApprovalService(db as never, false).reconcileStaleApprovals(), 0);
  assert.deepEqual(statements, []);
});

test("остановка хода подтверждением попадает в журнал — без аргументов инструмента", async () => {
  // Ход, остановленный подтверждением, выглядит для человека как молчание
  // Евы. Пока имя инструмента не попадало в журнал, у оператора не было
  // ни одной зацепки: ровно так пришлось искать вслепую причину зависшего
  // хода после обновления Agent SDK.
  const db = new ApprovalDb();
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const service = new ApprovalService(db as never, true, {
    outbox: { send: async () => ({ queued: true }) },
    logger: { info: (message, meta) => entries.push({ message, meta }) },
    pollIntervalMs: 2,
    waitTimeoutMs: 10,
  });

  await service.canUseTool({
    userId: 7, chatId: 77, turn: {}, conversationId: "conversation-1",
    riskFor: () => "destructive",
  })("delete_tasks", { taskIds: [12, 13], note: "личное сообщение человека" }, { requestId: "traced" });

  const record = entries.find((entry) => entry.message.includes("подтверждением"));
  assert.ok(record, "остановка хода не записана в журнал");
  assert.equal(record.meta?.tool, "delete_tasks");
  assert.equal(record.meta?.risk, "destructive");
  assert.equal(record.meta?.conversationId, "conversation-1");
  // Отпечаток — да, содержимое — никогда: аргументы несут текст человека.
  assert.equal(typeof record.meta?.argumentFingerprint, "string");
  assert.doesNotMatch(JSON.stringify(entries), /личное сообщение|taskIds/);
});

test("разрешённый инструмент журнал не засоряет", async () => {
  const db = new ApprovalDb();
  const entries: string[] = [];
  const service = new ApprovalService(db as never, true, {
    logger: { info: (message) => entries.push(message) },
  });
  await service.canUseTool({
    userId: 7, chatId: 77, turn: {}, riskFor: () => "read",
  })("get_notes", {}, { requestId: "allowed" });
  assert.deepEqual(entries, []);
});
