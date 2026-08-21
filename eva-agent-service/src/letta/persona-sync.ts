import { createHash } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { evaMemoryBlocks } from "./memory-blocks.js";

export type CanonicalSyncStatus = "ok" | "degraded" | "unsupported" | "failed" | "never";

export interface PersonaSyncState {
  status: CanonicalSyncStatus;
  version: string;
  lastRunAt: string | null;
  updated: number;
  upToDate: number;
  failed: number;
  unsupported: number;
  staleAgents: number;
}

export interface PersonaSyncResult {
  checked: number;
  updated: number;
  upToDate: number;
  failed: number;
  unsupported: number;
  version: string;
}

export interface LegacyBlockRecord {
  id: string;
  label: string;
  description: string | null;
  size: number;
  status: "legacy_pending_migration";
}

interface CanonicalRuntime {
  updateAgentSystemPrompt(agentId: string, systemPrompt: string): Promise<boolean>;
  updateAgentPersona(agentId: string, conversationId: string, persona: string): Promise<boolean>;
}

const state: PersonaSyncState = {
  status: "never",
  version: "",
  lastRunAt: null,
  updated: 0,
  upToDate: 0,
  failed: 0,
  unsupported: 0,
  staleAgents: 0,
};

export function personaSyncState(): PersonaSyncState {
  return { ...state };
}

/** Fingerprint of every repository-managed runtime context component. */
export function canonicalMemoryVersion(persona: string, systemPrompt = ""): string {
  const managedBlocks = evaMemoryBlocks(persona)
    .filter((block) => block.label === "persona" || block.label === "therapeutic_framework")
    .map((block) => `${block.label}\n${block.value}`)
    .join("\n---\n");
  return createHash("sha256")
    .update(`${systemPrompt}\n---\n${managedBlocks}`)
    .digest("hex")
    .slice(0, 12);
}

export class PersonaSync {
  private readonly inFlight = new Map<string, Promise<"updated" | "up_to_date" | "failed" | "unsupported">>();

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly runtime: CanonicalRuntime,
  ) {}

  /** Reconcile existing agents with bounded concurrency and per-agent isolation. */
  async sync(persona: string, systemPrompt: string, limit = 500): Promise<PersonaSyncResult> {
    const version = canonicalMemoryVersion(persona, systemPrompt);
    const result: PersonaSyncResult = {
      checked: 0,
      updated: 0,
      upToDate: 0,
      failed: 0,
      unsupported: 0,
      version,
    };
    state.version = version;
    const agents = await this.db.listAgentsForPersonaSync(limit);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < agents.length) {
        const agent = agents[cursor++];
        if (!agent) return;
        result.checked += 1;
        if (agent.personaVersion === version) {
          result.upToDate += 1;
          continue;
        }
        const outcome = await this.reconcileAgent(agent, persona, systemPrompt);
        result[outcome === "updated" ? "updated" : outcome === "up_to_date" ? "upToDate" : outcome] += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, agents.length) }, worker));

    state.lastRunAt = new Date().toISOString();
    state.updated = result.updated;
    state.upToDate = result.upToDate;
    state.failed = result.failed;
    state.unsupported = result.unsupported;
    state.status = result.failed > 0
      ? (result.updated + result.upToDate > 0 ? "degraded" : "failed")
      : result.unsupported > 0 ? "unsupported" : "ok";
    if (state.status === "ok") state.staleAgents = 0;
    this.logger.info("Canonical runtime context reconciliation finished", { ...result });
    return result;
  }

  async reconcileAgent(
    input: { agentId: string; userId: number; conversationId: string | null },
    persona: string,
    systemPrompt: string,
  ): Promise<"updated" | "up_to_date" | "failed" | "unsupported"> {
    const existing = this.inFlight.get(input.agentId);
    if (existing) return await existing;
    const work = this.reconcileAgentOnce(input, persona, systemPrompt)
      .finally(() => this.inFlight.delete(input.agentId));
    this.inFlight.set(input.agentId, work);
    return await work;
  }

  private async reconcileAgentOnce(
    input: { agentId: string; userId: number; conversationId: string | null },
    persona: string,
    systemPrompt: string,
  ): Promise<"updated" | "up_to_date" | "failed" | "unsupported"> {
    if (!input.conversationId) {
      await this.db.recordCanonicalContextSyncState(input.agentId, input.userId, "unsupported");
      return "unsupported";
    }
    try {
      const systemUpdated = await this.runtime.updateAgentSystemPrompt(input.agentId, systemPrompt);
      const personaUpdated = await this.runtime.updateAgentPersona(
        input.agentId,
        input.conversationId,
        persona,
      );
      await this.db.recordMemoryReconciled(input.agentId, input.userId, {
        version: canonicalMemoryVersion(persona, systemPrompt),
        legacy: [],
      });
      return systemUpdated || personaUpdated ? "updated" : "up_to_date";
    } catch (error) {
      await this.db.recordCanonicalContextSyncState(input.agentId, input.userId, "degraded")
        .catch(() => undefined);
      this.logger.warn("Canonical runtime context was not applied", {
        agentId: input.agentId,
        code: error instanceof Error ? error.name : "unknown_error",
      });
      return "failed";
    }
  }

  async observeAgent(): Promise<{ canonicalPresent: string[]; legacy: LegacyBlockRecord[] }> {
    // Existing block CRUD is intentionally unavailable on the self-hosted
    // WebSocket runtime. MemFS status is observed separately through the SDK.
    return { canonicalPresent: [], legacy: [] };
  }

  /** Fast pre-turn attempt. Failure is telemetry, never an availability gate. */
  async syncAgent(
    input: {
      agentId: string;
      userId: number;
      conversationId: string | null;
      storedVersion: string | null;
    },
    persona: string,
    options: { timeoutMs?: number } = {},
    systemPrompt = "",
  ): Promise<"updated" | "up_to_date" | "failed" | "unsupported"> {
    const version = canonicalMemoryVersion(persona, systemPrompt);
    state.version = version;
    if (input.storedVersion === version) return "up_to_date";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"failed">((resolve) => {
      timer = setTimeout(() => resolve("failed"), Math.max(250, options.timeoutMs ?? 3_000));
      timer.unref?.();
    });
    const outcome = await Promise.race([
      this.reconcileAgent(input, persona, systemPrompt),
      timeout,
    ]).finally(() => clearTimeout(timer));
    if (outcome === "failed") {
      state.staleAgents += 1;
      state.status = "degraded";
    } else if (outcome === "unsupported") {
      state.unsupported += 1;
      state.status = "unsupported";
    } else {
      state.status = "ok";
    }
    return outcome;
  }
}
