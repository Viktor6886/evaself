import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationContextManager } from "../dist/conversations/context-management.js";

test("automatic context manager rotates an oversized active conversation", async () => {
  const calls: string[] = [];
  const manager = new ConversationContextManager(
    { getSdkSettings: async () => ({ default_context_window: 180000, automatic_context_management: {
      enabled: true, compaction_message_threshold: 300, rotation_message_threshold: 600,
      compaction_mode: "sliding_window", sliding_window_percentage: 0.5,
    } }) } as never,
    { createConversation: async (agentId: string) => { calls.push(agentId); return "conv-new"; } } as never,
    { setConversation: async (...args: unknown[]) => calls.push(args.join(":")) } as never,
  );
  const result = await manager.beforeTurn({
    agentId: "agent-1", conversationId: "conv-old", userId: 7, messageCount: 600,
  });
  assert.equal(result, "conv-new");
  assert.deepEqual(calls, ["agent-1", "agent-1:conv-new:7"]);
});

test("automatic context manager configures real Letta compaction at threshold", async () => {
  const calls: unknown[] = [];
  const manager = new ConversationContextManager(
    { getSdkSettings: async () => ({
      default_context_window: 180000,
      automatic_context_management: {
        enabled: true, compaction_message_threshold: 300, rotation_message_threshold: 600,
      compaction_mode: "sliding_window", sliding_window_percentage: 0.5,
      },
    }) } as never,
    {
      configureCompaction: async (...args: unknown[]) => calls.push(args),
      createConversation: async () => { throw new Error("must not rotate"); },
    } as never,
    { setConversation: async () => { throw new Error("must not switch"); } } as never,
  );
  assert.equal(await manager.beforeTurn({
    agentId: "agent-1", conversationId: "conv-old", userId: 7, messageCount: 300,
  }), "conv-old");
  assert.deepEqual(calls, [["agent-1", { mode: "sliding_window", sliding_window_percentage: 0.5 }]]);
});

test("automatic context manager keeps a conversation below compaction threshold", async () => {
  const manager = new ConversationContextManager(
    { getSdkSettings: async () => ({ default_context_window: 180000, automatic_context_management: {
      enabled: true, compaction_message_threshold: 300, rotation_message_threshold: 600,
      compaction_mode: "sliding_window", sliding_window_percentage: 0.5,
    } }) } as never,
    { configureCompaction: async () => { throw new Error("must not compact"); }, createConversation: async () => { throw new Error("must not rotate"); } } as never,
    { setConversation: async () => { throw new Error("must not switch"); } } as never,
  );
  assert.equal(await manager.beforeTurn({
    agentId: "agent-1", conversationId: "conv-old", userId: 7, messageCount: 299,
  }), "conv-old");
});
