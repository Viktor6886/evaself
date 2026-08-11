/**
 * Режим зеркала.
 *
 * Старый интервал нельзя отключать по ощущению «новый вроде работает».
 * Требование 3 шага 8 прямое: сначала новая реализация идёт рядом со
 * старой и только выбирает — ничего не делая, — а отключение старого
 * пути разрешено после доказанного совпадения выборки.
 *
 * Доказательство — строка в `job_mirror_samples`: сколько выбрал старый
 * механизм, сколько новый, совпало ли и чем именно разошлось. Без такой
 * строки отключать интервал нечем: «совпадало на прошлой неделе» — это
 * воспоминание, а не факт.
 *
 * Сравниваются идентификаторы, а не содержание: ключ задачи и
 * пользователя достаточно, чтобы увидеть расхождение, и не содержит
 * ничего из переписки.
 */

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

export interface MirrorComparison {
  jobType: string;
  legacyCount: number;
  queueCount: number;
  matched: boolean;
  onlyLegacy: string[];
  onlyQueue: string[];
}

/** Сколько расхождений записывать. Разбор начинается с примеров, а не с полного списка. */
const DIFF_LIMIT = 20;

export function compareSelections(
  jobType: string,
  legacy: readonly string[],
  queue: readonly string[],
): MirrorComparison {
  const legacySet = new Set(legacy);
  const queueSet = new Set(queue);
  const onlyLegacy = [...legacySet].filter((id) => !queueSet.has(id));
  const onlyQueue = [...queueSet].filter((id) => !legacySet.has(id));
  return {
    jobType,
    legacyCount: legacySet.size,
    queueCount: queueSet.size,
    // Совпадение — это совпадение множеств, а не равенство счётчиков:
    // «десять и десять» при разных десяти означает, что оба механизма
    // работают, но с разными людьми.
    matched: onlyLegacy.length === 0 && onlyQueue.length === 0,
    onlyLegacy: onlyLegacy.slice(0, DIFF_LIMIT),
    onlyQueue: onlyQueue.slice(0, DIFF_LIMIT),
  };
}

export class MirrorRecorder {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /** Записать сверку. Отказ записи не должен ломать заход зеркала. */
  async record(comparison: MirrorComparison): Promise<void> {
    try {
      await this.db.withSystemScope(
        "jobs.mirror.record",
        async () => await this.db.query(
          `INSERT INTO job_mirror_samples
             (job_type, legacy_count, queue_count, matched, only_legacy, only_queue)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            comparison.jobType,
            comparison.legacyCount,
            comparison.queueCount,
            comparison.matched,
            comparison.onlyLegacy,
            comparison.onlyQueue,
          ],
        ),
      );
    } catch (error) {
      this.logger.warn("Сверка зеркала не записана", {
        jobType: comparison.jobType,
        code: error instanceof Error ? error.name : "unknown_error",
      });
      return;
    }
    if (!comparison.matched) {
      this.logger.warn("Зеркало разошлось со старым механизмом", {
        jobType: comparison.jobType,
        legacy: comparison.legacyCount,
        queue: comparison.queueCount,
        onlyLegacy: comparison.onlyLegacy.length,
        onlyQueue: comparison.onlyQueue.length,
      });
    }
  }

  /**
   * Готова ли задача к отключению старого интервала.
   *
   * Условие: последние `runs` сверок подряд совпали и их не меньше
   * требуемого. Одно совпадение ничего не доказывает — оно может
   * означать, что оба механизма ничего не выбрали, потому что выбирать
   * было нечего.
   */
  async readyToCutOver(
    jobType: string,
    minimumRuns = 20,
  ): Promise<{ ready: boolean; runs: number; mismatches: number }> {
    const { rows } = await this.db.withSystemScope(
      "jobs.mirror.readiness",
      async () => await this.db.query<{ matched: boolean }>(
        `SELECT matched FROM job_mirror_samples
          WHERE job_type = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [jobType, minimumRuns],
      ),
    );
    const mismatches = rows.filter((row) => !row.matched).length;
    return {
      ready: rows.length >= minimumRuns && mismatches === 0,
      runs: rows.length,
      mismatches,
    };
  }
}
