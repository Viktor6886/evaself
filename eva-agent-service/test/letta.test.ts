import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractText,
  isReasoningTierError,
  LettaService,
  summarizeStream,
  telegramTag,
} from "../dist/letta.js";

const SYSTEM_PROMPT = "repository system prompt";

test("extractText handles plain strings", () => {
  assert.equal(extractText("hello"), "hello");
});

test("extractText joins content parts", () => {
  assert.equal(
    extractText([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  );
});

test("extractText ignores non-text parts", () => {
  assert.equal(extractText([{ type: "image", source: {} }, { type: "text", text: "kept" }]), "kept");
});

test("extractText of null is empty", () => {
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
});

test("summarizeStream picks the assistant text and counts reasoning events", () => {
  const summary = summarizeStream([
    { type: "init", agentId: "agent-1", sessionId: "s", conversationId: "c" },
    { type: "reasoning", reasoning: "thinking" },
    { type: "tool_call", name: "memory_write" },
    { type: "assistant", content: "Привет!" },
    {
      type: "result",
      stopReason: "end_turn",
      usage: { total_tokens: 120 },
    },
  ] as never);

  assert.equal(summary.reply, "Привет!");
  // От рассуждения остаётся счётчик: сам текст не собирается нигде.
  assert.equal(summary.reasoningEvents, 1);
  assert.equal("reasoning" in summary, false);
  assert.deepEqual(summary.toolCalls, ["memory_write"]);
  assert.equal(summary.stopReason, "end_turn");
  assert.equal(summary.usage?.total_tokens, 120);
  assert.equal(summary.messageCount, 5);
  assert.deepEqual(summary.trace.map((entry) => entry.type), [
    "init",
    "reasoning",
    "tool_call",
    "assistant",
    "result",
  ]);
});

/**
 * Служебные события Letta человеку не показываются.
 *
 * Сжатие контекста, выжимка разговора, рефлексия и системные уведомления
 * — внутренняя работа runtime. Ответ собирается только из сообщений
 * ассистента, поэтому в чат из этого не уходит ничего.
 */
test("сжатие, выжимка и рефлексия не попадают в ответ пользователю", () => {
  const summary = summarizeStream([
    { type: "init", agentId: "agent-1", sessionId: "s", conversationId: "c" },
    { type: "compaction", content: "Сжал историю: 42 сообщения в выжимку" },
    { type: "summary", content: "Выжимка разговора: человек говорил о работе" },
    { type: "system", content: "SYSTEM ALERT: context window at 90%" },
    { type: "dreaming", content: "Рефлексия: перечитала заметки о человеке" },
    { type: "queue_update", position: 3 },
    { type: "loop_status", status: "thinking" },
    { type: "retry", attempt: 2 },
    { type: "reasoning", reasoning: "сначала посмотрю память" },
    { type: "tool_call", name: "memory_read" },
    { type: "tool_result", content: "заметка из памяти" },
    { type: "assistant", content: "Расскажи, что было дальше.", uuid: "m-1" },
    { type: "result", stopReason: "end_turn" },
  ] as never);

  assert.equal(summary.reply, "Расскажи, что было дальше.");
  assert.equal(summary.assistantGroups, 1);
  for (const leak of ["Сжал историю", "Выжимка", "SYSTEM ALERT", "Рефлексия", "заметка из памяти"]) {
    assert.ok(!summary.reply.includes(leak), `в ответ утекло служебное событие: ${leak}`);
  }
  // И в трассе от них остаются только тип и размер, а не содержимое.
  assert.doesNotMatch(JSON.stringify(summary.trace), /Сжал историю|Выжимка|SYSTEM ALERT|Рефлексия/);
});

test("административная трасса — только метаданные хода", () => {
  const summary = summarizeStream([
    { type: "user", content: "Меня зовут Сергей, телефон +7 900 000-00-00" },
    { type: "reasoning", reasoning: "пользователь тревожится из-за развода" },
    {
      type: "tool_call",
      toolName: "external_request",
      runId: "run-7",
      toolInput: {
        query: "истории болезни",
        api_key: "must-not-leak",
        nested: { Authorization: "Bearer secret" },
      },
    },
    { type: "tool_result", toolName: "external_request", content: "диагноз пациента" },
    { type: "assistant", content: "Понимаю, это тяжело." },
    {
      type: "result",
      stopReason: "end_turn",
      durationMs: 1200,
      usage: { total_tokens: 120, request_id: "provider-request-1" },
    },
  ] as never);

  const serialized = JSON.stringify(summary.trace);
  // Ничего из сказанного, подуманного, запрошенного и полученного.
  for (const leak of [
    "Сергей", "900-00-00", "тревожится", "развода", "истории болезни",
    "must-not-leak", "Bearer secret", "диагноз", "Понимаю",
  ]) {
    assert.equal(serialized.includes(leak), false, `в трассе не должно быть «${leak}»`);
  }

  // Метаданные при этом на месте: по ним ход разбирается.
  const call = summary.trace.find((entry) => entry.type === "tool_call");
  assert.equal(call?.toolName, "external_request");
  assert.equal(call?.runId, "run-7");
  assert.equal(call?.argumentCount, 3);
  assert.equal(call?.contentChars, undefined);

  const result = summary.trace.find((entry) => entry.type === "result");
  assert.equal(result?.stopReason, "end_turn");
  assert.equal(result?.durationMs, 1200);
  assert.deepEqual(result?.usage, { total_tokens: 120 });

  // Размер сказанного виден, само сказанное — нет.
  const assistant = summary.trace.find((entry) => entry.type === "assistant");
  assert.equal(assistant?.contentChars, "Понимаю, это тяжело.".length);
});

test("summarizeStream concatenates assistant deltas without breaking words", () => {
  const summary = summarizeStream([
    { type: "assistant", content: "Т" },
    { type: "assistant", content: "ут, В" },
    { type: "assistant", content: "иктор. Б" },
    { type: "assistant", content: "ыла пауза, но я на месте." },
  ] as never);
  assert.equal(summary.reply, "Тут, Виктор. Была пауза, но я на месте.");
});

test("summarizeStream falls back to the result text", () => {
  const summary = summarizeStream([
    { type: "result", result: "final answer", stopReason: "end_turn" },
  ] as never);
  assert.equal(summary.reply, "final answer");
});

test("summarizeStream on an empty stream is safe", () => {
  const summary = summarizeStream([]);
  assert.equal(summary.reply, "");
  assert.equal(summary.messageCount, 0);
});

test("telegram tags are stable", () => {
  assert.equal(telegramTag(700001), "tg:700001");
});

test("model switching inventories standalone WebUI agents too", async () => {
  const service = new LettaService(
    {
      appServerUrl: "ws://example.invalid/ws",
      appServerToken: "",
      appServerRequestTimeoutMs: 1000,
      model: "",
      sessionPoolSize: 5,
      sessionIdleMs: 1000,
      turnTimeoutMs: 1000,
    } as never,
    {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    "persona",
    SYSTEM_PROMPT,
  );
  (service as unknown as { client: unknown }).client = {
    agents: {
      list: async () => [
        { id: "agent-telegram" },
        { id: "agent-created-in-webui" },
      ],
    },
    conversations: {
      list: async ({ agentId }: { agentId: string }) =>
        agentId === "agent-telegram"
          ? [{ id: "conv-telegram" }]
          : [{ id: "conv-webui-a" }, { id: "conv-webui-b" }],
    },
  };

  assert.deepEqual(await service.listAllModelMappings(), [
    { agentId: "agent-telegram", conversationIds: ["conv-telegram"] },
    {
      agentId: "agent-created-in-webui",
      conversationIds: ["conv-webui-a", "conv-webui-b"],
    },
  ]);
});

test("App Server-only settings are applied at session open, not agent creation", async () => {
  const service = new LettaService(
    {
      appServerUrl: "ws://example.invalid/ws",
      appServerToken: "",
      appServerRequestTimeoutMs: 1000,
      model: "",
      sessionPoolSize: 5,
      sessionIdleMs: 1000,
      turnTimeoutMs: 1000,
    } as never,
    {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    "persona",
    SYSTEM_PROMPT,
  );
  const internal = service as unknown as {
    runtime: { reasoning_effort: "none" | "high"; default_persona: string };
    client: {
      createAgent(options: Record<string, unknown>): Promise<string>;
      agents: { update(): Promise<void> };
      resumeSession(id: string, options: Record<string, unknown>): unknown;
    };
    acquireSession(id: string): Promise<unknown>;
    sessionOptions(id: string): Promise<Record<string, unknown>>;
  };
  internal.runtime.reasoning_effort = "high";
  internal.runtime.default_persona = "database persona must not override eva.md";
  service.setToolFactory(() => [
    { name: "safe_tool" },
    { name: "Bash" },
  ] as never);
  const approval = async () => ({ behavior: "deny" as const, message: "test" });
  service.setSessionApprovalResolver(async () => approval);

  let createOptions: Record<string, unknown> = {};
  let sessionOptions: Record<string, unknown> = {};
  internal.client = {
    createAgent: async (options) => {
      createOptions = options;
      return "agent-sdk-options";
    },
    agents: { update: async () => {} },
    resumeSession: (_id, options) => {
      sessionOptions = options;
      return {
        bootstrapState: async () => ({}),
        recoverPendingApprovals: async () => ({ recovered: false }),
      };
    },
  };

  await service.createAgent({ telegramId: 123, displayName: "CI" });
  await internal.acquireSession("conversation-sdk-options");

  // Официальный raw override несёт tracked prompt; остальные возможности
  // Letta остаются штатными и не сужаются.
  assert.equal(createOptions.systemPrompt, SYSTEM_PROMPT);
  assert.equal(createOptions.persona, "persona");
  assert.equal("allowedTools" in createOptions, false);
  assert.equal("disallowedTools" in createOptions, false);
  assert.equal("systemInfoReminder" in createOptions, false);
  assert.equal("skillSources" in createOptions, false);
  assert.equal(createOptions.memfs, true);
  assert.deepEqual(createOptions.dreaming, { trigger: "compaction-event" });
  assert.deepEqual(
    (createOptions.memory as Array<{ label: string }>).map((block) => block.label),
    [
      "persona",
      "human",
      "current_state",
      "therapeutic_framework",
    ],
  );
  // Обычная сессия не передаёт ни allowedTools, ни skillSources: набор
  // клиентских инструментов и источники навыков остаются штатными.
  assert.equal("allowedTools" in sessionOptions, false);
  assert.equal("skillSources" in sessionOptions, false);
  assert.equal("stateless" in sessionOptions, false);
  assert.equal(sessionOptions.canUseTool, approval);
  assert.deepEqual(
    (sessionOptions.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["safe_tool", "Bash"],
  );
  assert.equal(sessionOptions.permissionMode, "standard");
  assert.equal(sessionOptions.reasoningEffort, "high");
  // cwd — рабочий каталог App Server: из него Letta Code открывает
  // `.skills`, поэтому проектные навыки видны без объявления источников.
  assert.equal(sessionOptions.cwd, "/data/letta");

  internal.runtime.reasoning_effort = "none";
  assert.equal("reasoningEffort" in await internal.sessionOptions("conversation-default"), false);
});

test("session opening awaits the approval resolver and recovery uses the same request-id callback", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 1000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);
  service.setToolFactory(() => [{ name: "chat_write" }, { name: "research_read" }] as never);
  const seen: Array<{ name: string; requestId?: string }> = [];
  const canUseTool = async (name: string, _args: unknown, context: { requestId?: string }) => {
    seen.push({ name, requestId: context.requestId });
    return { behavior: "allow" as const, message: "ok" };
  };
  let resolved = false;
  service.setSessionApprovalResolver(async (conversationId) => {
    await Promise.resolve();
    resolved = true;
    assert.equal(conversationId, "conversation-research");
    return canUseTool;
  });
  let opened: Record<string, unknown> = {};
  (service as unknown as { client: { resumeSession(id: string, options: Record<string, unknown>): unknown } }).client = {
    resumeSession: (_id, options) => {
      opened = options;
      return {
        bootstrapState: async () => ({}),
        recoverPendingApprovals: async () => {
          await (options.canUseTool as typeof canUseTool)("research_read", {}, { requestId: "sdk-request-restart" });
          return { recovered: true };
        }, close() {},
      };
    },
  };
  await (service as unknown as { acquireSession(id: string): Promise<unknown> }).acquireSession("conversation-research");
  assert.equal(resolved, true);
  assert.deepEqual((opened.tools as Array<{ name: string }>).map((tool) => tool.name), ["chat_write", "research_read"]);
  assert.equal("allowedTools" in opened, false);
  assert.equal(opened.canUseTool, canUseTool);
  assert.deepEqual(seen, [{ name: "research_read", requestId: "sdk-request-restart" }]);
});

/**
 * Срезы ответа наружу.
 *
 * Поток отдаёт ответ кусками, и куски принадлежат разным сообщениям: в
 * агентном ходе модель сперва проговаривает, что собирается сделать, и
 * только последнее сообщение — ответ. Подписчик обязан уметь их
 * различить, иначе показанный текст склеится с проговариванием.
 */
test("срезы ответа несут номер сообщения и время до первого текста", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 5000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);

  const events = [
    { type: "assistant", content: "Сейчас посмотрю", otid: "a" },
    { type: "assistant", content: " расписание.", otid: "a" },
    { type: "tool_call", name: "get_goal_context" },
    { type: "assistant", content: "Занятие в 19:00.", otid: "b" },
    { type: "assistant", content: " Успеешь?", otid: "b" },
    { type: "result", stopReason: "end_turn" },
  ];
  (service as unknown as { client: { resumeSession(id: string, options: unknown): unknown } }).client = {
    resumeSession: () => ({
      bootstrapState: async () => ({}),
      recoverPendingApprovals: async () => ({ recovered: false }),
      send: async () => undefined,
      stream: () => events[Symbol.iterator](),
      close() {},
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  };

  const deltas: Array<{ text: string; group: number; startsGroup: boolean }> = [];
  const result = await service.runTurn("conv-1", "привет", {
    onDelta: (delta) => deltas.push(delta),
  });

  // Проговаривание и ответ — разные сообщения, и это видно подписчику.
  assert.deepEqual(deltas.map((delta) => [delta.group, delta.startsGroup]), [
    [0, true], [0, false], [1, true], [1, false],
  ]);
  assert.equal(deltas.map((delta) => delta.text).join(""), "Сейчас посмотрю расписание.Занятие в 19:00. Успеешь?");
  // Ответ — последнее сообщение, проговаривание в него не попало.
  assert.equal(result.reply, "Занятие в 19:00. Успеешь?");
  assert.equal(typeof result.sessionAcquireMs, "number");
  assert.equal(typeof result.firstDeltaMs, "number");
});

test("служебные события потока не показываются человеку", async () => {
  // Сжатие контекста происходит прямо посреди хода: событие приходит в
  // тот же поток, что и ответ. Показывается только ответ.
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 5000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);
  const events = [
    { type: "compaction", content: "Сжала историю до выжимки" },
    { type: "system", content: "SYSTEM: context window at 90%" },
    { type: "assistant", content: "Я рядом.", otid: "a" },
    { type: "dreaming", content: "Рефлексия после сжатия" },
    { type: "result", stopReason: "end_turn" },
  ];
  (service as unknown as { client: { resumeSession(id: string, options: unknown): unknown } }).client = {
    resumeSession: () => ({
      bootstrapState: async () => ({}),
      recoverPendingApprovals: async () => ({ recovered: false }),
      send: async () => undefined,
      stream: () => events[Symbol.iterator](),
      close() {},
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  };

  const deltas: string[] = [];
  const result = await service.runTurn("conv-1", "привет", {
    onDelta: (delta) => deltas.push(delta.text),
  });

  assert.deepEqual(deltas, ["Я рядом."], `служебное событие показано человеку: ${deltas.join("|")}`);
  assert.equal(result.reply, "Я рядом.");
});

test("ход без текста не выдумывает время первого среза", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 5000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);
  (service as unknown as { client: { resumeSession(id: string, options: unknown): unknown } }).client = {
    resumeSession: () => ({
      bootstrapState: async () => ({}),
      recoverPendingApprovals: async () => ({ recovered: false }),
      send: async () => undefined,
      stream: () => [{ type: "result", stopReason: "end_turn" }][Symbol.iterator](),
      close() {},
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  };

  const result = await service.runTurn("conv-1", "привет");
  assert.equal(result.firstDeltaMs, null, "времени первого среза взяться неоткуда");
});

// --------------------------------------------------------------------
// Уровень reasoning и каталог моделей App Server
//
// SDK применяет reasoningEffort при инициализации сессии, а уровни живут
// в каталоге отдельными записями. У провайдера роутера таких записей нет,
// и любое значение кроме none роняло открытие сессии — то есть каждый ход
// на холодной сессии, а не качество ответа.
// --------------------------------------------------------------------

test("отказ каталога в уровне reasoning распознаётся, прочие ошибки — нет", () => {
  assert.equal(
    isReasoningTierError(new Error("No medium reasoning tier found for model lmstudio/eva/chat.")),
    true,
  );
  assert.equal(
    isReasoningTierError(
      new Error("reasoningEffort requires a model from listModels(); no catalog entry found for x."),
    ),
    true,
  );
  assert.equal(isReasoningTierError(new Error("WebSocket closed")), false);
});

test("уровень reasoning без записи в каталоге не выключает диалог", async () => {
  const warnings: string[] = [];
  const service = reasoningService((message) => warnings.push(message));
  const internal = service as unknown as {
    runtime: { reasoning_effort: string };
    client: { resumeSession(id: string, options: Record<string, unknown>): unknown };
    acquireSession(id: string): Promise<unknown>;
  };
  internal.runtime.reasoning_effort = "medium";
  service.setDefaultModel("lmstudio/eva/chat");

  const attempts: Array<Record<string, unknown>> = [];
  let closed = 0;
  internal.client = {
    resumeSession: (_id, options) => {
      attempts.push(options);
      const failing = attempts.length === 1;
      return {
        bootstrapState: async () => {
          if (failing) {
            throw new Error("No medium reasoning tier found for model lmstudio/eva/chat.");
          }
          return {};
        },
        close: () => {
          closed += 1;
        },
        recoverPendingApprovals: async () => ({ recovered: false }),
      };
    },
  };

  await internal.acquireSession("conversation-tier-1");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.reasoningEffort, "medium");
  assert.equal("reasoningEffort" in (attempts[1] ?? {}), false);
  assert.equal(closed, 1, "неинициализированная сессия должна закрываться");
  assert.equal(warnings.length, 1);

  // Вывод запоминается: следующая сессия не тратит заведомо провальную попытку.
  await internal.acquireSession("conversation-tier-2");
  assert.equal(attempts.length, 3);
  assert.equal("reasoningEffort" in (attempts[2] ?? {}), false);
});

test("прочая ошибка открытия сессии не подменяется отказом от reasoning", async () => {
  const service = reasoningService();
  const internal = service as unknown as {
    runtime: { reasoning_effort: string };
    client: { resumeSession(id: string, options: Record<string, unknown>): unknown };
    acquireSession(id: string): Promise<unknown>;
  };
  internal.runtime.reasoning_effort = "medium";

  let attempts = 0;
  internal.client = {
    resumeSession: () => {
      attempts += 1;
      return {
        bootstrapState: async () => {
          throw new Error("WebSocket closed before the handshake");
        },
        close: () => {},
      };
    },
  };

  await assert.rejects(() => internal.acquireSession("conversation-broken"));
  assert.equal(attempts, 1, "оборванное соединение не повод переоткрывать без reasoning");
});

test("смена модели снимает запомненный отказ каталога", async () => {
  const service = reasoningService();
  const internal = service as unknown as {
    runtime: { reasoning_effort: string };
    unsupportedReasoningEffort: string | null;
    sessionOptions(id: string): Promise<Record<string, unknown>>;
  };
  internal.runtime.reasoning_effort = "medium";
  service.setDefaultModel("lmstudio/eva/chat");
  internal.unsupportedReasoningEffort = "medium";
  assert.equal("reasoningEffort" in await internal.sessionOptions("c1"), false);

  // У другой модели каталог может знать этот уровень — вывод не переносится.
  service.setDefaultModel("openai/gpt-5.6");
  assert.equal((await internal.sessionOptions("c1")).reasoningEffort, "medium");
});

test("поддержка уровня reasoning читается из каталога App Server", async () => {
  const service = reasoningService();
  const internal = service as unknown as { client: { models: { list(): Promise<unknown> } } };
  service.setDefaultModel("lmstudio/eva/chat");

  internal.client = {
    models: {
      list: async () => ({
        entries: [
          { id: "eva-chat", handle: "lmstudio/eva/chat", updateArgs: { context_window: 65536 } },
          { id: "gpt-medium", handle: "openai/gpt-5.6", updateArgs: { reasoning_effort: "medium" } },
        ],
      }),
    },
  };
  // Запись с нужным уровнем у ЧУЖОЙ модели ничего не обещает активной.
  assert.deepEqual(await service.reasoningEffortSupport("medium"), {
    checked: true,
    supported: false,
    model: "lmstudio/eva/chat",
  });
  assert.deepEqual(await service.reasoningEffortSupport("none"), {
    checked: true,
    supported: true,
    model: "lmstudio/eva/chat",
  });

  internal.client = {
    models: {
      list: async () => ({
        entries: [
          {
            id: "eva-chat-medium",
            handle: "lmstudio/eva/chat",
            updateArgs: { reasoning_effort: "medium" },
          },
        ],
      }),
    },
  };
  assert.equal((await service.reasoningEffortSupport("medium")).supported, true);

  internal.client = {
    models: {
      list: async () => {
        throw new Error("App Server недоступен");
      },
    },
  };
  const unavailable = await service.reasoningEffortSupport("medium");
  assert.equal(unavailable.checked, false, "недоступный каталог не является отказом");
});

function reasoningService(onWarn: (message: string) => void = () => {}) {
  return new LettaService(
    {
      appServerUrl: "ws://example.invalid/ws",
      appServerToken: "",
      appServerRequestTimeoutMs: 1000,
      model: "",
      sessionPoolSize: 5,
      sessionIdleMs: 1000,
      turnTimeoutMs: 1000,
    } as never,
    {
      debug() {},
      info() {},
      warn(message: string) {
        onWarn(message);
      },
      error() {},
    } as never,
    "persona",
    SYSTEM_PROMPT,
  );
}

/**
 * Единственный cognitive runtime — Letta.
 *
 * Проверяется не намерение, а фактический набор полей, который Evaself
 * отправляет в SDK: system prompt должен прийти из репозитория, а точный
 * список инструментов или суженные источники навыков здесь недопустимы.
 */
test("агент получает repository prompt без сужения штатных возможностей Letta", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 1000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);
  service.setToolFactory(() => [{ name: "eva_get_reminders" }] as never);
  const internal = service as unknown as {
    client: { createAgent(options: Record<string, unknown>): Promise<string> };
    sessionOptions(id: string): Promise<Record<string, unknown>>;
  };

  let created: Record<string, unknown> = {};
  internal.client.createAgent = async (options) => { created = options; return "agent-1"; };
  await service.createAgent({ telegramId: 1, displayName: "CI" });

  // Агент: tracked prompt, включённый MemFS, рефлексия на сжатии.
  assert.equal(created.systemPrompt, SYSTEM_PROMPT);
  for (const forbidden of ["allowedTools", "disallowedTools", "skillSources"]) {
    assert.equal(forbidden in created, false, `createAgent передал ${forbidden}`);
  }
  assert.equal(created.memfs, true);
  assert.deepEqual(created.dreaming, { trigger: "compaction-event" });

  // Сессия: только продуктовые инструменты Evaself, всё остальное — Letta.
  const session = await internal.sessionOptions("conversation-1");
  for (const forbidden of ["allowedTools", "skillSources", "stateless", "systemPrompt"]) {
    assert.equal(forbidden in session, false, `сессия передала ${forbidden}`);
  }
  assert.deepEqual(
    (session.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["eva_get_reminders"],
  );
});

test("административное создание не обходит repository prompt и eva.md", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 1000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "repository persona", SYSTEM_PROMPT);
  const internal = service as unknown as {
    client: {
      createAgent(options: Record<string, unknown>): Promise<string>;
      agents: { retrieve(agentId: string): Promise<unknown> };
    };
  };
  let created: Record<string, unknown> = {};
  internal.client = {
    createAgent: async (options) => { created = options; return "agent-managed"; },
    agents: { retrieve: async () => ({ id: "agent-managed" }) },
  };

  await service.createManagedAgent({
    name: "Managed Eva",
    persona: "request override",
    system_prompt_preset: "codex",
    system_prompt_append: "request append",
    create_conversation: false,
  });

  assert.equal(created.persona, "repository persona");
  assert.equal(created.systemPrompt, SYSTEM_PROMPT);
  const persona = (created.memory as Array<{ label: string; value: string }>)
    .find((block) => block.label === "persona");
  assert.equal(persona?.value, "repository persona");
});

/** Факты runtime берутся из init-сообщения сессии, а не из настроек. */
test("состояние MemFS, навыков и инструментов читается из init-сообщения", () => {
  const warnings: string[] = [];
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 1000,
  } as never, {
    debug() {}, info() {}, warn: (message: string) => warnings.push(message), error() {},
  }, "persona", SYSTEM_PROMPT);
  const internal = service as unknown as {
    recordRuntimeFacts(message: Record<string, unknown>): void;
  };

  assert.equal(service.runtimeFacts, null, "до первой сессии фактов нет");
  internal.recordRuntimeFacts({
    type: "init", model: "eva/chat", memfsEnabled: true,
    skillSources: ["bundled", "global", "agent", "project"],
    tools: ["memory", "Skill", "Task", "eva_get_reminders"],
    dreaming: { trigger: "compaction-event", behavior: "reminder", stepCount: 20 },
  });
  const facts = service.runtimeFacts!;
  assert.equal(facts.memfsEnabled, true);
  assert.deepEqual(facts.skillSources, ["bundled", "global", "agent", "project"]);
  assert.ok(facts.tools!.includes("eva_get_reminders"), "продуктовый инструмент виден runtime");
  assert.equal(facts.dreaming?.trigger, "compaction-event");
  assert.deepEqual(warnings, []);

  internal.recordRuntimeFacts({ type: "init", model: "eva/chat", memfsEnabled: false });
  assert.equal(service.runtimeFacts?.memfsEnabled, false);
  assert.equal(warnings.length, 1, "выключенный MemFS не проходит молча");
});

// --------------------------------------------------------------------
// Готовность: факты сессии, а не конфигурация
// --------------------------------------------------------------------

test("готовность собирается из фактов открытой сессии", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 1000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);
  service.setToolFactory(() => [{ name: "get_user_time_context" }] as never);

  const internal = service as unknown as {
    client: Record<string, unknown>;
    acquireSession(id: string): Promise<unknown>;
  };
  internal.client = {
    agents: { list: async () => [] },
    models: { list: async () => ({ entries: [{ id: "test/model" }] }) },
    resumeSession: () => ({
      // Гидратация называет серверные инструменты, состояние устройства —
      // каталог памяти и режим разрешений. Ход модели не тратится.
      bootstrapState: async () => ({ tools: ["memory", "Skill", "Task"], model: "test/model" }),
      recoverPendingApprovals: async () => ({ recovered: false }),
      getDeviceStatus: async () => ({
        isOnline: true,
        permissionMode: "standard",
        workingDirectory: "/data/letta",
        memoryDirectory: "/data/letta/.memory/agent-1",
        pendingControlRequests: [],
        raw: {},
      }),
      close() {},
    }),
  };

  await internal.acquireSession("conversation-readiness");
  // Состояние устройства спрашивается вне хода: даём микрозадаче дойти.
  await new Promise((resolve) => setTimeout(resolve, 5));

  const report = await service.readiness(["get_user_time_context"]);
  assert.equal(report.ready, true, JSON.stringify(report.checks));
  const status = (name: string) => report.checks.find((entry) => entry.name === name)?.status;
  assert.equal(status("memfs"), "ok");
  assert.equal(status("native_memory"), "ok");
  assert.equal(status("native_subagents"), "ok");
  assert.equal(status("product_tools"), "ok");
  assert.equal(status("permission_mode"), "ok");
  service.shutdown();
});

test("неготовность видна, когда runtime не подтвердил MemFS", async () => {
  const service = new LettaService({
    appServerUrl: "ws://example.invalid/ws", appServerToken: "", appServerRequestTimeoutMs: 1000,
    model: "", sessionPoolSize: 5, sessionIdleMs: 1000, turnTimeoutMs: 1000,
  } as never, { debug() {}, info() {}, warn() {}, error() {} }, "persona", SYSTEM_PROMPT);
  service.setToolFactory(() => [{ name: "get_user_time_context" }] as never);
  const internal = service as unknown as {
    client: Record<string, unknown>;
    acquireSession(id: string): Promise<unknown>;
  };
  internal.client = {
    agents: { list: async () => [] },
    models: { list: async () => ({ entries: [{ id: "test/model" }] }) },
    resumeSession: () => ({
      bootstrapState: async () => ({ tools: ["memory", "Skill", "Task"], model: "test/model" }),
      recoverPendingApprovals: async () => ({ recovered: false }),
      getDeviceStatus: async () => ({
        isOnline: true, permissionMode: "standard", workingDirectory: "/data/letta",
        memoryDirectory: null, pendingControlRequests: [], raw: {},
      }),
      close() {},
    }),
  };
  await internal.acquireSession("conversation-no-memfs");
  await new Promise((resolve) => setTimeout(resolve, 5));

  const report = await service.readiness(["get_user_time_context"]);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((entry) => entry.name === "memfs")?.status, "failed");
  service.shutdown();
});
