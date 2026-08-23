import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentToolFactory, toolRisk } from "../dist/agent-tools.js";
import { TelegramClient } from "../dist/telegram.js";
import {
  STICKER_INTENTS, TelegramStickerCatalog, inspectStickerAsset,
  inspectStickerCatalog, stickerFileId,
} from "../dist/telegram/stickers.js";
import { runInTurn } from "../dist/turns/turn-context.js";

const FILE_ID = "CAACAgIAAxkBAAExampleSafeFileId_123456789";
const LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

test("built-in sticker assets cover every intent and are valid Telegram WEBP", async () => {
  const assetDir = join(import.meta.dirname, "..", "assets", "stickers");
  for (const intent of STICKER_INTENTS) {
    const inspected = inspectStickerAsset(new Uint8Array(await readFile(join(assetDir, `${intent}.webp`))));
    assert.deepEqual(inspected, { width: 512, height: 512 }, intent);
  }
  assert.equal(toolRisk("send_sticker"), "low_risk_write");
});

test("legacy catalog accepts file_id and rejects URL or arbitrary intent", () => {
  assert.equal(stickerFileId({ hug: FILE_ID }, "hug"), FILE_ID);
  assert.equal(stickerFileId({ hug: "https://example.test/sticker.tgs" }, "hug"), null);
  assert.equal(stickerFileId({ hug: FILE_ID }, "custom"), null);
  assert.deepEqual(inspectStickerCatalog({}), {
    status: "empty", availableIntents: [], invalidEntries: [],
  });
});

test("fresh config uploads multipart once, persists file_id, and scopes cache to bot", async (context) => {
  const requests: Array<{ url: string; type: string; body: Buffer }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({ url: request.url ?? "", type: String(request.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { message_id: requests.length, sticker: { file_id: FILE_ID } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const rows = new Map<string, { intent: string; file_id: string | null; last_status: string }>();
  const db = fakeStickerDb(rows);

  const first = new TelegramClient({ telegramBotToken: "1001:secret", telegramApiBaseUrl: base, telegramStickerCatalog: {} } as never, LOGGER, db as never);
  await first.sendStickerIntent(42, "hug");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /bot1001:secret\/sendSticker$/);
  assert.match(requests[0]!.type, /^multipart\/form-data; boundary=/);
  const multipart = requests[0]!.body.toString("latin1");
  assert.match(multipart, /name="chat_id"\r\n\r\n42/);
  assert.match(multipart, /name="sticker"; filename="hug\.webp"/);
  assert.match(multipart, /Content-Type: image\/webp/i);
  assert.match(multipart, /RIFF/);
  assert.equal(rows.get("bot:1001:hug")?.file_id, FILE_ID);

  const restarted = new TelegramClient({ telegramBotToken: "1001:rotated", telegramApiBaseUrl: base, telegramStickerCatalog: {} } as never, LOGGER, db as never);
  await restarted.sendStickerIntent(43, "hug");
  assert.equal(requests[1]!.type, "application/json");
  assert.deepEqual(JSON.parse(requests[1]!.body.toString("utf8")), { chat_id: 43, sticker: FILE_ID });

  const anotherBot = new TelegramClient({ telegramBotToken: "2002:secret", telegramApiBaseUrl: base, telegramStickerCatalog: {} } as never, LOGGER, db as never);
  await anotherBot.sendStickerIntent(44, "hug");
  assert.match(requests[2]!.type, /^multipart\/form-data; boundary=/);
});

test("legacy override sends file_id without upload", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new TelegramClient({ telegramBotToken: "1001:secret", telegramApiBaseUrl: "https://api.telegram.invalid", telegramStickerCatalog: { hug: FILE_ID } } as never, LOGGER);
  telegram.call = async (method, body) => { calls.push({ method, body }); return { sticker: { file_id: FILE_ID } } as never; };
  await telegram.sendStickerIntent(77, "hug");
  assert.deepEqual(calls, [{ method: "sendSticker", body: { chat_id: 77, sticker: FILE_ID } }]);
});

test("unknown intent and missing/bad local asset fail visibly", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "evaself-stickers-"));
  context.after(async () => await rm(dir, { recursive: true, force: true }));
  const catalog = new TelegramStickerCatalog({}, "1001:secret", null, LOGGER, dir);
  const never = async () => { throw new Error("must not send"); };
  assert.deepEqual(await catalog.send("foreign", never, never), { ok: false, reason: "sticker_unavailable", catalog_status: "unknown_intent" });
  assert.deepEqual(await catalog.send("hug", never, never), { ok: false, reason: "sticker_unavailable", catalog_status: "asset_missing" });
  await writeFile(join(dir, "hug.webp"), Buffer.from("not-webp"));
  assert.deepEqual(await catalog.send("hug", never, never), { ok: false, reason: "sticker_unavailable", catalog_status: "asset_missing" });
  assert.equal((await catalog.diagnostics()).status, "asset_missing");
});

test("upload failure is exposed as telegram_upload_failed diagnostics", async () => {
  const assetDir = join(import.meta.dirname, "..", "assets", "stickers");
  const catalog = new TelegramStickerCatalog({}, "1001:secret", null, LOGGER, assetDir);
  await assert.rejects(
    catalog.send("hug", async () => ({}), async () => { throw new Error("Telegram down"); }),
    /Telegram down/,
  );
  const diagnostics = await catalog.diagnostics();
  assert.equal(diagnostics.status, "telegram_upload_failed");
  assert.deepEqual(diagnostics.failedIntents, ["hug"]);
});

test("durable outbox receives only trusted chat_id and semantic intent", async () => {
  const envelopes: unknown[] = [];
  const telegram = new TelegramClient({ telegramBotToken: "1001:secret", telegramApiBaseUrl: "https://api.telegram.invalid", telegramStickerCatalog: {} } as never, LOGGER);
  telegram.setOutbox({ send: async (envelope) => { envelopes.push(envelope); return { queued: true }; } });
  await telegram.sendStickerIntent(42, "support");
  const envelope = envelopes[0] as { method: string; chatId: number; payload: Record<string, unknown> };
  assert.equal(envelope.method, "sendEvaSticker");
  assert.equal(envelope.chatId, 42);
  assert.deepEqual(envelope.payload, { chat_id: 42, intent: "support" });
  assert.doesNotMatch(JSON.stringify(envelope.payload), /file_id|filename|path|url/i);
});

test("send_sticker schema exposes only intent and uses captured turn idempotently", async () => {
  const sent: Array<{ chatId: number; intent: string }> = [];
  const begins: Array<Record<string, unknown>> = [];
  let saved: unknown;
  const runtime = { userId: 7, telegramId: 42, chatId: 999, conversationId: "conv-sticker", purpose: "chat", timezone: "UTC", responseMode: "text", useEmoji: true };
  const effects = {
    begin: async (input: Record<string, unknown>) => { begins.push(input); return begins.length === 1 ? { action: "execute", attempt: 1 } : { action: "replay", result: saved }; },
    succeed: async (_key: string, _userId: number, result: unknown) => { saved = result; }, fail: async () => {},
  };
  const factory = new AgentToolFactory(
    { vectorGoalsEnabled: false, routerUrl: "", routerApiKey: "", telegramStickerCatalog: {} } as never,
    { getAgentRuntimeContext: async () => runtime, getQuotaStatus: async () => [], incrementUsage: async () => 0, withUserScope: async <T>(_scope: unknown, work: () => Promise<T>) => await work() } as never,
    { sendStickerIntent: async (chatId: number, intent: string) => { sent.push({ chatId, intent }); } } as never,
    LOGGER, undefined, undefined, effects as never,
  );
  const sticker = factory.forConversation("conv-sticker").find((entry) => entry.name === "send_sticker")!;
  assert.deepEqual(Object.keys((sticker.parameters as { properties: object }).properties), ["intent"]);
  assert.doesNotMatch(JSON.stringify(sticker.parameters), /file_id|filename|path|url/i);
  const turn = { conversationId: "conv-sticker", runId: "11111111-1111-1111-1111-111111111111", recorded: true, isCancelled: async () => false, chatId: 42, messageId: 5 };
  const first = await runInTurn(turn, async () => await sticker.execute("call-sticker", { intent: "hug" }));
  const second = await runInTurn(turn, async () => await sticker.execute("call-sticker", { intent: "hug" }));
  assert.deepEqual(first.details, { ok: true, intent: "hug" });
  assert.deepEqual(second.details, first.details);
  assert.deepEqual(sent, [{ chatId: 42, intent: "hug" }]);
  assert.equal(begins[0]?.runId, turn.runId);
});

test("Compose/env keep legacy override and Docker packages built-in assets", async (context) => {
  const root = join(import.meta.dirname, "..", "..");
  try { await readFile(join(root, "compose.yaml")); } catch { context.skip("service-only image"); return; }
  const compose = await readFile(join(root, "compose.yaml"), "utf8");
  const example = await readFile(join(root, ".env.example"), "utf8");
  const dockerfile = await readFile(join(root, "eva-agent-service", "Dockerfile"), "utf8");
  assert.match(compose, /EVA_TELEGRAM_STICKER_CATALOG_JSON:/);
  assert.match(example, /^EVA_TELEGRAM_STICKER_CATALOG_JSON=\{\}$/m);
  assert.match(dockerfile, /COPY assets \.\/assets/);
});

function fakeStickerDb(rows: Map<string, { intent: string; file_id: string | null; last_status: string }>) {
  const query = async (sql: string, values: unknown[] = []) => {
    if (/SELECT pg_advisory/u.test(sql)) return { rows: [], rowCount: 1 };
    const key = `${values[0]}:${values[1]}`;
    if (/SELECT intent, file_id/u.test(sql)) { const row = rows.get(key); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; }
    if (/INSERT INTO telegram_sticker_cache/u.test(sql)) { rows.set(key, { intent: String(values[1]), file_id: values[2] as string | null, last_status: String(values[3]) }); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, withSystemScope: async <T>(_reason: string, work: () => Promise<T>) => await work(), transaction: async <T>(work: (client: { query: typeof query }) => Promise<T>) => await work({ query }) };
}
