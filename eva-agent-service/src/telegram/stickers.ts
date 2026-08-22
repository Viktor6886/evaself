export const STICKER_INTENTS = [
  "support", "hug", "laugh", "smile", "surprise", "sad",
  "celebration", "thinking", "love",
] as const;

export type StickerIntent = typeof STICKER_INTENTS[number];

const INTENTS = new Set<string>(STICKER_INTENTS);
const TELEGRAM_FILE_ID = /^[A-Za-z0-9_-]{12,512}$/u;

/** Только серверный file_id. URL, путь и произвольная строка не проходят. */
export function stickerFileId(
  catalog: Readonly<Record<string, unknown>>,
  intent: string,
): string | null {
  if (!INTENTS.has(intent)) return null;
  const value = catalog[intent];
  return typeof value === "string" && TELEGRAM_FILE_ID.test(value) ? value : null;
}
