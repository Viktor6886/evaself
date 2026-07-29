import type { Database } from "../db.js";
import {
  LanguageResolver,
  type SupportedLanguage,
} from "../i18n/language-resolver.js";
import { localNow } from "../time/local-date-time.js";

export interface RuntimeContext {
  userId: number;
  telegramId: number;
  agentId: string;
  conversationId: string;
  localTime: string;
  timezone: string;
  city: string | null;
  countryCode: string | null;
  responseLanguage: SupportedLanguage;
  responseMode: "text" | "voice" | "both";
  useEmoji: boolean;
  communicationStyle: string | null;
  profileHint: string | null;
  activeGoal: string | null;
  nextResult: string | null;
  nextStep: string | null;
  relevantMemory: string[];
}

interface RuntimeContextRow {
  user_id: string;
  telegram_id: string;
  language_code: string | null;
  language_mode: "auto" | "fixed";
  preferred_language: string | null;
  last_message_language: string | null;
  timezone: string;
  city: string | null;
  country_code: string | null;
  agent_id: string;
  conversation_id: string;
  response_mode: "text" | "voice" | "both";
  use_emoji: boolean;
  communication_style: string | null;
}

export class RuntimeContextBuilder {
  private readonly languageResolver: LanguageResolver;
  private readonly cache = new Map<string, { expiresAt: number; row: RuntimeContextRow }>();

  constructor(
    private readonly db: Database,
    private readonly options: {
      defaultTimezone: string;
      cacheTtlMs?: number;
      maxContextCharacters?: number;
      now?: () => Date;
    },
  ) {
    this.languageResolver = new LanguageResolver(db);
  }

  async build(input: {
    userId: number;
    conversationId: string;
    userMessage: string;
    languageMessage?: string;
    relevantMemory?: string[];
    detectLanguage?: boolean;
  }): Promise<RuntimeContext> {
    const row = await this.load(input.userId, input.conversationId);
    const language = await this.languageResolver.resolve(
      input.userId,
      {
        languageMode: row.language_mode,
        preferredLanguage: row.preferred_language,
        lastMessageLanguage: row.last_message_language,
        telegramLanguageCode: row.language_code,
      },
      input.detectLanguage === false
        ? ""
        : (input.languageMessage ?? input.userMessage),
    );
    if (language.detected) row.last_message_language = language.detected;
    if (language.fixed && row.language_mode !== "fixed") {
      row.language_mode = "fixed";
      row.preferred_language = language.language;
    }
    const timezone = validTimezoneOr(row.timezone, this.options.defaultTimezone);
    const local = localNow(timezone, this.options.now?.() ?? new Date());
    return {
      userId: Number(row.user_id),
      telegramId: Number(row.telegram_id),
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      localTime: local.toISO({ suppressMilliseconds: true }) ?? local.toUTC().toISO()!,
      timezone,
      city: row.city,
      countryCode: row.country_code,
      responseLanguage: language.language,
      responseMode: row.response_mode,
      useEmoji: row.use_emoji,
      communicationStyle: row.communication_style,
      profileHint: null,
      activeGoal: null,
      nextResult: null,
      nextStep: null,
      relevantMemory: (input.relevantMemory ?? []).slice(0, 5),
    };
  }

  wrapUserMessage(context: RuntimeContext, userMessage: string): string {
    const fields: Array<[string, string | null]> = [
      ["local_time", context.localTime],
      ["timezone", context.timezone],
      ["city", context.city],
      ["response_language", context.responseLanguage],
      ["response_mode", context.responseMode],
      ["communication_style", context.communicationStyle],
      ["profile_hint", context.profileHint],
      ["active_goal", context.activeGoal],
      ["next_result", context.nextResult],
      ["next_step", context.nextStep],
    ];
    const lines = fields
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => `${key}: ${escapeContextValue(value)}`);
    if (context.relevantMemory.length > 0) {
      lines.push(
        "relevant_memory:",
        ...context.relevantMemory.map((item) => `  - ${escapeContextValue(item)}`),
      );
    }
    const limit = Math.max(1_000, this.options.maxContextCharacters ?? 6_000);
    const contextBlock = lines.join("\n").slice(0, limit);
    return [
      "<EVA_RUNTIME_CONTEXT>",
      contextBlock,
      "</EVA_RUNTIME_CONTEXT>",
      "",
      "<USER_MESSAGE>",
      escapeUserMessage(userMessage),
      "</USER_MESSAGE>",
    ].join("\n");
  }

  invalidate(userId: number): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}:`)) this.cache.delete(key);
    }
  }

  private async load(userId: number, conversationId: string): Promise<RuntimeContextRow> {
    const key = `${userId}:${conversationId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.row;
    const { rows } = await this.db.query<RuntimeContextRow>(
      `SELECT
          u.id AS user_id,
          u.telegram_id,
          u.language_code,
          u.language_mode,
          u.preferred_language,
          u.last_message_language,
          COALESCE(NULLIF(u.timezone, ''), $3) AS timezone,
          u.city,
          u.country_code,
          a.agent_id,
          a.conversation_id,
          COALESCE(p.response_mode, 'text') AS response_mode,
          COALESCE(p.use_emoji, true) AS use_emoji,
          p.character AS communication_style
        FROM users u
        JOIN agent_links a
          ON a.user_id = u.id
         AND a.kind = 'eva'
         AND a.status = 'active'
         AND a.conversation_id = $2
        LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId, conversationId, this.options.defaultTimezone],
    );
    const row = rows[0];
    if (!row) throw new Error("Не найден runtime-контекст пользователя и conversation");
    this.cache.set(key, {
      expiresAt: Date.now() + Math.max(1_000, this.options.cacheTtlMs ?? 45_000),
      row,
    });
    return row;
  }
}

function validTimezoneOr(value: string, fallback: string): string {
  for (const candidate of [value, fallback, "UTC"]) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
      return candidate;
    } catch {
      // Try the next trusted fallback.
    }
  }
  return "UTC";
}

function escapeContextValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function escapeUserMessage(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
