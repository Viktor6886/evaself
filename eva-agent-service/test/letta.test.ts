import assert from "node:assert/strict";
import { test } from "node:test";

import { extractText, LettaService, summarizeStream, telegramTag } from "../dist/letta.js";

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

test("summarizeStream picks the assistant text and separates reasoning", () => {
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
  assert.deepEqual(summary.reasoning, ["thinking"]);
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

test("administrative trace keeps tool details but redacts secrets", () => {
  const summary = summarizeStream([
    {
      type: "tool_call",
      toolName: "external_request",
      toolInput: {
        query: "safe",
        api_key: "must-not-leak",
        nested: { Authorization: "Bearer secret" },
      },
    },
  ] as never);
  assert.equal(summary.trace[0]?.toolName, "external_request");
  assert.equal(
    (summary.trace[0]?.toolInput as Record<string, unknown>).api_key,
    "[скрыто]",
  );
  assert.equal(
    ((summary.trace[0]?.toolInput as Record<string, unknown>).nested as Record<string, unknown>)
      .Authorization,
    "[скрыто]",
  );
  assert.doesNotMatch(JSON.stringify(summary.trace), /must-not-leak|Bearer secret/);
});

test("summarizeStream joins several assistant messages", () => {
  const summary = summarizeStream([
    { type: "assistant", content: "one" },
    { type: "assistant", content: [{ type: "text", text: "two" }] },
  ] as never);
  assert.equal(summary.reply, "one\n\ntwo");
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
  );
  const internal = service as unknown as {
    runtime: {
      allowed_tools: string[] | null;
      disallowed_tools: string[];
      system_info_reminder: boolean;
      reasoning_effort: "none" | "high";
    };
    client: {
      createAgent(options: Record<string, unknown>): Promise<string>;
      agents: { update(): Promise<void> };
      resumeSession(id: string, options: Record<string, unknown>): unknown;
    };
    acquireSession(id: string): Promise<unknown>;
    sessionOptions(id: string): Record<string, unknown>;
  };
  internal.runtime.allowed_tools = ["Read", "WebSearch"];
  internal.runtime.disallowed_tools = ["Bash"];
  internal.runtime.system_info_reminder = true;
  internal.runtime.reasoning_effort = "high";
  service.setToolFactory(() => [
    { name: "safe_tool" },
    { name: "Bash" },
  ] as never);

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
        initialize: async () => {},
        bootstrapState: async () => ({}),
        recoverPendingApprovals: async () => ({ recovered: false }),
      };
    },
  };

  await service.createAgent({ telegramId: 123, displayName: "CI" });
  await internal.acquireSession("conversation-sdk-options");

  assert.equal("allowedTools" in createOptions, false);
  assert.equal("disallowedTools" in createOptions, false);
  assert.equal("systemInfoReminder" in createOptions, false);
  assert.deepEqual(
    (createOptions.memory as Array<{ label: string }>).map((block) => block.label),
    [
      "persona",
      "human",
      "current_state",
      "goals_and_commitments",
      "relationships_and_patterns",
      "progress_and_hypotheses",
    ],
  );
  assert.deepEqual(sessionOptions.allowedTools, ["Read", "WebSearch"]);
  assert.deepEqual(
    (sessionOptions.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["safe_tool"],
  );
  assert.equal(sessionOptions.permissionMode, "unrestricted");
  assert.equal(sessionOptions.reasoningEffort, "high");
  assert.equal(sessionOptions.cwd, "/data/letta");
  assert.deepEqual(sessionOptions.skillSources, ["bundled", "global", "agent", "project"]);

  internal.runtime.reasoning_effort = "none";
  assert.equal("reasoningEffort" in internal.sessionOptions("conversation-default"), false);
});
