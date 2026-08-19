/**
 * Каноническое ядро памяти — существующим агентам.
 *
 * Новый агент получает четыре блока при создании (`evaMemoryBlocks`), а
 * созданный раньше остаётся с тем набором, который был на тот день. Так
 * и вышло, что часть агентов говорила о себе в мужском роде, а у части
 * вместо `therapeutic_framework` висели блоки прежней схемы.
 *
 * Здесь один проход сверки, а не два разных: персона — частный случай
 * канонического блока, и заводить ей отдельный путь значило бы иметь два
 * механизма, которые расходятся.
 *
 * Направление всегда одно: файл → агент. Обратной синхронизации нет
 * (инвариант 12). Содержимое блоков живёт только в Letta; в PostgreSQL
 * остаётся отметка версии и перечень legacy-меток — но не значения.
 *
 * Границы того, что этот проход себе позволяет:
 *
 * - `persona` и `therapeutic_framework` ведёт Evaself: их содержимое
 *   приводится к каноническому;
 * - `human` и `current_state` принадлежат агенту и человеку: проход
 *   гарантирует, что блок есть, и **никогда** не переписывает то, что в
 *   нём уже накоплено;
 * - блок прежней схемы не удаляется и не отсоединяется, пока его
 *   содержимое некуда безопасно перенести. Официального пути «блок →
 *   MemFS» через control plane на установленных версиях нет
 *   (`memory-block.export-to-memfs` в реестре возможностей), поэтому
 *   такой блок остаётся на месте с отметкой `legacy_pending_migration`.
 */

import { createHash } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { LettaAdminPlane } from "./admin-client.js";
import { capability } from "./capabilities.js";
import { evaMemoryBlocks, SYNCED_BLOCK_LABELS } from "./memory-blocks.js";

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
  /**
   * Исход последней попытки синхронизации, а не вечная отметка о былом
   * отказе: агент, которого не удалось обновить массовым проходом,
   * получает персону в своём же ходе, и держать после этого `failed`
   * значило бы показывать человеку несуществующую поломку.
   */
  status: "ok" | "disabled" | "failed" | "stale" | "never";
  version: string;
  lastRunAt: string | null;
  updated: number;
  upToDate: number;
  failed: number;
  /** Агенты, которых нашли устаревшими прямо в ходе и не смогли обновить. */
  staleAgents: number;
  /** Агенты, у которых остались блоки прежней схемы, ждущие переноса. */
  legacyAgents: number;
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
  /** Версия канонического ядра, до которой шла сверка. */
  version: string;
  /** У скольких агентов остались блоки прежней схемы. */
  legacyAgents: number;
}

/**
 * Метки, чьё содержимое ведёт Evaself.
 *
 * Остальные два блока канонического набора принадлежат агенту и человеку:
 * проход только следит, что они есть. Перезапись `human` стартовым
 * значением стёрла бы всё, что Ева узнала о человеке, — это не «сверка
 * схемы», это потеря памяти.
 */
const EVASELF_OWNED: ReadonlySet<string> = new Set(["persona", "therapeutic_framework"]);

/**
 * Версия канонического ядра — отпечаток того, что мы доставляем.
 *
 * Считается по содержимому блоков, которые ведёт Evaself, а не по одной
 * персоне: правка терапевтической рамки — такое же расхождение с
 * агентом, как правка персоны, и пропускать её нельзя.
 */
export function canonicalMemoryVersion(persona: string): string {
  const owned = evaMemoryBlocks(persona)
    .filter((block) => EVASELF_OWNED.has(block.label))
    .map((block) => `${block.label}\n${block.value}`)
    .join("\n---\n");
  return createHash("sha256").update(owned).digest("hex").slice(0, 12);
}

/** Блок прежней схемы: что о нём известно, без единого знака содержимого. */
export interface LegacyBlockRecord {
  id: string;
  label: string;
  description: string | null;
  /** Длина значения в знаках. Само значение никуда не уходит. */
  size: number;
  /**
   * Пока официального пути перенести содержимое во внешнюю память нет,
   * состояние ровно одно: блок остаётся у агента и ждёт переноса.
   */
  status: "legacy_pending_migration";
}

/** Что сделал один проход сверки. Метки — да, значения — нет. */
export interface MemoryReconcileReport {
  agentId: string;
  created: string[];
  updated: string[];
  kept: string[];
  legacy: LegacyBlockRecord[];
  /** Сколько канонических блоков на месте после прохода. */
  canonical: number;
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
  legacyAgents: 0,
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
    const version = canonicalMemoryVersion(persona);
    const result: PersonaSyncResult = {
      checked: 0, updated: 0, upToDate: 0, failed: 0, legacyAgents: 0, version,
    };
    state.version = version;
    state.enabled = this.plane.available;
    if (!this.plane.available) {
      state.status = "disabled";
      state.lastRunAt = new Date().toISOString();
      this.logger.warn("Сверка ядра памяти пропущена: control plane выключен", { version });
      return result;
    }

    for (const agent of await this.db.listAgentsForPersonaSync(limit)) {
      result.checked += 1;
      if (agent.personaVersion === version) {
        result.upToDate += 1;
        continue;
      }
      try {
        const report = await this.reconcileAgent(agent, persona);
        if (report.created.length + report.updated.length > 0) result.updated += 1;
        else result.upToDate += 1;
        result.legacyAgents += report.legacy.length > 0 ? 1 : 0;
      } catch (error) {
        result.failed += 1;
        this.logger.warn("Ядро памяти агента не сведено", {
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
    state.legacyAgents = result.legacyAgents;
    this.logger.info("Ядро памяти сведено с существующими агентами", { ...result });
    return result;
  }

  /**
   * Свести ядро памяти одного агента с каноническим.
   *
   * Один проход на все четыре блока: недостающий заводится и
   * присоединяется, наш — приводится к каноническому тексту, чужой
   * остаётся как есть. Блоки прежней схемы только переписываются в
   * инвентарь: их содержимое некуда безопасно перенести, а снять блок,
   * не сохранив содержимое, значит потерять память человека.
   *
   * Повторный проход ничего не делает: недостающих нет, наши совпадают,
   * чужие не трогаются, legacy остаются с той же отметкой.
   */
  async reconcileAgent(
    input: { agentId: string; userId: number },
    persona: string,
  ): Promise<MemoryReconcileReport> {
    const canonical = evaMemoryBlocks(persona);
    const canonicalLabels = new Set<string>(SYNCED_BLOCK_LABELS);
    const present = await this.plane.listMemoryBlocks(input.agentId);
    const byLabel = new Map(present.map((block) => [block.label, block]));
    const report: MemoryReconcileReport = {
      agentId: input.agentId, created: [], updated: [], kept: [], legacy: [], canonical: 0,
    };

    for (const block of canonical) {
      const existing = byLabel.get(block.label);
      if (!existing) {
        await this.plane.createMemoryBlock(input.agentId, {
          label: block.label,
          value: block.value,
          description: block.description ?? null,
          limit: block.limit ?? null,
        });
        report.created.push(block.label);
      } else if (!EVASELF_OWNED.has(block.label)) {
        // Блок человека и агента. Он есть — этого достаточно; что в нём
        // накоплено, знает только Ева, и стартовое значение это стёрло бы.
        report.kept.push(block.label);
      } else if (existing.value.trim() === block.value.trim()) {
        report.kept.push(block.label);
      } else {
        await this.plane.updateMemoryBlock(input.agentId, block.label, block.value);
        report.updated.push(block.label);
      }
      report.canonical += 1;
    }

    report.legacy = present
      .filter((block) => !canonicalLabels.has(block.label))
      .map((block) => ({
        id: block.id,
        label: block.label,
        description: block.description,
        size: block.value.length,
        status: "legacy_pending_migration" as const,
      }));

    await this.db.recordMemoryReconciled(input.agentId, input.userId, {
      version: canonicalMemoryVersion(persona),
      legacy: report.legacy.map((block) => block.label),
    });

    if (report.legacy.length > 0) {
      // Причина отказа от переноса записана в реестре возможностей —
      // здесь она только пересказывается в журнал, чтобы дежурный не
      // искал её по коду.
      this.logger.info("У агента остались блоки прежней схемы", {
        agentId: input.agentId,
        labels: report.legacy.map((block) => block.label),
        reason: capability("memory-block.export-to-memfs").note,
      });
    }
    return report;
  }

  /**
   * Свести ядро памяти одного агента — прямо перед его ходом.
   *
   * Массовый проход идёт при старте и может не успеть к первому
   * сообщению человека, а агент со старым набором блоков успеет ответить
   * о себе в мужском роде — или ответить вовсе без терапевтической
   * рамки. Поэтому у хода есть свой короткий проход: он ограничен по
   * времени и не роняет ход, если control plane молчит.
   */
  async syncAgent(
    input: { agentId: string; userId: number; storedVersion: string | null },
    persona: string,
    options: { timeoutMs?: number } = {},
  ): Promise<"updated" | "up_to_date" | "failed" | "disabled"> {
    const version = canonicalMemoryVersion(persona);
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
        const report = await this.reconcileAgent(input, persona);
        return report.created.length + report.updated.length > 0 ? "updated" : "up_to_date";
      } catch (error) {
        this.logger.warn("Ядро памяти агента не сведено перед ходом", {
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
    } else {
      // Проход удался — значит, control plane отвечает. Отказ прошлого
      // массового прохода остаётся в счётчике `failed`, но текущим
      // состоянием быть перестаёт.
      if (outcome === "updated") state.updated += 1;
      state.status = "ok";
    }
    return outcome;
  }
}
