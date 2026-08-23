import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

export const STICKER_INTENTS = [
  "support", "hug", "laugh", "smile", "surprise", "sad",
  "celebration", "thinking", "love",
] as const;

export type StickerIntent = typeof STICKER_INTENTS[number];

const INTENTS = new Set<string>(STICKER_INTENTS);
const TELEGRAM_FILE_ID = /^[A-Za-z0-9_-]{12,512}$/u;

export type StickerCatalogStatus = "ready" | "empty" | "invalid";

export type StickerRuntimeState =
  | "ready"
  | "using_cached_file_ids"
  | "using_local_assets"
  | "asset_missing"
  | "telegram_upload_failed";

export interface StickerRuntimeDiagnostics {
  status: StickerRuntimeState;
  sources: StickerRuntimeState[];
  missingIntents: StickerIntent[];
  failedIntents: StickerIntent[];
}

export interface StickerCatalogInspection {
  status: StickerCatalogStatus;
  availableIntents: StickerIntent[];
  invalidEntries: string[];
}

/** Validate intent names and bot-owned file_id values without exposing the IDs. */
export function inspectStickerCatalog(value: unknown): StickerCatalogInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", availableIntents: [], invalidEntries: ["catalog"] };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return { status: "empty", availableIntents: [], invalidEntries: [] };
  }
  const availableIntents: StickerIntent[] = [];
  const invalidEntries: string[] = [];
  for (const [intent, fileId] of entries) {
    if (!INTENTS.has(intent) || typeof fileId !== "string" || !TELEGRAM_FILE_ID.test(fileId)) {
      invalidEntries.push(intent);
      continue;
    }
    availableIntents.push(intent as StickerIntent);
  }
  return {
    status: invalidEntries.length > 0 ? "invalid" : "ready",
    availableIntents,
    invalidEntries,
  };
}

/** Только серверный file_id. URL, путь и произвольная строка не проходят. */
export function stickerFileId(
  catalog: unknown,
  intent: string,
): string | null {
  if (!INTENTS.has(intent)) return null;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return null;
  const value = (catalog as Readonly<Record<string, unknown>>)[intent];
  return typeof value === "string" && TELEGRAM_FILE_ID.test(value) ? value : null;
}

interface CachedStickerRow {
  intent: string;
  file_id: string | null;
  last_status: string;
}

interface StickerUploadResult {
  sticker?: { file_id?: string };
}

const DEFAULT_ASSET_DIR = fileURLToPath(new URL("../../assets/stickers/", import.meta.url));

export function stickerBotIdentity(token: string): string {
  const botId = /^(\d+):/u.exec(token)?.[1];
  return botId ? `bot:${botId}` : `token:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
}

/** Validate the static WEBP constraints Telegram applies to uploaded stickers. */
export function inspectStickerAsset(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 30 || bytes.byteLength > 512 * 1024) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("ascii", 12, 16);
  let width = 0;
  let height = 0;
  if (chunk === "VP8X" && buffer.length >= 30) {
    width = 1 + buffer.readUIntLE(24, 3);
    height = 1 + buffer.readUIntLE(27, 3);
  } else if (chunk === "VP8 " && buffer.length >= 30 && buffer.toString("hex", 23, 26) === "9d012a") {
    width = buffer.readUInt16LE(26) & 0x3fff;
    height = buffer.readUInt16LE(28) & 0x3fff;
  } else if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  }
  return width > 0 && height > 0 && width <= 512 && height <= 512
    && (width === 512 || height === 512) ? { width, height } : null;
}

export class TelegramStickerCatalog {
  private readonly botIdentity: string;
  private readonly memoryCache = new Map<StickerIntent, string>();
  private readonly failed = new Set<StickerIntent>();

  constructor(
    private readonly catalog: unknown,
    token: string,
    private readonly db: Database | null,
    private readonly logger: Logger,
    private readonly assetDir = DEFAULT_ASSET_DIR,
  ) {
    this.botIdentity = stickerBotIdentity(token);
  }

  async send(
    intentValue: string,
    sendFileId: (fileId: string) => Promise<unknown>,
    upload: (bytes: Uint8Array, filename: string) => Promise<StickerUploadResult>,
  ): Promise<unknown> {
    if (!INTENTS.has(intentValue)) {
      return { ok: false, reason: "sticker_unavailable", catalog_status: "unknown_intent" };
    }
    const intent = intentValue as StickerIntent;
    const legacy = stickerFileId(this.catalog, intent);
    if (legacy) return await sendFileId(legacy);

    const cached = await this.cachedFileId(intent);
    if (cached) return await sendFileId(cached);

    const asset = await this.asset(intent);
    if (!asset) {
      return { ok: false, reason: "sticker_unavailable", catalog_status: "asset_missing" };
    }

    if (!this.db) return await this.uploadAndCache(intent, asset, upload);
    try {
      return await this.db.withSystemScope(
        "telegram.sticker.upload",
        async () => await this.db!.transaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
            `telegram-sticker:${this.botIdentity}:${intent}`,
          ]);
          const { rows } = await client.query<CachedStickerRow>(
            `SELECT intent, file_id, last_status FROM telegram_sticker_cache
              WHERE bot_identity = $1 AND intent = $2`,
            [this.botIdentity, intent],
          );
          const stored = rows[0]?.file_id;
          if (stored && TELEGRAM_FILE_ID.test(stored)) {
            this.memoryCache.set(intent, stored);
            return await sendFileId(stored);
          }
          return await this.uploadAndCache(intent, asset, upload, client);
        }),
        { crossUser: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.withSystemScope(
        "telegram.sticker.upload.failure",
        async () => await this.store(intent, null, "telegram_upload_failed", message),
        { crossUser: true },
      ).catch(() => undefined);
      throw error;
    }
  }

  async diagnostics(): Promise<StickerRuntimeDiagnostics> {
    const cached = new Set<StickerIntent>(this.memoryCache.keys());
    if (this.db) {
      const rows = await this.db.withSystemScope(
        "telegram.sticker.diagnostics",
        async () => (await this.db!.query<CachedStickerRow>(
          `SELECT intent, file_id, last_status FROM telegram_sticker_cache WHERE bot_identity = $1`,
          [this.botIdentity],
        )).rows,
        { crossUser: true },
      ).catch(() => [] as CachedStickerRow[]);
      for (const row of rows) {
        if (INTENTS.has(row.intent) && row.file_id && TELEGRAM_FILE_ID.test(row.file_id)) {
          cached.add(row.intent as StickerIntent);
        }
        if (INTENTS.has(row.intent) && row.last_status === "telegram_upload_failed") {
          this.failed.add(row.intent as StickerIntent);
        }
      }
    }
    const missingIntents: StickerIntent[] = [];
    let local = false;
    for (const intent of STICKER_INTENTS) {
      if (stickerFileId(this.catalog, intent) || cached.has(intent)) continue;
      if (await this.asset(intent)) local = true;
      else missingIntents.push(intent);
    }
    const sources: StickerRuntimeState[] = [];
    if (cached.size > 0) sources.push("using_cached_file_ids");
    if (local) sources.push("using_local_assets");
    const failedIntents = [...this.failed];
    const status: StickerRuntimeState = failedIntents.length > 0
      ? "telegram_upload_failed"
      : missingIntents.length > 0
        ? "asset_missing"
        : "ready";
    return { status, sources, missingIntents, failedIntents };
  }

  private async cachedFileId(intent: StickerIntent): Promise<string | null> {
    const memory = this.memoryCache.get(intent);
    if (memory) return memory;
    if (!this.db) return null;
    const rows = await this.db.withSystemScope(
      "telegram.sticker.cache",
      async () => (await this.db!.query<CachedStickerRow>(
        `SELECT intent, file_id, last_status FROM telegram_sticker_cache
          WHERE bot_identity = $1 AND intent = $2`,
        [this.botIdentity, intent],
      )).rows,
      { crossUser: true },
    );
    const fileId = rows[0]?.file_id;
    if (!fileId || !TELEGRAM_FILE_ID.test(fileId)) return null;
    this.memoryCache.set(intent, fileId);
    return fileId;
  }

  private async asset(intent: StickerIntent): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(await readFile(`${this.assetDir}/${intent}.webp`));
      return inspectStickerAsset(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }

  private async uploadAndCache(
    intent: StickerIntent,
    asset: Uint8Array,
    upload: (bytes: Uint8Array, filename: string) => Promise<StickerUploadResult>,
    client?: { query: Database["query"] },
  ): Promise<unknown> {
    let result: StickerUploadResult;
    try {
      result = await upload(asset, `${intent}.webp`);
      const fileId = result.sticker?.file_id;
      if (!fileId || !TELEGRAM_FILE_ID.test(fileId)) {
        throw new Error("Telegram sendSticker upload did not return sticker.file_id");
      }
      this.memoryCache.set(intent, fileId);
      this.failed.delete(intent);
    } catch (error) {
      this.failed.add(intent);
      const message = error instanceof Error ? error.message : String(error);
      await this.store(intent, null, "telegram_upload_failed", message, client).catch(() => undefined);
      this.logger.warn("Telegram sticker upload failed", { intent, reason: "telegram_upload_failed", message });
      throw error;
    }
    const fileId = result.sticker!.file_id!;
    await this.store(intent, fileId, "using_cached_file_ids", null, client).catch((error: unknown) => {
      this.logger.warn("Telegram sticker file_id cache was not persisted", {
        intent,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return result;
  }

  private async store(
    intent: StickerIntent,
    fileId: string | null,
    status: StickerRuntimeState,
    error: string | null,
    client?: { query: Database["query"] },
  ): Promise<void> {
    if (!this.db) return;
    const query = client?.query.bind(client) ?? this.db.query.bind(this.db);
    await query(
      `INSERT INTO telegram_sticker_cache (bot_identity, intent, file_id, last_status, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (bot_identity, intent) DO UPDATE
         SET file_id = EXCLUDED.file_id,
             last_status = EXCLUDED.last_status,
             last_error = EXCLUDED.last_error,
             updated_at = now()`,
      [this.botIdentity, intent, fileId, status, error?.slice(0, 1_000) ?? null],
    );
  }
}
