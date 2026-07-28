/**
 * The only place in Evaself that talks to Letta.
 *
 * Everything goes through the official `@letta-ai/letta-agent-sdk` against a
 * self-hosted Letta App Server (`letta server --listen ws://…`). There is no
 * hand-written REST client any more, and nothing else in the stack — n8n
 * included — is allowed to reach the App Server directly.
 */

import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import type {
  CreateAgentOptions,
  LettaCodeSession,
  ListMessagesResult,
  SDKMessage,
  SendMessage,
} from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import { appServerUnavailable, notFound, toEvaError, turnTimeout } from "./errors.js";
import type { Logger } from "./logger.js";

/** Every agent Evaself creates carries these, so they are findable from Letta alone. */
export const EVASELF_TAG = "evaself";
export const EVA_AGENT_TAG = "eva-companion";
export const telegramTag = (telegramId: number | string) => `tg:${telegramId}`;

export interface TurnResult {
  reply: string;
  reasoning: string[];
  toolCalls: string[];
  stopReason: string | null;
  usage: Record<string, unknown> | null;
  messageCount: number;
  agentId: string;
  conversationId: string | null;
  durationMs: number;
}

interface PooledSession {
  session: LettaCodeSession;
  conversationId: string;
  lastUsedAt: number;
  /** Set once bootstrapState() has reconciled a session resumed after a restart. */
  recovered: boolean;
}

/**
 * Collapses the SDK's message stream into the handful of fields n8n needs.
 * The stream carries assistant text, reasoning, tool calls and a final
 * `result`; a Telegram reply only wants the text, but the rest is worth
 * returning for logging and debugging.
 */
export function summarizeStream(messages: SDKMessage[]): Omit<TurnResult, "agentId" | "conversationId" | "durationMs"> {
  const replyParts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: string[] = [];
  let stopReason: string | null = null;
  let usage: Record<string, unknown> | null = null;

  for (const message of messages) {
    switch (message.type) {
      case "assistant": {
        const content = (message as { content?: unknown }).content;
        const text = extractText(content);
        if (text) replyParts.push(text);
        break;
      }
      case "reasoning": {
        const raw = (message as { reasoning?: unknown; content?: unknown });
        const text = extractText(raw.reasoning ?? raw.content);
        if (text) reasoning.push(text);
        break;
      }
      case "tool_call": {
        const name = (message as { name?: string; toolName?: string }).name
          ?? (message as { toolName?: string }).toolName;
        if (name) toolCalls.push(name);
        break;
      }
      case "result": {
        const result = message as { stopReason?: string; stop_reason?: string; usage?: Record<string, unknown>; result?: unknown };
        stopReason = result.stopReason ?? result.stop_reason ?? null;
        usage = result.usage ?? null;
        // Some harness versions put the final text only on the result.
        if (replyParts.length === 0) {
          const text = extractText(result.result);
          if (text) replyParts.push(text);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    reply: replyParts.join("\n\n").trim(),
    reasoning,
    toolCalls,
    stopReason,
    usage,
    messageCount: messages.length,
  };
}

/** SDK content is a string, or a list of content parts. */
export function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const part = item as { type?: string; text?: string };
        if ((part.type === undefined || part.type === "text") && part.text) parts.push(part.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof content === "object") {
    const part = content as { text?: string };
    if (typeof part.text === "string") return part.text;
  }
  return String(content);
}

export class LettaService {
  private readonly client: LettaAgentClient;
  private readonly sessions = new Map<string, PooledSession>();

  private readonly config: Config;
  private readonly logger: Logger;
  private readonly persona: string;

  constructor(config: Config, logger: Logger, persona: string) {
    this.config = config;
    this.logger = logger;
    this.persona = persona;
    this.client = new LettaAgentClient({
      backend: "remote",
      url: config.appServerUrl,
      ...(config.appServerToken ? { authToken: config.appServerToken } : {}),
      requestTimeoutMs: config.appServerRequestTimeoutMs,
    });
  }

  // -----------------------------------------------------------------
  // health
  // -----------------------------------------------------------------

  /** Cheap round trip that proves the WebSocket and the protocol both work. */
  async ping(): Promise<{ ok: true; models: number } | { ok: false; error: string }> {
    try {
      const models = await this.client.models.list();
      return { ok: true, models: models.entries?.length ?? 0 };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -----------------------------------------------------------------
  // agents
  // -----------------------------------------------------------------

  async listAgents(): Promise<unknown[]> {
    try {
      return (await this.client.agents.list({})) as unknown[];
    } catch (error) {
      throw toEvaError(error, "listing agents");
    }
  }

  /**
   * Look an agent up by its Telegram tag. Used when the database was
   * restored without the App Server state, or the other way round.
   */
  async findAgentByTelegramId(telegramId: number): Promise<string | null> {
    try {
      const agents = (await this.client.agents.list({
        tags: [EVASELF_TAG, telegramTag(telegramId)],
        matchAllTags: true,
        limit: 1,
      } as never)) as Array<{ id?: string }>;
      return agents?.[0]?.id ?? null;
    } catch (error) {
      throw toEvaError(error, "finding an agent by telegram id");
    }
  }

  /** Create the personal Eva agent for one Telegram user. */
  async createAgent(input: {
    telegramId: number;
    displayName: string;
    human?: string;
  }): Promise<string> {
    const options: CreateAgentOptions = {
      name: `eva-${input.telegramId}`,
      description: `Eva companion agent for Telegram user ${input.telegramId}`,
      persona: this.persona,
      human:
        input.human ??
        `Name (from Telegram): ${input.displayName}\nTelegram ID: ${input.telegramId}`,
      tags: [EVASELF_TAG, EVA_AGENT_TAG, telegramTag(input.telegramId)],
      // Eva is a companion, not a coding agent: no shell, no file editing.
      permissionMode: "unrestricted",
      memfs: true,
      ...(this.config.model ? { model: this.config.model } : {}),
    };

    try {
      const agentId = await this.client.createAgent(options);
      this.logger.info("created agent", { telegramId: input.telegramId, agentId });
      return agentId;
    } catch (error) {
      throw toEvaError(error, "creating an agent");
    }
  }

  // -----------------------------------------------------------------
  // conversations
  // -----------------------------------------------------------------

  async listConversations(agentId: string): Promise<unknown[]> {
    try {
      return (await this.client.conversations.list({ agentId } as never)) as unknown[];
    } catch (error) {
      throw toEvaError(error, "listing conversations");
    }
  }

  /** Open a brand new conversation and return its id. */
  async createConversation(agentId: string): Promise<string> {
    const session = this.client.createSession(agentId, {});
    try {
      await this.initialize(session);
      const conversationId = session.conversationId;
      if (!conversationId) {
        throw toEvaError(new Error("app server returned no conversation id"), "creating a conversation");
      }
      this.logger.info("created conversation", { agentId, conversationId });
      return conversationId;
    } catch (error) {
      throw toEvaError(error, "creating a conversation");
    } finally {
      session.close();
    }
  }

  // -----------------------------------------------------------------
  // sessions
  // -----------------------------------------------------------------

  /**
   * Resume (or reuse) the session for a conversation.
   *
   * After an App Server or service restart the in-memory pool is empty; the
   * first turn re-opens the conversation and calls bootstrapState() +
   * recoverPendingApprovals() so a turn interrupted by the restart does not
   * hang forever.
   */
  private async acquireSession(conversationId: string): Promise<LettaCodeSession> {
    const pooled = this.sessions.get(conversationId);
    if (pooled) {
      pooled.lastUsedAt = Date.now();
      return pooled.session;
    }

    this.evictIdleSessions();

    let session: LettaCodeSession;
    try {
      session = this.client.resumeSession(conversationId, {});
      await this.initialize(session);
    } catch (error) {
      throw toEvaError(error, `resuming conversation ${conversationId}`);
    }

    try {
      await session.bootstrapState();
      const recovery = await session.recoverPendingApprovals();
      if (recovery?.recovered) {
        this.logger.warn("recovered a pending approval after a restart", { conversationId });
      }
    } catch (error) {
      // Recovery is best effort: a fresh conversation has nothing to recover.
      this.logger.debug("bootstrap/recovery skipped", {
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    this.sessions.set(conversationId, {
      session,
      conversationId,
      lastUsedAt: Date.now(),
      recovered: true,
    });
    return session;
  }

  /** Some session implementations expose initialize(); it is not in the public type. */
  private async initialize(session: LettaCodeSession): Promise<void> {
    const candidate = session as unknown as { initialize?: () => Promise<unknown> };
    if (typeof candidate.initialize === "function") await candidate.initialize();
  }

  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [id, pooled] of this.sessions) {
      if (now - pooled.lastUsedAt > this.config.sessionIdleMs) {
        this.closeSession(id);
      }
    }
    while (this.sessions.size >= this.config.sessionPoolSize) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, pooled] of this.sessions) {
        if (pooled.lastUsedAt < oldestAt) {
          oldestAt = pooled.lastUsedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.closeSession(oldestId);
    }
  }

  closeSession(conversationId: string): void {
    const pooled = this.sessions.get(conversationId);
    if (!pooled) return;
    this.sessions.delete(conversationId);
    try {
      pooled.session.close();
    } catch (error) {
      this.logger.debug("closing a session failed", {
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get openSessions(): number {
    return this.sessions.size;
  }

  // -----------------------------------------------------------------
  // turns
  // -----------------------------------------------------------------

  /**
   * Run one turn and return the collapsed result.
   *
   * The SDK streams; we consume the stream to completion (or until the turn
   * timeout) and hand n8n a single object. `onDelta` lets a caller forward
   * incremental text — used by the streaming endpoint.
   */
  async runTurn(
    conversationId: string,
    message: SendMessage,
    options: { onDelta?: (text: string) => void } = {},
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const session = await this.acquireSession(conversationId);
    const collected: SDKMessage[] = [];

    try {
      await session.send(message);

      const stream = session.stream();
      const deadline = startedAt + this.config.turnTimeoutMs;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await session.abort().catch(() => undefined);
          throw turnTimeout(`the agent did not finish within ${this.config.turnTimeoutMs} ms`);
        }

        const next = await withTimeout(stream.next(), remaining);
        if (next.done) break;

        const sdkMessage = next.value as SDKMessage;
        collected.push(sdkMessage);

        if (options.onDelta && sdkMessage.type === "assistant") {
          const text = extractText((sdkMessage as { content?: unknown }).content);
          if (text) options.onDelta(text);
        }
        if (sdkMessage.type === "error") {
          const detail = (sdkMessage as { message?: string; error?: string });
          throw toEvaError(
            new Error(detail.message ?? detail.error ?? "the agent reported an error"),
            "running a turn",
          );
        }
        if (sdkMessage.type === "result") break;
      }
    } catch (error) {
      // A broken session must not stay in the pool.
      this.closeSession(conversationId);
      throw toEvaError(error, "running a turn");
    }

    const summary = summarizeStream(collected);
    return {
      ...summary,
      agentId: session.agentId ?? "",
      conversationId: session.conversationId ?? conversationId,
      durationMs: Date.now() - startedAt,
    };
  }

  async listMessages(conversationId: string, limit = 50): Promise<ListMessagesResult> {
    const session = await this.acquireSession(conversationId);
    try {
      return await session.listMessages({ limit, order: "desc" } as never);
    } catch (error) {
      throw toEvaError(error, "listing messages");
    }
  }

  async listModels(): Promise<unknown> {
    try {
      return await this.client.models.list();
    } catch (error) {
      throw appServerUnavailable(
        `cannot list models: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Close every pooled session; called on SIGTERM. */
  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
  }

  requireAgent(agentId: string | null | undefined): string {
    if (!agentId) throw notFound("this user has no agent yet");
    return agentId;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(turnTimeout(`stream stalled for ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
