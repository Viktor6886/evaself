/**
 * Канонический текст персоны — существующим агентам.
 *
 * Новый агент получает персону при создании (`evaMemoryBlocks`), а
 * созданный раньше остаётся с тем текстом, который был на тот день. Так
 * и вышло, что часть агентов говорила о себе в мужском роде: файл
 * персоны давно поправлен, а блок в Letta — нет.
 *
 * Это не фоновая сверка блоков и не теневая копия: значение блока живёт
 * только в Letta, а в PostgreSQL остаётся отметка версии — кому
 * канонический текст уже доставлен. Направление всегда одно: файл →
 * агент. Обратной синхронизации нет (инвариант 12).
 */

import { createHash } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { LettaAdminPlane } from "./admin-client.js";

/**
 * Состояние синхронизации для `/health` и `doctor`.
 *
 * Молча пропущенная синхронизация ничем не отличается от выполненной, и
 * ровно так мужской род и держался месяцами: control plane был выключен,
 * а сказать об этом было некому.
 */
export interface PersonaSyncState {
  /** Доступен ли control plane. Выключенный — это `disabled`, а не «ок». */
  enabled: boolean;
  status: "ok" | "disabled" | "failed" | "stale" | "never";
  version: string;
  lastRunAt: string | null;
  updated: number;
  upToDate: number;
  failed: number;
  /** Агенты, которых нашли устаревшими прямо в ходе и не смогли обновить. */
  staleAgents: number;
}

export interface PersonaSyncResult {
  /** Сколько агентов просмотрено. */
  checked: number;
  /** Сколько получили новый текст. */
  updated: number;
  /** Сколько уже были с ним. */
  upToDate: number;
  /** Сколько не удалось обновить. */
  failed: number;
  /** Версия персоны, до которой шла синхронизация. */
  version: string;
}

/** Версия персоны — отпечаток самого текста: сравнивать нужно тексты. */
export function personaVersion(persona: string): string {
  return createHash("sha256").update(persona).digest("hex").slice(0, 12);
}

/**
 * Состояние живёт в модуле, а не в экземпляре: его спрашивает `/health`,
 * которому до конструктора синхронизации дела нет.
 */
const state: PersonaSyncState = {
  enabled: false,
  status: "never",
  version: "",
  lastRunAt: null,
  updated: 0,
  upToDate: 0,
  failed: 0,
  staleAgents: 0,
};

export function personaSyncState(): PersonaSyncState {
  return { ...state };
}

export class PersonaSync {
  constructor(
    private readonly db: Database,
    private readonly plane: LettaAdminPlane,
    private readonly logger: Logger,
  ) {}

  /**
   * Довести персону существующих агентов до канонической.
   *
   * Отказ на одном агенте не прекращает работу: остальные не виноваты в
   * том, что у одного не отвечает control plane. Текст персоны и
   * значения блоков в журнал не попадают — только счётчики.
   */
  async sync(persona: string, limit = 500): Promise<PersonaSyncResult> {
    const version = personaVersion(persona);
    const result: PersonaSyncResult = {
      checked: 0, updated: 0, upToDate: 0, failed: 0, version,
    };
    state.version = version;
    state.enabled = this.plane.available;
    if (!this.plane.available) {
      state.status = "disabled";
      state.lastRunAt = new Date().toISOString();
      this.logger.warn("Синхронизация персоны пропущена: control plane выключен", { version });
      return result;
    }

    for (const agent of await this.db.listAgentsForPersonaSync(limit)) {
      result.checked += 1;
      if (agent.personaVersion === version) {
        result.upToDate += 1;
        continue;
      }
      try {
        // Блок читается перед записью: агент мог получить тот же текст
        // другим путём, и лишняя запись в память — это лишнее событие в
        // истории агента.
        const blocks = await this.plane.listMemoryBlocks(agent.agentId);
        const current = blocks.find((block) => block.label === "persona");
        if (current?.value.trim() === persona.trim()) {
          result.upToDate += 1;
        } else {
          await this.plane.updateMemoryBlock(agent.agentId, "persona", persona);
          result.updated += 1;
        }
        await this.db.recordPersonaVersion(agent.agentId, agent.userId, version);
      } catch (error) {
        result.failed += 1;
        this.logger.warn("Персона агента не обновлена", {
          agentId: agent.agentId,
          code: error instanceof Error ? error.name : "unknown_error",
        });
      }
    }

    state.lastRunAt = new Date().toISOString();
    state.updated = result.updated;
    state.upToDate = result.upToDate;
    state.failed = result.failed;
    state.status = result.failed > 0 ? "failed" : "ok";
    if (state.status === "ok") state.staleAgents = 0;
    this.logger.info("Персона синхронизирована с существующими агентами", { ...result });
    return result;
  }

  /**
   * Довести до канонической персону одного агента — прямо перед его
   * ходом.
   *
   * Массовая синхронизация идёт при старте и может не успеть к первому
   * сообщению человека, а агент со старым текстом успеет ответить о себе
   * в мужском роде. Поэтому у хода есть свой короткий проход: он
   * ограничен по времени и не роняет ход, если control plane молчит.
   */
  async syncAgent(
    input: { agentId: string; userId: number; storedVersion: string | null },
    persona: string,
    options: { timeoutMs?: number } = {},
  ): Promise<"updated" | "up_to_date" | "failed" | "disabled"> {
    const version = personaVersion(persona);
    state.version = version;
    if (!this.plane.available) {
      state.enabled = false;
      state.status = "disabled";
      return "disabled";
    }
    if (input.storedVersion === version) return "up_to_date";

    const deadline = new Promise<"failed">((resolve) => {
      const timer = setTimeout(() => resolve("failed"), Math.max(250, options.timeoutMs ?? 3_000));
      timer.unref?.();
    });
    const work = (async (): Promise<"updated" | "up_to_date" | "failed"> => {
      try {
        const blocks = await this.plane.listMemoryBlocks(input.agentId);
        const current = blocks.find((block) => block.label === "persona");
        if (current?.value.trim() !== persona.trim()) {
          await this.plane.updateMemoryBlock(input.agentId, "persona", persona);
          await this.db.recordPersonaVersion(input.agentId, input.userId, version);
          return "updated";
        }
        await this.db.recordPersonaVersion(input.agentId, input.userId, version);
        return "up_to_date";
      } catch (error) {
        this.logger.warn("Персона агента не обновлена перед ходом", {
          agentId: input.agentId,
          code: error instanceof Error ? error.name : "unknown_error",
        });
        return "failed";
      }
    })();

    const outcome = await Promise.race([work, deadline]);
    if (outcome === "failed") {
      state.staleAgents += 1;
      state.status = "stale";
    } else if (outcome === "updated") {
      state.updated += 1;
      if (state.status !== "failed") state.status = "ok";
    }
    return outcome;
  }
}
