/**
 * Субагенты Letta: узкий рабочий агент, только чтение, пределы и уборка.
 * Исследование субагентами: цитата принимается, только если Evaself сам
 * получил этот текст для субагента.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { LettaSubagentRunner, SUBAGENT_TAG } from "../dist/letta/subagents.js";
import { DELEGATION_TOOLS, DelegatedResearch, DelegationError, extractJson } from "../dist/research/delegation.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

type Created = { options: Record<string, unknown>; sessionOptions?: Record<string, unknown> };

function fakeClient(behaviour: {
  answer?: (brief: string) => string;
  hang?: boolean;
  onCanUse?: (callback: (name: string, input: Record<string, unknown>, context: unknown) => Promise<unknown>) => Promise<void>;
  deleteFails?: boolean;
} = {}) {
  const created: Created[] = [];
  const deleted: string[] = [];
  let concurrent = 0;
  let peak = 0;
  const client = {
    createAgent: async (options: Record<string, unknown>) => { created.push({ options }); return `agent-${created.length}`; },
    createSession: (agentId: string, options: Record<string, unknown>) => {
      created[Number(agentId.split("-")[1]) - 1]!.sessionOptions = options;
      let brief = "";
      return {
        send: async (message: string) => { brief = message; concurrent += 1; peak = Math.max(peak, concurrent); },
        stream: async function* () {
          try {
            if (behaviour.onCanUse) await behaviour.onCanUse(options.canUseTool as never);
            if (behaviour.hang) await new Promise(() => {});
            yield { type: "assistant", content: behaviour.answer?.(brief) ?? "{}", uuid: "m1" };
            yield { type: "result", success: true, durationMs: 1, conversationId: null };
          } finally {
            concurrent -= 1;
          }
        },
        abort: async () => {},
        close: () => {},
      };
    },
    deleteAgent: async (agentId: string) => { if (behaviour.deleteFails) throw new Error("boom"); deleted.push(agentId); },
    listAgents: async () => [{ id: "agent-orphan-1" }, { id: "agent-orphan-2" }],
    defaultModel: () => "evaself/eva",
  };
  return { client, created, deleted, peak: () => peak };
}

test("рабочий агент скрыт, без памяти, навыков и серверных инструментов; набор точный", async () => {
  const fake = fakeClient({ answer: () => '{"sources": []}' });
  const runner = new LettaSubagentRunner({ client: () => fake.client as never, maxParallel: 2, timeoutMs: 5_000, logger });
  const tool = { name: "web_search", label: "", description: "", parameters: {}, execute: async () => ({}) };
  const outcome = await runner.run({ role: "research", brief: "Вопрос", tools: [tool as never] }, new AbortController().signal);
  assert.equal(outcome.ok, true);
  const { options, sessionOptions } = fake.created[0]!;
  assert.equal(options.hidden, true);
  assert.equal(options.memfs, false);
  assert.deepEqual(options.baseTools, []);
  assert.deepEqual(options.skillSources, []);
  assert.deepEqual(options.allowedTools, ["web_search"]);
  assert.ok((options.tags as string[]).includes(SUBAGENT_TAG));
  assert.equal(options.model, "evaself/eva");
  assert.equal(sessionOptions!.stateless, true);
  assert.deepEqual(sessionOptions!.allowedTools, ["web_search"]);
  assert.deepEqual(sessionOptions!.skillSources, []);
  assert.deepEqual(fake.deleted, ["agent-1"], "агент удалён после задания");
});

test("всё сверх набора отклоняется, включая оболочку и субагентов второго уровня", async () => {
  const verdicts: Record<string, unknown> = {};
  const fake = fakeClient({
    onCanUse: async (canUse) => {
      for (const name of ["web_search", "Bash", "Task", "Write", "save_note"]) verdicts[name] = await canUse(name, {}, {});
    },
  });
  const runner = new LettaSubagentRunner({ client: () => fake.client as never, maxParallel: 1, timeoutMs: 5_000, logger });
  await runner.run({ role: "research", brief: "b", tools: [{ name: "web_search" } as never] }, new AbortController().signal);
  assert.deepEqual(verdicts.web_search, { behavior: "allow" });
  for (const name of ["Bash", "Task", "Write", "save_note"]) assert.equal((verdicts[name] as { behavior: string }).behavior, "deny", name);
});

test("срок, отмена, предел параллельности и уборка даже при отказе", async () => {
  const slow = fakeClient({ hang: true });
  const runner = new LettaSubagentRunner({ client: () => slow.client as never, maxParallel: 1, timeoutMs: 50, logger });
  const timedOut = await runner.run({ role: "web", brief: "b", tools: [] }, new AbortController().signal);
  assert.equal(timedOut.error, "timeout");
  assert.deepEqual(slow.deleted, ["agent-1"]);

  const controller = new AbortController();
  const cancelling = new LettaSubagentRunner({ client: () => fakeClient({ hang: true }).client as never, maxParallel: 1, timeoutMs: 10_000, logger });
  const pending = cancelling.run({ role: "web", brief: "b", tools: [] }, controller.signal);
  const queued = cancelling.run({ role: "web", brief: "b", tools: [] }, controller.signal);
  controller.abort();
  assert.equal((await pending).error, "cancelled");
  assert.equal((await queued).error, "cancelled");

  const parallel = fakeClient({ answer: () => "{}" });
  const limited = new LettaSubagentRunner({ client: () => parallel.client as never, maxParallel: 2, timeoutMs: 5_000, logger });
  await Promise.all(Array.from({ length: 6 }, () => limited.run({ role: "web", brief: "b", tools: [] }, new AbortController().signal)));
  assert.ok(parallel.peak() <= 2, `одновременно ${parallel.peak()}`);
  assert.equal(parallel.deleted.length, 6);

  const leaky = fakeClient({ answer: () => "{}", deleteFails: true });
  const counting = new LettaSubagentRunner({ client: () => leaky.client as never, maxParallel: 1, timeoutMs: 5_000, logger });
  await counting.run({ role: "web", brief: "b", tools: [] }, new AbortController().signal);
  assert.equal(counting.stats.cleanupFailed, 1);
  const orphans = new LettaSubagentRunner({ client: () => parallel.client as never, maxParallel: 1, timeoutMs: 5_000, logger });
  assert.equal(await orphans.sweepOrphans(), 2);
});

test("рабочему агенту достаётся только чтение, от имени заказчика и мимо политики назначения", async () => {
  const runtime = {
    userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-research", purpose: "research",
    timezone: "UTC", responseMode: "text", useEmoji: false,
  };
  const db = withTenantScopes({
    getAgentRuntimeContext: async () => { throw new Error("рабочему агенту поиск владельца не нужен"); },
    getQuotaStatus: async () => [{ metric: "web_search", remaining: 5 }],
    incrementUsage: async () => 1,
    query: async () => ({ rows: [], rowCount: 0 }),
  } as never);
  const factory = new AgentToolFactory({ vectorGoalsEnabled: false, crawl4aiUrl: "http://crawl.invalid" } as never, db as never, {} as never, logger);
  const tools = factory.forDelegation({ conversationId: "delegation:req-1", runtime: runtime as never, toolNames: ["web_read", "knowledge_search", "save_note", "delete_tasks"] });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["knowledge_search", "web_read"]);
  for (const names of Object.values(DELEGATION_TOOLS)) {
    for (const tool of factory.forDelegation({ conversationId: "d", runtime: runtime as never, toolNames: names })) {
      assert.ok(names.includes(tool.name));
    }
  }
  // web_read вне списка назначения research, но набор задания его разрешает.
  const read = tools.find((tool) => tool.name === "web_read")!;
  const result = await read.execute("call-1", { url: "http://10.0.0.1/" });
  assert.doesNotMatch(JSON.stringify(result.details), /недоступен в служебном conversation/);
});

const PAGE = "Пермь — город на Каме. Население Перми в 2024 году составило 1 034 002 человека по данным Росстата.";

function research(answers: Record<string, string>, calls: Array<{ role: string; tools: string[] }> = []) {
  return {
    run: async (task: { role: string; brief: string; tools: Array<{ name: string; execute: (id: string, args: unknown) => Promise<unknown> }> }) => {
      calls.push({ role: task.role, tools: task.tools.map((tool) => tool.name) });
      // Субагент «вызывает» инструменты: ответы попадают в книгу доказательств.
      for (const tool of task.tools) {
        if (tool.name === "web_read") {
          await tool.execute("c1", { url: "https://perm.example/city" });
          await tool.execute("c2", { url: "https://other.example/" });
        }
        if (tool.name === "knowledge_search") await tool.execute("c3", { query: "Пермь" });
      }
      const text = answers[task.role];
      return text === undefined
        ? { role: task.role, ok: false, text: "", durationMs: 1, error: "failed" }
        : { role: task.role, ok: true, text, durationMs: 1 };
    },
  };
}

function toolsFor(role: string) {
  const tool = (name: string, details: (args: Record<string, unknown>) => unknown) => ({
    name, label: name, description: "", parameters: {},
    execute: async (_id: string, args: Record<string, unknown>) => ({ content: [], details: details(args) }),
  });
  if (role === "web") {
    return [tool("web_read", (args) => (args.url === "https://perm.example/city"
      ? { ok: true, url: "https://perm.example/city", title: "Пермь", content: PAGE }
      : { ok: true, url: "https://other.example/", title: "Другое", content: "Совсем другой текст." }))];
  }
  if (role === "document") {
    return [tool("knowledge_search", () => ({ ok: true, results: [{ document: "Заметки.pdf", content: "В заметках: переезд в Пермь запланирован на май." }] }))];
  }
  return [tool("web_search", () => ({ ok: true }))];
}

const LIMITS = { maxSources: 6, maxPagesPerDomain: 2, maxWebAgents: 2, maxFactsPerAgent: 10 };

test("проверенная цитата принимается, выдуманная и с чужого адреса — нет", async () => {
  const calls: Array<{ role: string; tools: string[] }> = [];
  const runner = research({
    research: '```json\n{"sources": [{"url": "https://perm.example/city?utm_source=x"}, {"url": "https://perm.example/city"}]}\n```',
    web: JSON.stringify({ facts: [
      { url: "https://perm.example/city", claim: "Население Перми — около миллиона", evidence: "Население Перми в 2024 году составило 1 034 002 человека" },
      { url: "https://perm.example/city", claim: "Выдумка", evidence: "Пермь — столица России и крупнейший порт" },
      { url: "https://other.example/", claim: "Чужой адрес", evidence: "Совсем другой текст." },
    ] }),
    document: JSON.stringify({ facts: [
      { document: "Заметки.pdf", claim: "Переезд в мае", evidence: "переезд в Пермь запланирован на май" },
      { document: "Заметки.pdf", claim: "Выдумка", evidence: "переезд отменён навсегда и бесповоротно" },
    ] }),
    synthesis: "Население Перми — около миллиона (perm.example); переезд запланирован на май (Заметки.pdf).",
  }, calls);
  const report = await new DelegatedResearch({ runner: runner as never, tools: toolsFor as never, limits: LIMITS })
    .run({ userId: 7, conversationId: "conv-research", query: "Сколько людей живёт в Перми?", reportId: "11111111-1111-1111-1111-111111111111", signal: new AbortController().signal });
  assert.deepEqual(report.claims.map((claim) => claim.claim), ["Население Перми — около миллиона", "Переезд в мае"]);
  assert.equal(report.issues.unverified, 3);
  assert.equal(report.method, "delegated");
  assert.equal(report.memoryWritten, false);
  assert.match(report.summary, /около миллиона/);
  assert.deepEqual(report.sources.map((source) => source.domain).sort(), ["knowledge", "perm.example"]);
  const claim = report.claims[0]!;
  assert.equal(PAGE.slice(claim.evidenceStart, claim.evidenceEnd), claim.evidenceQuote);
  // Дубликат с меткой рассылки схлопнулся: одна страница — один web-субагент.
  assert.equal(calls.filter((call) => call.role === "web").length, 1);
  assert.deepEqual(calls.find((call) => call.role === "synthesis")?.tools, []);
});

test("без проверенных фактов — отказ, чтобы задание ушло в конвейер; сводка без субагента — из фактов", async () => {
  await assert.rejects(
    new DelegatedResearch({ runner: research({ research: '{"sources": []}' }) as never, tools: ((role: string) => (role === "document" ? [] : toolsFor(role))) as never, limits: LIMITS })
      .run({ userId: 7, conversationId: "c", query: "q", signal: new AbortController().signal }),
    (error: unknown) => error instanceof DelegationError && error.code === "delegation_no_sources",
  );
  const report = await new DelegatedResearch({
    runner: research({
      research: '{"sources": [{"url": "https://perm.example/city"}]}',
      web: JSON.stringify({ facts: [{ url: "https://perm.example/city", claim: "Пермь стоит на Каме", evidence: "Пермь — город на Каме." }] }),
    }) as never,
    tools: ((role: string) => (role === "document" ? [] : toolsFor(role))) as never,
    limits: LIMITS,
  }).run({ userId: 7, conversationId: "c", query: "q", signal: new AbortController().signal });
  assert.equal(report.summary, "Пермь стоит на Каме");
  assert.equal(extractJson("ответ: {\"a\": 1} конец")?.a, 1);
  assert.equal(extractJson("нет json"), null);
});

test("делегированию — свой бюджет: его срок уступает конвейеру, отмена задания — нет", async () => {
  const { withinBudget, researchJobTiming, RESEARCH_PIPELINE_RESERVE_MS } = await import("../dist/research/worker.js");
  const { timingFor } = await import("../dist/jobs/policy.js");
  const hang = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });

  // Истёк бюджет делегирования — null, а сигнал задания цел: конвейеру есть когда работать.
  const job = new AbortController();
  assert.equal(await withinBudget(job.signal, 20, hang), null);
  assert.equal(job.signal.aborted, false);
  // Делегирование ничего не нашло — тоже запасной путь.
  assert.equal(await withinBudget(job.signal, 1_000, async () => { throw new DelegationError("no_facts"); }), null);
  assert.equal(await withinBudget(job.signal, 1_000, async () => "отчёт"), "отчёт");
  // Отменённое задание не начинают сначала другим способом.
  const cancelled = new AbortController();
  const running = withinBudget(cancelled.signal, 60_000, hang);
  cancelled.abort(new Error("job_cancelled"));
  await assert.rejects(running, /job_cancelled/);

  // Срок задания: конвейер плюс три фазы субагентов, мягкий срок раньше жёсткого.
  const defaults = researchJobTiming(180_000);
  assert.equal(defaults.softTimeoutMs, RESEARCH_PIPELINE_RESERVE_MS + 420_000, "бюджет упирается в жёсткий дедлайн");
  assert.doesNotThrow(() => timingFor("research", defaults));
  assert.equal(researchJobTiming(20_000).softTimeoutMs, RESEARCH_PIPELINE_RESERVE_MS + 60_000);
});
