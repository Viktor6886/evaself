import assert from "node:assert/strict";
import test from "node:test";

import { AgentToolFactory, toolRisk } from "../dist/agent-tools.js";
import { runInTurn } from "../dist/turns/turn-context.js";
import { inspectStickerCatalog, stickerFileId } from "../dist/telegram/stickers.js";

const FILE_ID = "CAACAgIAAxkBAAExampleSafeFileId_123456789";

test("sticker catalog accepts semantic intent and rejects URL or arbitrary id", () => {
  assert.equal(stickerFileId({ hug: FILE_ID }, "hug"), FILE_ID);
  assert.equal(stickerFileId({ hug: "https://example.test/sticker.tgs" }, "hug"), null);
  assert.equal(stickerFileId({ hug: FILE_ID }, "custom"), null);
  assert.equal(toolRisk("send_sticker"), "low_risk_write");
  assert.deepEqual(inspectStickerCatalog({}), {
    status: "empty", availableIntents: [], invalidEntries: [],
  });
  assert.deepEqual(inspectStickerCatalog({ hug: "https://example.test/sticker.tgs" }), {
    status: "invalid", availableIntents: [], invalidEntries: ["hug"],
  });
});

test("send_sticker returns visible sticker_unavailable without a catalog", async () => {
  const sent: unknown[] = [];
  const factory = new AgentToolFactory(
    {
      vectorGoalsEnabled: false, routerUrl: "", routerApiKey: "",
      telegramStickerCatalog: {}, telegramStickerCatalogParseError: false,
    } as never,
    {
      getAgentRuntimeContext: async () => ({
        userId: 7, telegramId: 42, chatId: 42, conversationId: "conv-empty",
        purpose: "chat", responseMode: "text", useEmoji: true,
      }),
      getQuotaStatus: async () => [], incrementUsage: async () => 0,
      withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work(),
    } as never,
    { sendSticker: async (...args: unknown[]) => { sent.push(args); } } as never,
  );
  const sticker = factory.forConversation("conv-empty")
    .find((entry) => entry.name === "send_sticker")!;
  const result = await runInTurn({
    conversationId: "conv-empty", runId: "run-empty", recorded: false,
    isCancelled: async () => false, chatId: 42,
  }, async () => await sticker.execute("call-empty", { intent: "hug" }));

  assert.deepEqual(result.details, {
    ok: false, reason: "sticker_unavailable", catalog_status: "empty",
  });
  assert.deepEqual(sent, []);
});

test("Compose and env example pass the bot-specific sticker catalog", async (context) => {
  const { readFileSync } = await import("node:fs");
  const { access } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    await access(join(root, "compose.yaml"));
  } catch {
    context.skip("service-only image excludes repository configuration");
    return;
  }
  const compose = readFileSync(join(root, "compose.yaml"), "utf8");
  const example = readFileSync(join(root, ".env.example"), "utf8");
  assert.match(compose, /EVA_TELEGRAM_STICKER_CATALOG_JSON:/);
  assert.match(example, /^EVA_TELEGRAM_STICKER_CATALOG_JSON=\{\}$/m);
  assert.match(example, /bot-specific/i);
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
