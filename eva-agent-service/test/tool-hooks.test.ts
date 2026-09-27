/**
 * Хуки инструментов: видят только метаданные, не ломают вызов своими
 * отказами, запрещают только явно — и стоят в цепочке после журнала
 * эффектов и перед выполнением.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolHookChain } from "../dist/tools/tool-hooks.js";
import { ToolExecutor } from "../dist/tools/tool-executor.js";
import { ToolLatencyTracker, auditHook, metricsHook, quotaHook, tracingHook } from "../dist/tools/standard-hooks.js";
import { resetToolMetrics, toolMetrics } from "../dist/tools/tool-metrics.js";
import { runInTurn } from "../dist/turns/turn-context.js";

const warnings: Array<Record<string, unknown>> = [];
const logger = { debug() {}, info() {}, warn(_message: string, fields?: Record<string, unknown>) { warnings.push(fields ?? {}); }, error() {} };

const RUNTIME = {
  userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-1", purpose: "chat",
  timezone: "UTC", responseMode: "text", useEmoji: false,
};

function info(overrides: Record<string, unknown> = {}) {
  return {
    name: "browser_open", source: "browser", group: "browser", risk: "read", userId: 7, conversationId: "conv-1",
    purpose: "chat", toolCallId: "call-1", runId: "run-1", path: "bridge", startedAt: 0, ...overrides,
  } as never;
}

test("исключение хука не мешает вызову, запрет — явный и виден всем хукам", async () => {
  const seen: string[] = [];
  const chain = new ToolHookChain([
    { name: "broken", beforeToolCall: () => { throw new Error("secret-detail"); }, afterToolCall: () => { throw new Error("x"); } },
    { name: "observer", onToolDenied: (_call, denied) => { seen.push(`denied-by:${denied.hook}`); } },
    { name: "quota", beforeToolCall: () => ({ deny: "лимит" }) },
    { name: "never", beforeToolCall: () => { seen.push("never"); return undefined; } },
  ], logger);
  assert.equal(await chain.before(info()), "лимит");
  assert.deepEqual(seen, ["denied-by:quota"]);
  await chain.after(info(), { durationMs: 1, refused: false });
  assert.ok(warnings.every((fields) => !JSON.stringify(fields).includes("secret-detail")), "в журнал — код, не текст");
  assert.deepEqual(chain.names, ["broken", "observer", "quota", "never"]);
});

function executor(hooks: ToolHookChain, journal: string[]) {
  return new ToolExecutor({
    db: { withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work() } as never,
    logger,
    effects: {
      begin: async () => { journal.push("effects.begin"); return { action: "execute", attempt: 1 }; },
      succeed: async () => { journal.push("effects.succeed"); },
      fail: async (_key: string, _user: number, code: string) => { journal.push(`effects.fail:${code}`); },
    } as never,
    context: async () => RUNTIME as never,
    riskFor: () => "read",
    hooks,
  } as never);
}

const TURN = { runId: "11111111-1111-1111-1111-111111111111", recorded: true, isCancelled: async () => false };

test("цепочка: журнал эффектов → хуки → выполнение; запрет хука не выполняет инструмент", async () => {
  const journal: string[] = [];
  const received: unknown[] = [];
  const chain = new ToolHookChain([{
    name: "probe",
    beforeToolCall: (call) => { journal.push("hook.before"); received.push(call); return undefined; },
    afterToolCall: (_call, outcome) => { journal.push(`hook.after:${outcome.refused}`); },
  }], logger);
  const tool = { name: "get_notes", source: "product", group: "product", execute: async () => { journal.push("execute"); return { ok: false, error: "нет" }; } };
  await runInTurn(TURN, async () => await executor(chain, journal).run({ conversationId: "conv-1", tool: tool as never, rawArgs: { secret_text: "личное" }, toolCallId: "call-1" }));
  assert.deepEqual(journal, ["effects.begin", "hook.before", "execute", "effects.succeed", "hook.after:true"]);
  // Хук не получает аргументов: только метаданные.
  assert.deepEqual(Object.keys(received[0] as object).sort(), [
    "conversationId", "group", "name", "path", "purpose", "risk", "runId", "source", "startedAt", "toolCallId", "userId",
  ]);
  assert.doesNotMatch(JSON.stringify(received), /личное/);

  const denied: string[] = [];
  const blocking = new ToolHookChain([{ name: "quota", beforeToolCall: () => ({ deny: "квота" }) }], logger);
  const result = await runInTurn(TURN, async () => await executor(blocking, denied).run({ conversationId: "conv-1", tool: tool as never, rawArgs: {}, toolCallId: "call-2" }));
  assert.deepEqual(denied, ["effects.begin", "effects.fail:hook_denied"]);
  assert.deepEqual(result.details, { ok: false, error: "квота" });
});

test("аудит пишет мост и делегирование своим ключом, прямой вызов — нет", async () => {
  const rows: unknown[] = [];
  const hook = auditHook({ recordAgentToolCalls: async (...args: unknown[]) => { rows.push(args); } } as never);
  await hook.afterToolCall!(info({ path: "direct" }), { durationMs: 1, refused: false });
  await hook.afterToolCall!(info({ path: "bridge", name: "mcp__crm__find" }), { durationMs: 1, refused: false });
  await hook.onToolError!(info({ path: "delegation", name: "web_read", conversationId: "delegation:r1" }), { durationMs: 1, code: "TypeError" });
  assert.deepEqual(rows, [
    [7, "conv-1", [{ toolName: "mcp__crm__find", skillName: null, toolCallId: "call-1#bridge:mcp__crm__find", runId: null, succeeded: true }]],
    [7, "delegation:r1", [{ toolName: "web_read", skillName: null, toolCallId: "call-1#delegation:web_read", runId: null, succeeded: false }]],
  ]);
});

test("квота: предел вызовов через мост за ход и браузера в минуту; прямые вызовы не считаются", async () => {
  let clock = 0;
  const quota = quotaHook({ perTurn: 3, browserPerMinute: 2, now: () => clock });
  for (let index = 0; index < 5; index += 1) assert.equal(quota.beforeToolCall!(info({ path: "direct", source: "product", name: "get_notes" })), undefined);
  const bridged = () => quota.beforeToolCall!(info({ source: "mcp", name: "mcp__x__y", runId: "run-a" })) as { deny: string } | undefined;
  assert.equal(bridged(), undefined);
  assert.equal(bridged(), undefined);
  assert.equal(bridged(), undefined);
  assert.match(bridged()!.deny, /Предел вызовов/);
  assert.equal(quota.beforeToolCall!(info({ source: "mcp", name: "mcp__x__y", runId: "run-b" })), undefined, "другой ход — свой счёт");

  const browse = () => quota.beforeToolCall!(info({ path: "direct", source: "browser", runId: `run-${clock}` })) as { deny: string } | undefined;
  assert.equal(browse(), undefined);
  assert.equal(browse(), undefined);
  assert.match(browse()!.deny, /Браузер занят/);
  clock += 61_000;
  assert.equal(browse(), undefined, "минута прошла");
});

test("метрики и задержка считают исходы; трасса работает без провайдера", async () => {
  resetToolMetrics();
  const metrics = metricsHook();
  metrics.afterToolCall!(info(), { durationMs: 12, refused: false });
  metrics.afterToolCall!(info({ source: "mcp", path: "bridge" }), { durationMs: 30, refused: true });
  metrics.onToolError!(info({ source: "product", path: "direct" }), { durationMs: 5, code: "Error" });
  metrics.onToolDenied!(info({ source: "mcp", path: "bridge" }), { hook: "quota" });
  const calls = toolMetrics().calls.map((item) => `${item.source}/${item.path}/${item.outcome}=${item.value}`).sort();
  assert.deepEqual(calls, ["browser/bridge/ok=1", "mcp/bridge/denied=1", "mcp/bridge/refused=1", "product/direct/error=1"]);

  const latency = new ToolLatencyTracker({ window: 10 });
  const hook = latency.hook();
  for (const ms of [10, 20, 30, 40, 100]) hook.afterToolCall!(info(), { durationMs: ms, refused: false });
  hook.onToolError!(info(), { durationMs: 50, code: "Error" });
  const [row] = latency.snapshot();
  assert.deepEqual(row, { name: "browser_open", source: "browser", calls: 6, errors: 1, p50Ms: 40, p95Ms: 100, maxMs: 100 });

  const tracing = tracingHook();
  const call = info();
  tracing.beforeToolCall!(call);
  tracing.afterToolCall!(call, { durationMs: 1, refused: false });
});

test("отказ хука закрывает согласие как несостоявшееся, делегированию — свой предел", async () => {
  const completions: string[] = [];
  const executor = new ToolExecutor({
    db: { withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work() } as never,
    logger,
    context: async () => RUNTIME as never,
    riskFor: () => "read",
    approvalCompletion: () => async (input: { outcome: string }) => { completions.push(input.outcome); },
    hooks: new ToolHookChain([{ name: "quota", beforeToolCall: () => ({ deny: "квота" }) }], logger),
  } as never);
  let executed = false;
  const tool = { name: "get_notes", source: "product", group: "product", execute: async () => { executed = true; return {}; } };
  await executor.run({ conversationId: "conv-1", tool: tool as never, rawArgs: {}, toolCallId: "call-1" });
  assert.equal(executed, false);
  assert.deepEqual(completions, ["failed"]);

  const quota = quotaHook({ perTurn: 2, browserPerMinute: 100 });
  const delegated = () => quota.beforeToolCall!(info({ path: "delegation", source: "product", name: "web_read", runId: null, conversationId: "delegation:r1" }));
  for (let index = 0; index < 8; index += 1) assert.equal(delegated(), undefined, `вызов ${index + 1}`);
  assert.match((delegated() as { deny: string }).deny, /Предел/);
});

test("согласие: отмена и прежний отказ — failed, идущий повтор не забирает согласие себе", async () => {
  const scenario = async (decision: Record<string, unknown>, cancelled = false) => {
    const completions: string[] = [];
    let executed = false;
    const executor = new ToolExecutor({
      db: { withUserScope: async (_scope: unknown, work: () => Promise<unknown>) => await work() } as never,
      logger,
      effects: { begin: async () => decision, succeed: async () => {}, fail: async () => {} } as never,
      context: async () => RUNTIME as never,
      riskFor: () => "read",
      approvalCompletion: () => async (input: { outcome: string }) => { completions.push(input.outcome); },
    } as never);
    const tool = { name: "get_notes", source: "product", group: "product", execute: async () => { executed = true; return {}; } };
    await runInTurn({ ...TURN, isCancelled: async () => cancelled } as never, async () =>
      await executor.run({ conversationId: "conv-1", tool: tool as never, rawArgs: {}, toolCallId: "call-1" }));
    return { completions, executed };
  };
  assert.deepEqual(await scenario({ action: "execute", attempt: 1 }), { completions: ["executed"], executed: true });
  assert.deepEqual(await scenario({ action: "execute", attempt: 1 }, true), { completions: ["failed"], executed: false });
  assert.deepEqual(await scenario({ action: "skip", reason: "not_retryable", errorCode: "x" }), { completions: ["failed"], executed: false });
  // Исход запишет вызов, который действительно идёт.
  assert.deepEqual(await scenario({ action: "skip", reason: "in_flight", errorCode: null }), { completions: [], executed: false });
  // Повтор из журнала — действие уже состоялось.
  assert.deepEqual(await scenario({ action: "replay", result: { ok: true } }), { completions: ["executed"], executed: false });
});
