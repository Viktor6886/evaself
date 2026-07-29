import type { Database } from "../db.js";

export type SupportedLanguage = "ru" | "en";

export interface LanguageState {
  languageMode: "auto" | "fixed";
  preferredLanguage: string | null;
  lastMessageLanguage: string | null;
  telegramLanguageCode: string | null;
}

export interface LanguageResolution {
  language: SupportedLanguage;
  detected: SupportedLanguage | null;
  fixed: boolean;
}

export class LanguageResolver {
  constructor(private readonly db?: Database) {}

  async resolve(
    userId: number,
    state: LanguageState,
    message: string,
  ): Promise<LanguageResolution> {
    const explicit = explicitLanguageRequest(message);
    const detected = detectMeaningfulLanguage(message);
    const fixedLanguage = normalizeSupportedLanguage(state.preferredLanguage);
    const language = explicit ??
      (state.languageMode === "fixed" ? fixedLanguage : null) ??
      detected ??
      normalizeSupportedLanguage(state.lastMessageLanguage) ??
      normalizeSupportedLanguage(state.telegramLanguageCode) ??
      "ru";

    if (this.db && (explicit || detected)) {
      await this.db.query(
        `UPDATE users
            SET language_mode = CASE WHEN $2::text IS NOT NULL THEN 'fixed' ELSE language_mode END,
                preferred_language = COALESCE($2, preferred_language),
                last_message_language = COALESCE($3, last_message_language),
                language_updated_at = now()
          WHERE id = $1`,
        [userId, explicit, detected],
      );
    }
    return { language, detected, fixed: Boolean(explicit || state.languageMode === "fixed") };
  }
}

export function detectMeaningfulLanguage(message: string): SupportedLanguage | null {
  const clean = stripNonLinguisticContent(message);
  if (!clean || /^(?:да|нет|ок|okay|yes|no|ok)[.!?…]*$/iu.test(clean)) return null;
  const words = clean.match(/\p{L}+/gu) ?? [];
  const letters = words.join("");
  if (words.length < 2 || letters.length < 6) return null;
  const cyrillic = (letters.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (letters.match(/\p{Script=Latin}/gu) ?? []).length;
  const counted = cyrillic + latin;
  if (counted < 6) return null;
  if (cyrillic / counted >= 0.7) return "ru";
  if (latin / counted >= 0.7) return "en";
  return null;
}

export function explicitLanguageRequest(message: string): SupportedLanguage | null {
  const clean = stripNonLinguisticContent(message).toLowerCase();
  if (
    /(?:отвечай|говори|пиши|переключись).{0,30}(?:на )?(?:английском|английский)/u.test(clean) ||
    /\b(?:reply|respond|speak|write|switch)\b.{0,30}\b(?:in |to )?english\b/u.test(clean)
  ) {
    return "en";
  }
  if (
    /(?:отвечай|говори|пиши|переключись).{0,30}(?:на )?(?:русском|русский)/u.test(clean) ||
    /\b(?:reply|respond|speak|write|switch)\b.{0,30}\b(?:in |to )?russian\b/u.test(clean)
  ) {
    return "ru";
  }
  return null;
}

export function normalizeSupportedLanguage(value: string | null | undefined): SupportedLanguage | null {
  const code = value?.trim().toLowerCase().split(/[-_]/)[0];
  return code === "ru" || code === "en" ? code : null;
}

function stripNonLinguisticContent(message: string): string {
  return message
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
