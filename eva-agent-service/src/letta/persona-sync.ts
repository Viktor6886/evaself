import { createHash } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import { evaMemoryBlocks } from "./memory-blocks.js";

export type CanonicalSyncStatus = "ok" | "degraded" | "unsupported" | "failed" | "never";

/**
 * Исход сведения одного агента.
 *
 * `deferred` — отдельный исход, а не разновидность отказа: канонический
 * текст не применён и при этом ничего не изменено. Такой агент
 * повторяется сам; `failed` означает, что попытка была и сорвалась.
 */
export type AgentSyncOutcome = "updated" | "up_to_date" | "failed" | "unsupported" | "deferred";

export interface PersonaSyncState {
  status: CanonicalSyncStatus;
  version: string;
  lastRunAt: string | null;
  updated: number;
  upToDate: number;
  failed: number;
  unsupported: number;
  deferred: number;
  staleAgents: number;
}

export interface PersonaSyncResult {
  checked: number;
  updated: number;
  upToDate: number;
  failed: number;
  unsupported: number;
  deferred: number;
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
  /**
   * Выполнить правку канонического контекста под барьером обслуживания.
   *
   * Барьер, а не снимок пула: пока правка идёт, новый ход этого агента не
   * стартует, идущий договаривает, другой агент не ждёт. `busy` означает,
   * что ход не отпустил агента в отведённое окно и правка не начиналась.
   */
  runAgentMaintenance?<T>(
    agentId: string,
    work: () => Promise<T>,
    options: { drainTimeoutMs: number; conversationIds?: readonly string[] },
  ): Promise<{ status: "done"; value: T } | { status: "busy" }>;
  updateAgentSystemPrompt(agentId: string, systemPrompt: string): Promise<boolean>;
  updateAgentPersona(agentId: string, conversationId: string, persona: string): Promise<boolean>;
  invalidateAgentSessions?(agentId: string, conversationIds?: readonly string[]): void;
  /** Дешёвая проверка, что App Server отвечает: старт может опередить его. */
  ping?(): Promise<{ ok: true; models: number } | { ok: false; error: string }>;
}

const state: PersonaSyncState = {
  status: "never",
  version: "",
  lastRunAt: null,
  updated: 0,
  upToDate: 0,
  failed: 0,
  unsupported: 0,
  deferred: 0,
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

/** Сколько ждать освобождения агента перед правкой, если бюджета не задали. */
const DEFAULT_DRAIN_MS = 8_000;

export class PersonaSync {
  private readonly inFlight = new Map<string, Promise<AgentSyncOutcome>>();

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly runtime: CanonicalRuntime,
  ) {}

  /**
   * Reconcile existing agents with bounded concurrency and per-agent isolation.
   *
   * Выборка идёт страницами: установка с тысячей агентов не должна
   * молча сводить первые пятьсот и считать это успехом. Отказ одного
   * агента не останавливает остальных, а сам проход не участвует в
   * доступности чата.
   */
  async sync(
    persona: string,
    systemPrompt: string,
    options: { batchSize?: number; onlyStale?: boolean } = {},
  ): Promise<PersonaSyncResult> {
    const version = canonicalMemoryVersion(persona, systemPrompt);
    const result: PersonaSyncResult = {
      checked: 0,
      updated: 0,
      upToDate: 0,
      failed: 0,
      unsupported: 0,
      deferred: 0,
      version,
    };
    state.version = version;
    const batchSize = Math.max(1, options.batchSize ?? 500);

    for (let offset = 0; ; offset += batchSize) {
      const agents = await this.db.listAgentsForPersonaSync(batchSize, offset);
      if (agents.length === 0) break;
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
          if (outcome === "updated") result.updated += 1;
          else if (outcome === "up_to_date") result.upToDate += 1;
          else result[outcome] += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, agents.length) }, worker));
      if (agents.length < batchSize) break;
    }

    state.lastRunAt = new Date().toISOString();
    state.updated = result.updated;
    state.upToDate = result.upToDate;
    state.failed = result.failed;
    state.unsupported = result.unsupported;
    state.deferred = result.deferred;
    state.staleAgents = result.failed + result.deferred;
    state.status = result.failed > 0
      ? (result.updated + result.upToDate > 0 ? "degraded" : "failed")
      : result.deferred > 0 ? "degraded"
      : result.unsupported > 0 ? "unsupported" : "ok";
    this.logger.info("Canonical runtime context reconciliation finished", { ...result });
    return result;
  }

  /**
   * Стартовое сведение: дождаться App Server и повторять отложенных.
   *
   * Сервис поднимается быстрее App Server, и первый проход при старте
   * раньше падал целиком — существующий агент оставался со старым
   * текстом до своего же следующего сообщения. Ожидание идёт с
   * возрастающей задержкой и никогда не участвует в доступности чата:
   * метод вызывается без ожидания результата.
   */
  async reconcileAtStartup(
    persona: string,
    systemPrompt: string,
    options: {
      attempts?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
      batchSize?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<PersonaSyncResult> {
    const attempts = Math.max(1, options.attempts ?? 6);
    const sleep = options.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
    let delay = Math.max(1, options.initialDelayMs ?? 2_000);
    let last: PersonaSyncResult | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.runtime.ping) {
        const ping = await this.runtime.ping().catch(() => ({ ok: false as const, error: "ping failed" }));
        if (!ping.ok) {
          this.logger.info("App Server ещё не готов для сведения канонического контекста", {
            attempt,
          });
          if (attempt < attempts) {
            await sleep(delay);
            delay = Math.min(delay * 2, Math.max(delay, options.maxDelayMs ?? 60_000));
            continue;
          }
          state.status = "degraded";
          return last ?? {
            checked: 0, updated: 0, upToDate: 0, failed: 0, unsupported: 0, deferred: 0,
            version: canonicalMemoryVersion(persona, systemPrompt),
          };
        }
      }
      last = await this.sync(persona, systemPrompt, {
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      });
      // Отложенный агент — тот, чей ход шёл прямо сейчас. Повторяем, но
      // только его: остальных проход уже свёл.
      if (last.failed + last.deferred === 0 || attempt === attempts) return last;
      await sleep(delay);
      delay = Math.min(delay * 2, Math.max(delay, options.maxDelayMs ?? 60_000));
    }
    return last!;
  }

  async reconcileAgent(
    input: { agentId: string; userId: number; conversationId: string | null },
    persona: string,
    systemPrompt: string,
    options: { drainTimeoutMs?: number } = {},
  ): Promise<AgentSyncOutcome> {
    const existing = this.inFlight.get(input.agentId);
    if (existing) return await existing;
    const work = this.reconcileAgentOnce(input, persona, systemPrompt, options)
      .finally(() => this.inFlight.delete(input.agentId));
    this.inFlight.set(input.agentId, work);
    return await work;
  }

  private async reconcileAgentOnce(
    input: { agentId: string; userId: number; conversationId: string | null },
    persona: string,
    systemPrompt: string,
    options: { drainTimeoutMs?: number } = {},
  ): Promise<AgentSyncOutcome> {
    const conversationId = input.conversationId;
    if (!conversationId) {
      await this.db.recordCanonicalContextSyncState(input.agentId, input.userId, "unsupported");
      return "unsupported";
    }
    const apply = async (): Promise<AgentSyncOutcome> => {
      const systemUpdated = await this.runtime.updateAgentSystemPrompt(input.agentId, systemPrompt);
      const personaUpdated = await this.runtime.updateAgentPersona(
        input.agentId,
        conversationId,
        persona,
      );
      if (systemUpdated || personaUpdated) this.runtime.invalidateAgentSessions?.(input.agentId);
      // Версия и `ok` пишутся только после полного успеха: отметка о
      // доставке — это утверждение, что агент действительно получил
      // канонический набор целиком.
      await this.db.recordMemoryReconciled(input.agentId, input.userId, {
        version: canonicalMemoryVersion(persona, systemPrompt),
        legacy: [],
      });
      return systemUpdated || personaUpdated ? "updated" : "up_to_date";
    };

    try {
      if (!this.runtime.runAgentMaintenance) return await apply();
      const outcome = await this.runtime.runAgentMaintenance(input.agentId, apply, {
        drainTimeoutMs: Math.max(0, options.drainTimeoutMs ?? DEFAULT_DRAIN_MS),
        conversationIds: [conversationId],
      });
      if (outcome.status === "busy") {
        // Ход не отпустил агента: ничего не изменено, и повторить это
        // безопаснее, чем перебивать разговор.
        await this.db.recordCanonicalContextSyncState(input.agentId, input.userId, "deferred")
          .catch(() => undefined);
        this.logger.info("Canonical runtime context deferred: the agent is mid-turn", {
          agentId: input.agentId,
        });
        return "deferred";
      }
      return outcome.value;
    } catch (error) {
      // Отложенная правка ничего не изменила — это не деградация набора,
      // а перенос попытки; отличаем её от настоящего отказа.
      const deferred = error instanceof Error
        && (error as { code?: string }).code === "maintenance_deferred";
      await this.db.recordCanonicalContextSyncState(
        input.agentId,
        input.userId,
        deferred ? "deferred" : "degraded",
      ).catch(() => undefined);
      this.logger[deferred ? "info" : "warn"](
        deferred
          ? "Canonical runtime context deferred without changing MemFS"
          : "Canonical runtime context was not applied",
        {
          agentId: input.agentId,
          code: error instanceof Error ? error.name : "unknown_error",
        },
      );
      return deferred ? "deferred" : "failed";
    }
  }

  async observeAgent(): Promise<{ canonicalPresent: string[]; legacy: LegacyBlockRecord[] }> {
    // Existing block CRUD is intentionally unavailable on the self-hosted
    // WebSocket runtime. MemFS status is observed separately through the SDK.
    return { canonicalPresent: [], legacy: [] };
  }

  /**
   * Fast pre-turn attempt. Failure is telemetry, never an availability gate.
   *
   * Срок здесь ограничивает именно задержку хода. Прежняя версия после
   * срока дожидалась работы целиком — то есть срок ничего не ограничивал,
   * и медленный App Server задерживал ответ человеку на всю свою
   * выдержку. Теперь ход отпускается по сроку, а безопасность держит не
   * ожидание, а барьер обслуживания: пока правка идёт, ход этого агента
   * всё равно не начнётся, и половину применённого состояния он не
   * увидит. Не уложившаяся правка доводится сама и повторяется проходом.
   */
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
  ): Promise<AgentSyncOutcome> {
    const version = canonicalMemoryVersion(persona, systemPrompt);
    state.version = version;
    if (input.storedVersion === version) return "up_to_date";
    const timeoutMs = Math.max(250, options.timeoutMs ?? 3_000);
    // Дожидаться освобождения агента дольше самого бюджета бессмысленно:
    // ход, который держит агента, — как раз тот, ради которого мы здесь.
    const work = this.reconcileAgent(input, persona, systemPrompt, { drainTimeoutMs: timeoutMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      timer.unref?.();
    });
    const raced = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (raced === "timed_out") {
      // Работа продолжается и допишет своё состояние сама. Её результат
      // здесь не ждут: иначе срок снова стал бы декорацией.
      void work.catch(() => undefined);
      state.deferred += 1;
      state.staleAgents += 1;
      state.status = "degraded";
      return "deferred";
    }
    if (raced === "failed") {
      state.staleAgents += 1;
      state.status = "degraded";
    } else if (raced === "deferred") {
      state.deferred += 1;
      state.staleAgents += 1;
      state.status = "degraded";
    } else if (raced === "unsupported") {
      state.unsupported += 1;
      state.status = "unsupported";
    } else {
      state.status = "ok";
    }
    return raced;
  }
}
