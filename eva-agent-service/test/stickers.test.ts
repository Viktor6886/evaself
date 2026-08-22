import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolFactory, toolRisk } from "../dist/agent-tools.js";
import { runInTurn } from "../dist/turns/turn-context.js";
import { stickerFileId } from "../dist/telegram/stickers.js";

const FILE_ID = "CAACAgIAAxkBAAExampleSafeFileId_123456789";

test("sticker catalog accepts semantic intent and rejects URL or arbitrary id", () => {
  assert.equal(stickerFileId({ hug: FILE_ID }, "hug"), FILE_ID);
  assert.equal(stickerFileId({ hug: "https://example.test/sticker.tgs" }, "hug"), null);
  assert.equal(stickerFileId({ hug: FILE_ID }, "custom"), null);
  assert.equal(toolRisk("send_sticker"), "low_risk_write");
});

test("send_sticker uses captured turn and EffectJournal idempotency", async () => {
  const sent: Array<{ chatId: number; fileId: string }> = [];
  const begins: Array<Record<string, unknown>> = [];
  let saved: unknown;
  const runtime = {
    userId: 7, telegramId: 42, chatId: 999, conversationId: "conv-sticker",
    purpose: "chat", timezone: "UTC", responseMode: "text", useEmoji: true,
  };
  const db = {
    getAgentRuntimeContext: async () => runtime,
    getQuotaStatus: async () => [], incrementUsage: async () => 0,
    withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const effects = {
    begin: async (input: Record<string, unknown>) => {
      begins.push(input);
      return begins.length === 1
        ? { action: "execute", attempt: 1 }
        : { action: "replay", result: saved };
    },
    succeed: async (_key: string, _userId: number, result: unknown) => { saved = result; },
    fail: async () => {},
  };
  const factory = new AgentToolFactory(
    {
      vectorGoalsEnabled: false, routerUrl: "", routerApiKey: "",
      telegramStickerCatalog: { hug: FILE_ID },
    } as never,
    db as never,
    { sendSticker: async (chatId: number, fileId: string) => { sent.push({ chatId, fileId }); } } as never,
    { debug() {}, info() {}, warn() {}, error() {} },
    undefined, undefined, effects as never,
  );
  const sticker = factory.forConversation("conv-sticker").find((tool) => tool.name === "send_sticker")!;
  const turn = {
    conversationId: "conv-sticker", runId: "11111111-1111-1111-1111-111111111111",
    recorded: true, isCancelled: async () => false, chatId: 42, messageId: 5,
  };
  const first = await runInTurn(turn, async () => await sticker.execute("call-sticker", { intent: "hug" }));
  const second = await runInTurn(turn, async () => await sticker.execute("call-sticker", { intent: "hug" }));

  assert.deepEqual(first.details, { ok: true, intent: "hug" });
  assert.deepEqual(second.details, first.details);
  assert.deepEqual(sent, [{ chatId: 42, fileId: FILE_ID }]);
  assert.equal(begins[0]?.runId, turn.runId);
  assert.equal(begins[0]?.toolName, "send_sticker");
});
