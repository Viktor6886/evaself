import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolFactory } from "../dist/agent-tools.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";
import { BackgroundRuntime } from "../dist/background.js";
import {
  ConversationPurposeService,
  purposePolicy,
} from "../dist/conversations/purpose-service.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("a service conversation is created lazily once for its purpose", async () => {
  let active: string | null = null;
  let sdkCreates = 0;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT conversation_id")) {
        return { rows: active ? [{ conversation_id: active }] : [] };
      }
      if (sql.includes("INSERT INTO agent_conversations")) {
        active = String(values[2]);
        return { rows: [{ conversation_id: active }] };
      }
      return { rows: [] };
    },
  };
  const letta = {
    createConversationRecord: async () => {
      sdkCreates += 1;
      return { id: "conversation-scheduler" };
    },
    updateConversation: async () => ({}),
  };
  const purposes = new ConversationPurposeService(db as never, letta as never, logger);

  const first = await purposes.ensure({
    userId: 7,
    agentId: "agent-7",
    purpose: "scheduler",
    parentConversationId: "conversation-chat",
  });
  const second = await purposes.ensure({
    userId: 7,
    agentId: "agent-7",
    purpose: "scheduler",
    parentConversationId: "conversation-chat",
  });

  assert.equal(first.conversationId, "conversation-scheduler");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(sdkCreates, 1);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO agent_conversations"));
  assert.equal(insert?.values[3], "scheduler");
  assert.equal(insert?.values[4], "conversation-chat");
});

test("scheduler runtime uses its own conversation instead of the main chat", async () => {
  const builtFor: string[] = [];
  const turns: string[] = [];
  const background = new BackgroundRuntime(
    {
      schedulerIntervalMs: 30_000,
      heartbeatIntervalMs: 600_000,
      typingIntervalMs: 4_000,
    } as never,
    {
      transaction: async () => [],
      query: async () => ({ rows: [] }),
      markAgentUsed: async () => {},
    } as never,
    {
      runTurn: async (conversationId: string) => {
        turns.push(conversationId);
        return { reply: "Напоминание" };
      },
    } as never,
    { run: async (_id: number, work: () => Promise<unknown>) => await work() } as never,
    { configured: true, sendMessage: async () => {} } as never,
    {
      build: async (input: { conversationId: string }) => {
        builtFor.push(input.conversationId);
        return {};
      },
      wrapUserMessage: () => "prompt",
    } as never,
    {
      ensure: async () => ({
        conversationId: "conversation-scheduler",
        purpose: "scheduler",
        created: false,
      }),
    } as never,
    logger,
  );

  await (background as unknown as {
    executeTask(task: Record<string, unknown>): Promise<void>;
  }).executeTask({
    id: "11",
    user_id: "7",
    telegram_id: "77",
    chat_id: "77",
    title: "Позвонить",
    description: null,
    cron_expression: null,
    repeat_enabled: false,
    timezone: "UTC",
    agent_id: "agent-7",
    conversation_id: "conversation-chat",
  });

  assert.deepEqual(builtFor, ["conversation-scheduler"]);
  assert.deepEqual(turns, ["conversation-scheduler"]);
  assert.equal(turns.includes("conversation-chat"), false);
});

test("purpose policy denies destructive chat tools in research conversations", async () => {
  const factory = new AgentToolFactory(
    { searxngUrl: "http://search.invalid" } as never,
    {
      getAgentRuntimeContext: async () => ({
        userId: 7,
        telegramId: 77,
        chatId: 77,
        conversationId: "conversation-research",
        purpose: "research",
        timezone: "UTC",
        responseMode: "text",
        useEmoji: false,
      }),
      query: async () => ({ rows: [] }),
    } as never,
    {} as never,
    logger,
  );
  const saveNote = factory
    .forConversation("conversation-research")
    .find((tool) => tool.name === "save_note")!;
  const response = await saveNote.execute("call-1", {
    title: "Нельзя",
    content: "Не должно сохраниться",
  }) as { details?: { ok?: boolean; error?: string } };

  assert.equal(response.details?.ok, false);
  assert.match(response.details?.error ?? "", /недоступен/);
  assert.deepEqual(purposePolicy("research").allowedTools, [
    "web_search",
    "PERPLEXITY_SEARCH",
    "brave_search",
  ]);
});

test("tool runtime context is cached and invalidated after a preference change", async () => {
  let contextReads = 0;
  const db = {
    getAgentRuntimeContext: async () => {
      contextReads += 1;
      return {
        userId: 7,
        telegramId: 77,
        chatId: 77,
        conversationId: "conversation-chat",
        purpose: "chat",
        timezone: "UTC",
        responseMode: "text",
        useEmoji: false,
      };
    },
    query: async (sql: string) => {
      if (sql.includes("profile_field_definitions")) return { rows: [] };
      return { rows: [] };
    },
  };
  const factory = new AgentToolFactory(
    { searxngUrl: "http://search.invalid" } as never,
    withTenantScopes(db) as never,
    {} as never,
    logger,
  );
  const tools = factory.forConversation("conversation-chat");
  const getProfile = tools.find((tool) => tool.name === "get_user_profile")!;
  const responseMode = tools.find((tool) => tool.name === "update_response_mode")!;

  await getProfile.execute("call-1", {});
  await getProfile.execute("call-2", {});
  assert.equal(contextReads, 1);
  await responseMode.execute("call-3", { mode: "voice" });
  await getProfile.execute("call-4", {});
  assert.equal(contextReads, 2);
});

test("destructive tools require backend confirmation", async () => {
  let deletes = 0;
  const factory = new AgentToolFactory(
    {
      searxngUrl: "http://search.invalid",
      todoistApiUrl: "https://api.todoist.invalid/rest/v2",
    } as never,
    withTenantScopes({
      getAgentRuntimeContext: async () => ({
        userId: 7,
        telegramId: 77,
        chatId: 77,
        conversationId: "conversation-chat",
        purpose: "chat",
        timezone: "UTC",
        responseMode: "text",
        useEmoji: false,
      }),
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM eva_notes")) {
          deletes += 1;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    }) as never,
    {} as never,
    logger,
  );
  const deleteNotes = factory
    .forConversation("conversation-chat")
    .find((tool) => tool.name === "delete_notes")!;

  const denied = await deleteNotes.execute("call-1", { ids: [1] }) as {
    details?: { ok?: boolean; error?: string };
  };
  assert.equal(denied.details?.ok, false);
  assert.match(denied.details?.error ?? "", /confirm=DELETE/);
  assert.equal(deletes, 0);

  const allowed = await deleteNotes.execute("call-2", {
    ids: [1],
    confirm: "DELETE",
  }) as { details?: { ok?: boolean; deleted?: number } };
  assert.equal(allowed.details?.ok, true);
  assert.equal(allowed.details?.deleted, 1);
  assert.equal(deletes, 1);
});
