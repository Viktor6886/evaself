export const STICKER_INTENTS = [
  "support", "hug", "laugh", "smile", "surprise", "sad",
  "celebration", "thinking", "love",
] as const;

export type StickerIntent = typeof STICKER_INTENTS[number];

const INTENTS = new Set<string>(STICKER_INTENTS);
const TELEGRAM_FILE_ID = /^[A-Za-z0-9_-]{12,512}$/u;

export type StickerCatalogStatus = "ready" | "empty" | "invalid";

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
