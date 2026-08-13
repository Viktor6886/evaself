import type { Database, SdkSettingsRow } from "../db.js";
import type { LettaService } from "../letta.js";

interface SettingsReader {
  getSdkSettings(): Promise<Pick<
    SdkSettingsRow,
    "automatic_context_management" | "default_context_window"
  >>;
}

interface ConversationLinkWriter {
  setConversation(agentId: string, conversationId: string, userId?: number): Promise<void>;
}

export interface ActiveConversation {
  agentId: string;
  conversationId: string;
  userId: number;
  messageCount: number;
}

/** Deterministic safety valve: rotate before a conversation exceeds fallback capacity. */
export class ConversationContextManager {
  constructor(
    private readonly settings: SettingsReader,
    private readonly letta: Pick<LettaService, "createConversation" | "configureCompaction">,
    private readonly db: Pick<Database, "setConversation"> | ConversationLinkWriter,
  ) {}

  async beforeTurn(active: ActiveConversation): Promise<string> {
    const settings = await this.settings.getSdkSettings();
    const policy = settings.automatic_context_management;
    if (!policy.enabled) return active.conversationId;
    if (active.messageCount >= policy.rotation_message_threshold) {
      const next = await this.letta.createConversation(active.agentId);
      await this.db.setConversation(active.agentId, next, active.userId);
      return next;
    }
    if (active.messageCount >= policy.compaction_message_threshold) {
      await this.letta.configureCompaction(active.agentId, {
        mode: policy.compaction_mode,
        sliding_window_percentage: policy.sliding_window_percentage,
      });
    }
    return active.conversationId;
  }
}
