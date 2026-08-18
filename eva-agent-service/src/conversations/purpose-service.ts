import type { Database } from "../db.js";
import type { LettaService } from "../letta.js";
import type { Logger } from "../logger.js";

/**
 * Закрытый список назначений. Совпадает с ограничением
 * `agent_conversations_purpose_check`.
 *
 * Список именно значением, а не только типом: административный обзор
 * политик обязан перечислить все назначения, а тип во время выполнения не
 * существует. Второй такой список рядом означал бы, что назначение можно
 * добавить в одном месте и потерять в другом.
 */
export const CONVERSATION_PURPOSES = [
  "chat",
  "scheduler",
  "profile",
  "goal_review",
  "partner_analysis",
  "research",
] as const;

export type ConversationPurpose = (typeof CONVERSATION_PURPOSES)[number];

export interface PurposeConversation {
  conversationId: string;
  purpose: ConversationPurpose;
  created: boolean;
}

const PURPOSE_TEXT: Record<ConversationPurpose, { summary: string; description: string }> = {
  chat: {
    summary: "Основной диалог",
    description: "Пользовательский Telegram-диалог",
  },
  scheduler: {
    summary: "Планировщик",
    description: "Напоминания и уместные запланированные сообщения без изменения профиля",
  },
  profile: {
    summary: "Дополнение профиля",
    description: "Кандидаты профиля без вмешательства в основной диалог",
  },
  goal_review: {
    summary: "Обзор целей",
    description: "Ревизии целей и предложения следующего малого шага",
  },
  partner_analysis: {
    summary: "Совместный анализ",
    description: "Изолированный анализ с участием партнёра",
  },
  research: {
    summary: "Исследование",
    description: "Поиск информации без опасных операций и изменения профиля",
  },
};

export class ConversationPurposeService {
  private readonly pending = new Map<string, Promise<PurposeConversation>>();

  constructor(
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly logger: Logger,
  ) {}

  async ensure(input: {
    userId: number;
    agentId: string;
    purpose: Exclude<ConversationPurpose, "chat">;
    parentConversationId?: string | null;
  }): Promise<PurposeConversation> {
    const key = `${input.userId}:${input.agentId}:${input.purpose}`;
    const existingPending = this.pending.get(key);
    if (existingPending) return await existingPending;
    const operation = this.ensureInternal(input).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return await operation;
  }

  async find(
    userId: number,
    agentId: string,
    purpose: ConversationPurpose,
  ): Promise<PurposeConversation | null> {
    const { rows } = await this.db.query<{ conversation_id: string }>(
      `SELECT conversation_id
         FROM agent_conversations
        WHERE user_id = $1
          AND agent_id = $2
          AND purpose = $3
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [userId, agentId, purpose],
    );
    return rows[0]
      ? { conversationId: rows[0].conversation_id, purpose, created: false }
      : null;
  }

  private async ensureInternal(input: {
    userId: number;
    agentId: string;
    purpose: Exclude<ConversationPurpose, "chat">;
    parentConversationId?: string | null;
  }): Promise<PurposeConversation> {
    const existing = await this.find(input.userId, input.agentId, input.purpose);
    if (existing) return existing;
    const parentConversationId =
      input.parentConversationId ??
      (await this.find(input.userId, input.agentId, "chat"))?.conversationId ??
      null;
    const text = PURPOSE_TEXT[input.purpose];
    const created = await this.letta.createConversationRecord(input.agentId, {
      summary: text.summary,
      description: text.description,
      hidden: true,
    }) as { id?: string };
    if (!created.id) throw new Error("Letta App Server не вернул ID служебного conversation");
    try {
      await this.db.query(
        `INSERT INTO agent_conversations (
           user_id, agent_id, conversation_id, purpose,
           parent_conversation_id, last_handoff_at, title, meta
         ) VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb)
         ON CONFLICT (conversation_id) DO UPDATE SET
           status = 'active',
           archived_at = NULL,
           purpose = EXCLUDED.purpose,
           parent_conversation_id = EXCLUDED.parent_conversation_id,
           last_handoff_at = now()
         RETURNING conversation_id`,
        [
          input.userId,
          input.agentId,
          created.id,
          input.purpose,
          parentConversationId,
          text.summary,
          JSON.stringify({ purpose_policy: purposePolicy(input.purpose) }),
        ],
      );
      this.logger.info("Создан служебный conversation", {
        userId: input.userId,
        agentId: input.agentId,
        conversationId: created.id,
        purpose: input.purpose,
      });
      return { conversationId: created.id, purpose: input.purpose, created: true };
    } catch (error) {
      // A second service instance may have won the partial unique index race.
      // Preserve one authoritative purpose conversation and archive the orphan
      // through the official SDK.
      const raced = await this.find(input.userId, input.agentId, input.purpose);
      if (!raced) throw error;
      await this.letta.updateConversation(created.id, { archived: true }).catch(() => undefined);
      return raced;
    }
  }
}

export function purposePolicy(purpose: ConversationPurpose): {
  canSendToUser: boolean;
  canChangeProfile: boolean;
  allowedTools: string[] | null;
} {
  switch (purpose) {
    case "chat":
      return { canSendToUser: true, canChangeProfile: true, allowedTools: null };
    case "scheduler":
      return { canSendToUser: true, canChangeProfile: false, allowedTools: [] };
    case "profile":
      return {
        canSendToUser: false,
        canChangeProfile: true,
        allowedTools: [
          "upsert_user_profile_field",
          "mark_profile_field_asked",
          "get_user_profile",
        ],
      };
    case "goal_review":
      return {
        canSendToUser: false,
        canChangeProfile: false,
        allowedTools: ["get_goal_context", "record_goal_review"],
      };
    case "research":
      return {
        canSendToUser: false,
        canChangeProfile: false,
        allowedTools: ["web_search", "PERPLEXITY_SEARCH", "brave_search"],
      };
    case "partner_analysis":
      return {
        canSendToUser: false,
        canChangeProfile: false,
        allowedTools: ["get_user_profile", "get_goal_context"],
      };
  }
}

export function toolAllowedForPurpose(
  purpose: ConversationPurpose,
  toolName: string,
): boolean {
  const allowed = purposePolicy(purpose).allowedTools;
  return allowed === null || allowed.includes(toolName);
}
