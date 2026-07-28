/**
 * The only place in Evaself that talks to Letta.
 *
 * Everything goes through the official `@letta-ai/letta-agent-sdk` against a
 * self-hosted Letta App Server (`letta server --listen ws://…`). There is no
 * hand-written REST client any more, and nothing else in the stack is
 * allowed to reach the App Server directly.
 */

import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import type {
  AnyAgentTool,
  CreateAgentOptions,
  DreamingOptions,
  LettaCodeSession,
  LettaCodeClientSessionOptions,
  ListMessagesResult,
  PermissionMode,
  SDKMessage,
  SendMessage,
  SkillSource,
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

export interface EvaMemoryBlock {
  label: string;
  value: string;
  description?: string | null;
  read_only?: boolean;
  hidden?: boolean | null;
  limit?: number;
}

export interface RuntimeSdkSettings {
  agent_name_prefix: string;
  default_description: string;
  default_persona: string;
  default_human_template: string;
  default_tags: string[];
  permissionMode: PermissionMode;
  memfs_enabled: boolean;
  system_prompt: string | null;
  base_tools: string[] | null;
  allowed_tools: string[] | null;
  disallowed_tools: string[];
  skillSources: SkillSource[];
  system_info_reminder: boolean;
  dreaming: Record<string, unknown>;
  model_settings: Record<string, unknown>;
  default_context_window: number | null;
  conversation_summary: string;
  conversation_description: string;
  conversation_hidden: boolean;
  create_conversation: boolean;
  session_pool_size: number;
  session_idle_ms: number;
  turn_timeout_ms: number;
  app_server_request_timeout_ms: number;
}

export interface ManagedAgentInput {
  name: string;
  description?: string;
  persona?: string;
  human?: string;
  memory?: EvaMemoryBlock[];
  tags?: string[];
  model?: string;
  model_settings?: Record<string, unknown>;
  context_window?: number | null;
  permission_mode?: PermissionMode;
  memfs_enabled?: boolean;
  system_prompt?: string | null;
  base_tools?: string[] | null;
  allowed_tools?: string[] | null;
  disallowed_tools?: string[];
  skill_sources?: SkillSource[];
  system_info_reminder?: boolean;
  dreaming?: Record<string, unknown>;
  create_conversation?: boolean;
}

/**
 * Collapses the SDK's message stream into the fields the runtime and WebUI need.
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
  private client: LettaAgentClient;
  private readonly sessions = new Map<string, PooledSession>();

  private readonly config: Config;
  private readonly logger: Logger;
  private persona: string;
  private defaultModel: string;
  private runtime: RuntimeSdkSettings;
  private toolFactory: ((conversationId: string) => AnyAgentTool[]) | null = null;

  constructor(config: Config, logger: Logger, persona: string) {
    this.config = config;
    this.logger = logger;
    this.persona = persona;
    this.defaultModel = config.model;
    this.runtime = {
      agent_name_prefix: "eva",
      default_description: "Агент Evaself",
      default_persona: persona,
      default_human_template: "Имя: {{display_name}}\nTelegram ID: {{telegram_id}}",
      default_tags: [EVASELF_TAG],
      permissionMode: "unrestricted",
      memfs_enabled: true,
      system_prompt: null,
      base_tools: null,
      allowed_tools: null,
      disallowed_tools: [],
      skillSources: ["bundled", "global", "agent", "project"],
      system_info_reminder: false,
      dreaming: { trigger: "off" },
      model_settings: {},
      default_context_window: null,
      conversation_summary: "Новый диалог",
      conversation_description: "",
      conversation_hidden: false,
      create_conversation: true,
      session_pool_size: config.sessionPoolSize,
      session_idle_ms: config.sessionIdleMs,
      turn_timeout_ms: config.turnTimeoutMs,
      app_server_request_timeout_ms: config.appServerRequestTimeoutMs,
    };
    this.client = this.createClient();
  }

  private createClient(): LettaAgentClient {
    return new LettaAgentClient({
      backend: "remote",
      url: this.config.appServerUrl,
      ...(this.config.appServerToken ? { authToken: this.config.appServerToken } : {}),
      requestTimeoutMs: this.runtime.app_server_request_timeout_ms,
    });
  }

  resetClient(): void {
    this.closeAllSessions();
    this.client = this.createClient();
  }

  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  setToolFactory(factory: (conversationId: string) => AnyAgentTool[]): void {
    this.toolFactory = factory;
    this.closeAllSessions();
  }

  get currentPersona(): string {
    return this.persona;
  }

  applySdkSettings(settings: RuntimeSdkSettings): void {
    const reconnect =
      settings.app_server_request_timeout_ms !== this.runtime.app_server_request_timeout_ms;
    this.runtime = settings;
    this.persona = settings.default_persona || this.persona;
    this.closeAllSessions();
    if (reconnect) this.client = this.createClient();
  }

  // -----------------------------------------------------------------
  // health
  // -----------------------------------------------------------------

  /** Cheap round trip that proves the WebSocket and the protocol both work. */
  async ping(): Promise<{ ok: true; models: number } | { ok: false; error: string }> {
    try {
      // agents.list proves WebSocket + protocol even when a provider does not
      // implement /models and its model name was entered manually.
      await this.client.agents.list({ limit: 1 });
      try {
        const models = await this.client.models.list();
        return { ok: true, models: models.entries?.length ?? 0 };
      } catch {
        return { ok: true, models: -1 };
      }
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
      name: `${this.runtime.agent_name_prefix}-${input.telegramId}`,
      description:
        this.runtime.default_description ||
        `Агент Evaself для пользователя Telegram ${input.telegramId}`,
      persona: this.runtime.default_persona || this.persona,
      human:
        input.human ??
        this.runtime.default_human_template
          .replaceAll("{{display_name}}", input.displayName)
          .replaceAll("{{telegram_id}}", String(input.telegramId)),
      tags: [...new Set([
        ...this.runtime.default_tags,
        EVASELF_TAG,
        EVA_AGENT_TAG,
        "psychology",
        "self-knowledge",
        telegramTag(input.telegramId),
      ])],
      permissionMode: this.runtime.permissionMode,
      memfs: this.runtime.memfs_enabled,
      skillSources: this.runtime.skillSources,
      dreaming: this.runtime.dreaming as DreamingOptions,
      memory: evaMemoryBlocks(),
      ...(this.runtime.system_prompt ? { systemPrompt: this.runtime.system_prompt } : {}),
      ...(this.runtime.base_tools !== null ? { baseTools: this.runtime.base_tools } : {}),
      ...(this.defaultModel ? { model: this.defaultModel } : {}),
    };

    try {
      const agentId = await this.client.createAgent(options);
      if (
        Object.keys(this.runtime.model_settings).length > 0 ||
        this.runtime.default_context_window !== null
      ) {
        await this.client.agents.update(agentId, {
          ...(Object.keys(this.runtime.model_settings).length > 0
            ? { modelSettings: this.runtime.model_settings }
            : {}),
          ...(this.runtime.default_context_window !== null
            ? { contextWindowLimit: this.runtime.default_context_window }
            : {}),
        } as never);
      }
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

  async getConversation(conversationId: string): Promise<unknown> {
    try {
      return await this.client.conversations.retrieve(conversationId);
    } catch (error) {
      throw toEvaError(error, `retrieving conversation ${conversationId}`);
    }
  }

  async createConversationRecord(
    agentId: string,
    input: {
      summary?: string;
      description?: string;
      model?: string;
      model_settings?: Record<string, unknown>;
      context_window?: number | null;
      hidden?: boolean;
    } = {},
  ): Promise<unknown> {
    try {
      const modelSettings = input.model_settings ?? this.runtime.model_settings;
      const contextWindow = input.context_window ?? this.runtime.default_context_window;
      return await this.client.conversations.create({
        agentId,
        summary: input.summary ?? this.runtime.conversation_summary,
        description: input.description ?? this.runtime.conversation_description,
        ...(input.model ?? this.defaultModel ? { model: input.model ?? this.defaultModel } : {}),
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        ...(contextWindow !== null ? { contextWindowLimit: contextWindow } : {}),
        hidden: input.hidden ?? this.runtime.conversation_hidden,
      } as never);
    } catch (error) {
      throw toEvaError(error, `creating a conversation for ${agentId}`);
    }
  }

  async updateConversation(
    conversationId: string,
    input: {
      summary?: string;
      description?: string;
      model?: string;
      model_settings?: Record<string, unknown>;
      context_window?: number | null;
      archived?: boolean;
    },
  ): Promise<unknown> {
    this.closeSession(conversationId);
    try {
      return await this.client.conversations.update(conversationId, {
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.model_settings !== undefined ? { modelSettings: input.model_settings } : {}),
        ...(input.context_window !== undefined
          ? { contextWindowLimit: input.context_window }
          : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      } as never);
    } catch (error) {
      throw toEvaError(error, `updating conversation ${conversationId}`);
    }
  }

  /** Open a brand new conversation and return its id. */
  async createConversation(agentId: string): Promise<string> {
    try {
      const conversation = await this.createConversationRecord(agentId) as { id?: string };
      const conversationId = conversation.id;
      if (!conversationId) {
        throw toEvaError(new Error("app server returned no conversation id"), "creating a conversation");
      }
      this.logger.info("created conversation", { agentId, conversationId });
      return conversationId;
    } catch (error) {
      throw toEvaError(error, "creating a conversation");
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
      session = this.client.resumeSession(conversationId, this.sessionOptions(conversationId));
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
      if (now - pooled.lastUsedAt > this.runtime.session_idle_ms) {
        this.closeSession(id);
      }
    }
    while (this.sessions.size >= this.runtime.session_pool_size) {
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
   * timeout) and return a single object. `onDelta` lets a caller forward
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
      const deadline = startedAt + this.runtime.turn_timeout_ms;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await session.abort().catch(() => undefined);
          throw turnTimeout(`the agent did not finish within ${this.runtime.turn_timeout_ms} ms`);
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

  /**
   * Prove that the restarted App Server has discovered the selected model.
   * A generic protocol ping is insufficient: the dynamic model catalog may
   * still be refreshing, or the configured endpoint may not expose this ID.
   */
  async waitForModel(handle: string, attempts = 20): Promise<void> {
    let available: string[] = [];
    let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const catalog = await this.client.models.list();
        available = [
          ...(catalog.availableHandles ?? []),
          ...catalog.entries
            .map((entry) => entry.handle)
            .filter((entry): entry is string => typeof entry === "string"),
        ];
        if (available.includes(handle)) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    const suffix = lastError
      ? ` Последняя ошибка каталога: ${lastError}`
      : available.length > 0
        ? ` Доступны: ${[...new Set(available)].slice(0, 20).join(", ")}`
        : " App Server вернул пустой каталог.";
    throw new Error(`Модель ${handle} не появилась в каталоге App Server.${suffix}`);
  }

  /**
   * App Server SDK 0.5.x applies client-side tool policy and runtime controls
   * when a conversation session is opened, not while the persistent agent is
   * created. Keeping that distinction here prevents unsupported create-agent
   * fields from being silently saved but never enforced.
   */
  private sessionOptions(conversationId: string): LettaCodeClientSessionOptions {
    const tools = (this.toolFactory?.(conversationId) ?? []).filter(
      (tool) => !this.runtime.disallowed_tools.includes(tool.name),
    );
    const allowed = this.runtime.allowed_tools?.filter(
      (name) => !this.runtime.disallowed_tools.includes(name),
    ) ?? null;
    return {
      permissionMode: this.runtime.permissionMode,
      skillSources: this.runtime.skillSources,
      dreaming: this.runtime.dreaming as LettaCodeClientSessionOptions["dreaming"],
      ...(tools.length > 0 ? { tools } : {}),
      ...(allowed !== null
        ? { allowedTools: allowed }
        : {}),
    };
  }

  /** Inventory every live App Server agent, including agents created only in WebUI. */
  async listAllModelMappings(): Promise<Array<{ agentId: string; conversationIds: string[] }>> {
    const agents = await this.listAgents() as Array<{ id?: string }>;
    const mappings: Array<{ agentId: string; conversationIds: string[] }> = [];
    for (const agent of agents) {
      if (!agent.id) continue;
      const conversations = await this.listConversations(agent.id) as Array<{ id?: string }>;
      mappings.push({
        agentId: agent.id,
        conversationIds: conversations
          .map((conversation) => conversation.id)
          .filter((id): id is string => Boolean(id)),
      });
    }
    return mappings;
  }

  async applyModelToMappings(
    mappings: Array<{ agentId: string; conversationIds: string[] }>,
    model: string,
    contextWindow: number,
    modelSettings?: Record<string, unknown>,
  ): Promise<void> {
    this.closeAllSessions();
    for (const mapping of mappings) {
      try {
        await this.client.agents.update(mapping.agentId, {
          model,
          contextWindowLimit: contextWindow,
          ...(modelSettings ? { modelSettings } : {}),
        } as never);
        for (const conversationId of mapping.conversationIds) {
          await this.client.conversations.update(conversationId, {
            model,
            contextWindowLimit: contextWindow,
            ...(modelSettings ? { modelSettings } : {}),
          } as never);
        }
      } catch (error) {
        throw toEvaError(error, `updating model for agent ${mapping.agentId}`);
      }
    }
  }

  async getAgent(agentId: string): Promise<unknown> {
    try {
      return await this.client.agents.retrieve(agentId);
    } catch (error) {
      throw toEvaError(error, `retrieving agent ${agentId}`);
    }
  }

  async updateAgent(
    agentId: string,
    input: {
      name?: string;
      description?: string;
      model?: string;
      model_settings?: Record<string, unknown>;
      system?: string;
      tags?: string[];
      hidden?: boolean;
      context_window?: number | null;
    },
  ): Promise<unknown> {
    try {
      this.closeAllSessions();
      return await this.client.agents.update(agentId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.model_settings !== undefined ? { modelSettings: input.model_settings } : {}),
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        ...(input.context_window !== undefined
          ? { contextWindowLimit: input.context_window }
          : {}),
      } as never);
    } catch (error) {
      throw toEvaError(error, `updating agent ${agentId}`);
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      this.closeAllSessions();
      await this.client.agents.delete(agentId);
      this.logger.warn("agent deleted by administrator", { agentId });
    } catch (error) {
      throw toEvaError(error, `deleting agent ${agentId}`);
    }
  }

  async createManagedAgent(input: ManagedAgentInput): Promise<{
    agent: unknown;
    conversation: unknown | null;
  }> {
    const options: CreateAgentOptions = {
      name: input.name,
      description: input.description ?? this.runtime.default_description,
      persona: input.persona ?? this.runtime.default_persona,
      human: input.human ?? "",
      ...(input.memory ? { memory: input.memory } : {}),
      tags: input.tags ?? this.runtime.default_tags,
      permissionMode: input.permission_mode ?? this.runtime.permissionMode,
      memfs: input.memfs_enabled ?? this.runtime.memfs_enabled,
      skillSources: input.skill_sources ?? this.runtime.skillSources,
      dreaming: (input.dreaming ?? this.runtime.dreaming) as DreamingOptions,
      ...(input.system_prompt ?? this.runtime.system_prompt
        ? { systemPrompt: input.system_prompt ?? this.runtime.system_prompt! }
        : {}),
      ...((input.base_tools ?? this.runtime.base_tools) !== null
        ? { baseTools: input.base_tools ?? this.runtime.base_tools! }
        : {}),
      ...(input.model ?? this.defaultModel ? { model: input.model ?? this.defaultModel } : {}),
    };

    try {
      const agentId = await this.client.createAgent(options);
      const modelSettings = input.model_settings ?? this.runtime.model_settings;
      const contextWindow = input.context_window ?? this.runtime.default_context_window;
      if (Object.keys(modelSettings).length > 0 || contextWindow !== null) {
        await this.client.agents.update(agentId, {
          ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
          ...(contextWindow !== null ? { contextWindowLimit: contextWindow } : {}),
        } as never);
      }
      const agent = await this.client.agents.retrieve(agentId);
      const shouldCreate = input.create_conversation ?? this.runtime.create_conversation;
      const conversation = shouldCreate
        ? await this.createConversationRecord(agentId)
        : null;
      this.logger.info("created agent from admin API", { agentId });
      return { agent, conversation };
    } catch (error) {
      throw toEvaError(error, "creating an administrative agent");
    }
  }

  /** Close every pooled session; called on SIGTERM. */
  closeAllSessions(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
  }

  shutdown(): void {
    this.closeAllSessions();
  }

  requireAgent(agentId: string | null | undefined): string {
    if (!agentId) throw notFound("this user has no agent yet");
    return agentId;
  }
}

export function evaMemoryBlocks(): EvaMemoryBlock[] {
  return [
    {
      label: "tools",
      value: [
        "Доступные внешние инструменты выполняются локально через официальный Agent SDK.",
        "Используй заметки для фактов пользователя, задачи — для действий и напоминаний,",
        "бюджет — только по явной просьбе, web_search — когда нужна актуальная информация.",
      ].join(" "),
      description: "Правила использования инструментов Evaself",
      read_only: true,
      limit: 4_000,
    },
    {
      label: "therapy_goals",
      value: "Цели саморефлексии пока не сформулированы.",
      description: "Цели пользователя, сформулированные его словами; не медицинские диагнозы",
      limit: 8_000,
    },
    {
      label: "user_state",
      value: "Актуальное состояние пока не описано.",
      description: "Краткий текущий контекст, эмоции и жизненная ситуация",
      limit: 8_000,
    },
    {
      label: "progress_notes",
      value: "Наблюдений о прогрессе пока нет.",
      description: "Изменения и завершённые шаги без оценочных ярлыков",
      limit: 12_000,
    },
    {
      label: "mental_map",
      value: "Карта значимых людей, тем и связей пока пуста.",
      description: "Связи между людьми, событиями, ценностями и повторяющимися темами",
      limit: 12_000,
    },
    {
      label: "assistant_notes_and_recommendations",
      value: "Рабочих гипотез и рекомендаций пока нет.",
      description: "Осторожные рабочие гипотезы Евы, которые нужно сверять с пользователем",
      limit: 12_000,
    },
  ];
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
