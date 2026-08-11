/**
 * Синхронизация шести memory blocks с Letta — с честным исходом.
 *
 * Задача не в том, чтобы записать блок: это одна строчка через
 * административный клиент. Задача в том, чтобы система знала и показывала,
 * записан он на самом деле или нет.
 *
 * Раньше отличить было нечем. Agent SDK задаёт блоки при создании агента и
 * больше к ним не возвращается, официальная запись живёт в другом пакете, а
 * пакет может быть выключен флагом, недоступен по сети или отвергнуть
 * операцию на конкретном App Server. Во всех этих случаях соблазн один —
 * применить значение только в runtime-контексте и считать дело сделанным.
 * Так появляется скрытая мутация: в Letta одно, в голове у системы другое.
 *
 * Поэтому здесь четыре статуса и ни одного синонима. `runtime_override` —
 * это признание, а не запасной путь: значение применяется в контексте хода,
 * в Letta его нет, и повтор обязан состояться, когда официальная запись
 * снова станет возможной.
 *
 * Набор блоков этот модуль не расширяет и не меняет (инвариант 28): метки
 * приходят из `evaMemoryBlocks()` и проверяются ограничением таблицы.
 */

import { createHash } from "node:crypto";

import { EvaError } from "../errors.js";

import type { LettaAdminPlane } from "./admin-client.js";

/** Шесть меток. Список закрыт и совпадает с ограничением таблицы. */
export const SYNCED_BLOCK_LABELS = [
  "persona",
  "human",
  "current_state",
  "goals_and_commitments",
  "relationships_and_patterns",
  "progress_and_hypotheses",
] as const;

export type SyncedBlockLabel = (typeof SYNCED_BLOCK_LABELS)[number];

export type BlockSyncStatus = "pending" | "synced" | "runtime_override" | "failed";

export interface BlockSyncRow {
  agentId: string;
  label: SyncedBlockLabel;
  desiredValue: string;
  status: BlockSyncStatus;
  syncedChecksum: string | null;
  attempts: number;
  lastError: string | null;
}

/**
 * Строка предпросмотра.
 *
 * Текста блоков здесь нет намеренно: предпросмотр показывается человеку в
 * административном интерфейсе, а содержимое памяти — это сырой
 * пользовательский текст. Различие описывается длинами и отпечатками,
 * которых достаточно, чтобы увидеть, что именно разошлось.
 */
export interface BlockSyncPreview {
  label: SyncedBlockLabel;
  status: BlockSyncStatus;
  changed: boolean;
  desiredLength: number;
  remoteLength: number | null;
  desiredChecksum: string;
  remoteChecksum: string | null;
  /** Почему строка попала в предпросмотр в таком виде. */
  reason: string;
}

export interface BlockSyncDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  withUserScope<T>(
    input: { userId: number; label: string; inherit?: boolean },
    work: () => Promise<T>,
  ): Promise<T>;
}

export function blockChecksum(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isSyncedLabel(value: string): value is SyncedBlockLabel {
  return (SYNCED_BLOCK_LABELS as readonly string[]).includes(value);
}

export class MemoryBlockSync {
  private readonly db: BlockSyncDatabase;
  private readonly plane: LettaAdminPlane;

  constructor(db: BlockSyncDatabase, plane: LettaAdminPlane) {
    this.db = db;
    this.plane = plane;
  }

  /**
   * Записать намерение.
   *
   * Намерение отделено от попытки: строка появляется в `pending` до всякого
   * обращения к Letta. Иначе отказ сети означал бы, что желаемого значения
   * не осталось нигде, и повторять было бы нечего.
   */
  async record(
    userId: number,
    agentId: string,
    label: SyncedBlockLabel,
    desiredValue: string,
  ): Promise<void> {
    await this.db.withUserScope(
      { userId, label: "letta.blocks.record", inherit: true },
      async () => await this.db.query(
        // tenant: by user_id
        `INSERT INTO letta_memory_block_sync (user_id, agent_id, label, desired_value, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (agent_id, label) DO UPDATE SET
           desired_value = EXCLUDED.desired_value,
           -- Новое намерение сбрасывает подтверждение: записанным
           -- считается только то значение, которое подтверждено само,
           -- а не любое значение этой метки.
           status = CASE
             WHEN letta_memory_block_sync.synced_checksum IS NOT DISTINCT FROM $5
               THEN letta_memory_block_sync.status
             ELSE 'pending'
           END,
           updated_at = now()
         WHERE letta_memory_block_sync.user_id = $1`,
        [userId, agentId, label, desiredValue, blockChecksum(desiredValue)],
      ),
    );
  }

  /**
   * Что разойдётся, если применить намерения прямо сейчас.
   *
   * Предпросмотр обязателен до записи: точечное изменение блока
   * необратимо — прежнего значения Letta не хранит, и «отменить» после
   * записи можно только записав обратно то, что мы сами же помним.
   */
  async preview(userId: number, agentId: string): Promise<BlockSyncPreview[]> {
    const intents = await this.load(userId, agentId);
    if (intents.length === 0) return [];

    let remote = new Map<string, string>();
    let remoteReadable = true;
    let remoteError = "";
    try {
      const blocks = await this.plane.listMemoryBlocks(agentId);
      remote = new Map(blocks.map((block) => [block.label, block.value]));
    } catch (error) {
      // Недоступный control plane не отменяет предпросмотр: показать
      // намерения всё равно нужно, но выдавать их за сравнение с Letta
      // нельзя — удалённой стороны мы в этот момент не видели.
      remoteReadable = false;
      remoteError = error instanceof EvaError ? error.code : "app_server_unavailable";
    }

    return intents.map((intent) => {
      const desiredChecksum = blockChecksum(intent.desiredValue);
      const remoteValue = remote.get(intent.label);
      const remoteChecksum =
        remoteReadable && remoteValue !== undefined ? blockChecksum(remoteValue) : null;
      return {
        label: intent.label,
        status: intent.status,
        changed: remoteChecksum === null ? true : remoteChecksum !== desiredChecksum,
        desiredLength: intent.desiredValue.length,
        remoteLength: remoteReadable && remoteValue !== undefined ? remoteValue.length : null,
        desiredChecksum,
        remoteChecksum,
        reason: !remoteReadable
          ? `удалённое значение не прочитано: ${remoteError}`
          : remoteValue === undefined
            ? "блока с такой меткой в Letta не найдено"
            : remoteChecksum === desiredChecksum
              ? "значения совпадают"
              : "значения различаются",
      };
    });
  }

  /**
   * Применить намерения.
   *
   * Успех — только подтверждённая официальная запись. Любой отказ
   * административного пути переводит строку в `runtime_override`: значение
   * остаётся жить в runtime-контексте, но система знает, что в Letta его
   * нет, и повторит попытку. Прочие отказы — `failed`.
   */
  async apply(userId: number, agentId: string): Promise<Map<SyncedBlockLabel, BlockSyncStatus>> {
    const intents = await this.load(userId, agentId);
    const result = new Map<SyncedBlockLabel, BlockSyncStatus>();

    for (const intent of intents) {
      if (
        intent.status === "synced" &&
        intent.syncedChecksum === blockChecksum(intent.desiredValue)
      ) {
        result.set(intent.label, "synced");
        continue;
      }
      try {
        await this.plane.updateMemoryBlock(agentId, intent.label, intent.desiredValue);
        await this.mark(userId, agentId, intent.label, "synced", {
          checksum: blockChecksum(intent.desiredValue),
          error: null,
        });
        result.set(intent.label, "synced");
      } catch (error) {
        // `unsupported_operation` — это выключенный или отсутствующий
        // официальный путь, а не поломка. Он и означает override: работать
        // можно, но не притворяясь, что блок записан.
        const code = error instanceof EvaError ? error.code : "unknown";
        const status: BlockSyncStatus =
          code === "unsupported_operation" ? "runtime_override" : "failed";
        await this.mark(userId, agentId, intent.label, status, {
          checksum: null,
          error: code,
        });
        result.set(intent.label, status);
      }
    }
    return result;
  }

  /**
   * Повторить всё, что не подтверждено.
   *
   * Ради этого метода строка и переживает отказ: как только официальная
   * возможность появляется — включён флаг, поднялся App Server, обновился
   * пакет, — `runtime_override` обязан превратиться в `synced` без участия
   * человека.
   */
  async resync(userId: number, agentId: string): Promise<Map<SyncedBlockLabel, BlockSyncStatus>> {
    if (!this.plane.available) return new Map();
    return await this.apply(userId, agentId);
  }

  /** Строки, которым нужен повтор. Основа отчёта и метрики. */
  async pending(userId: number, agentId: string): Promise<BlockSyncRow[]> {
    return (await this.load(userId, agentId)).filter((row) => row.status !== "synced");
  }

  private async load(userId: number, agentId: string): Promise<BlockSyncRow[]> {
    const { rows } = await this.db.withUserScope(
      { userId, label: "letta.blocks.load", inherit: true },
      async () => await this.db.query(
        // tenant: by user_id
        `SELECT agent_id, label, desired_value, status, synced_checksum, attempts, last_error
           FROM letta_memory_block_sync
          WHERE user_id = $1 AND agent_id = $2
          ORDER BY label`,
        [userId, agentId],
      ),
    );
    const intents: BlockSyncRow[] = [];
    for (const row of rows) {
      const label = String(row.label ?? "");
      // Ограничение таблицы уже не пускает чужую метку, но строка могла
      // приехать из восстановленной копии со старым набором. Молча
      // синхронизировать такую метку нельзя — набор закрыт.
      if (!isSyncedLabel(label)) continue;
      intents.push({
        agentId: String(row.agent_id ?? ""),
        label,
        desiredValue: String(row.desired_value ?? ""),
        status: (row.status as BlockSyncStatus) ?? "pending",
        syncedChecksum: row.synced_checksum === null ? null : String(row.synced_checksum),
        attempts: Number(row.attempts ?? 0),
        lastError: row.last_error === null ? null : String(row.last_error),
      });
    }
    return intents;
  }

  private async mark(
    userId: number,
    agentId: string,
    label: SyncedBlockLabel,
    status: BlockSyncStatus,
    outcome: { checksum: string | null; error: string | null },
  ): Promise<void> {
    await this.db.withUserScope(
      { userId, label: "letta.blocks.mark", inherit: true },
      async () => await this.db.query(
        // tenant: by user_id
        `UPDATE letta_memory_block_sync
            SET status = $4,
                synced_checksum = COALESCE($5, synced_checksum),
                synced_at = CASE WHEN $4 = 'synced' THEN now() ELSE synced_at END,
                attempts = attempts + 1,
                last_error = $6,
                last_attempt_at = now(),
                updated_at = now()
          WHERE user_id = $1 AND agent_id = $2 AND label = $3`,
        [userId, agentId, label, status, outcome.checksum, outcome.error],
      ),
    );
  }
}
