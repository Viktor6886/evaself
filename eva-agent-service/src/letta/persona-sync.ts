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
    if (!this.plane.available) {
      this.logger.info("Синхронизация персоны пропущена: control plane выключен", { version });
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

    this.logger.info("Персона синхронизирована с существующими агентами", { ...result });
    return result;
  }
}
