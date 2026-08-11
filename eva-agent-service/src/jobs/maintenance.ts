/**
 * Сверки обслуживания.
 *
 * Каждая сверка отвечает на один вопрос вида «что застряло»: событие,
 * зафиксированное в базе, но не опубликованное; ход, чья аренда истекла;
 * запись доставки, которая никуда не уехала. Все они устроены одинаково
 * — счётчик и список идентификаторов, — и потому живут в одном месте, а
 * не по одной в каждом модуле, который их породил.
 *
 * Сверка ничего не чинит и никому не пишет. Она измеряет: чинить
 * застрявшее умеют существующие механизмы (восстановление ходов,
 * публикатор job outbox, доставка outbox), и дублировать их здесь
 * значило бы завести второй путь исполнения. Поэтому переносить эти
 * задачи в очередь безопасно первыми — они не отправляют пользователю
 * ни одного сообщения (требование 1 шага 8).
 */

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

export type ReconcileCheck =
  | "job_outbox_unpublished"
  | "turn_lease_expired"
  | "telegram_outbox_undelivered"
  | "episodes_unprocessed"
  | "embeddings_missing"
  | "subscriptions_unreconciled"
  | "temp_files_orphaned";

/**
 * Чем кончилась сверка. `not_applicable` — не пустой результат, а
 * отсутствие того, что можно проверить: сверка, которой нечего читать,
 * обязана отличаться от сверки, не нашедшей проблем. Иначе отсутствие
 * колонки выглядит как здоровье.
 */
export type ReconcileStatus = "checked" | "failed" | "not_applicable";

export interface ReconcileFinding {
  check: ReconcileCheck;
  status: ReconcileStatus;
  count: number;
  /** Идентификаторы застрявших строк: ключи, не содержание. */
  samples: string[];
  /** Почему сверка не выполнялась или не удалась. Код, не текст ошибки. */
  reason?: string;
}

export interface ReconcileReport {
  findings: ReconcileFinding[];
  /** Сколько всего застрявших строк нашлось. Ноль — здоровое состояние. */
  total: number;
  /** Сверки, которые не отработали: их ноль ничего не означает. */
  degraded: ReconcileCheck[];
}

/** Сколько идентификаторов показывать в находке. Список — для разбора, не для отчётности. */
const SAMPLE_LIMIT = 10;

interface CheckDefinition {
  check: ReconcileCheck;
  /** `null` — проверять сегодня нечего, причина в `unavailable`. */
  sql: string | null;
  unavailable?: string;
}

/**
 * Запросы сверок.
 *
 * Каждый возвращает `id` застрявших строк. Порог «застряло» задан в
 * самом запросе и намеренно щедрый: сверка должна ловить то, что не
 * рассосалось само, а не соревноваться с механизмом восстановления.
 */
const CHECKS: readonly CheckDefinition[] = [
  {
    check: "job_outbox_unpublished",
    sql: `-- tenant: system — сверка идёт по всем пользователям сразу,
          -- это наблюдение за состоянием очереди, а не запрос человека
          SELECT id::text AS id FROM job_outbox
           WHERE status IN ('pending', 'publishing')
             AND available_at < now() - interval '5 minutes'
           ORDER BY available_at
           LIMIT $1`,
  },
  {
    check: "turn_lease_expired",
    sql: `-- tenant: system — общесистемное наблюдение за застрявшими ходами
          SELECT run_id::text AS id FROM turn_runs
           WHERE finished_at IS NULL
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < now() - interval '1 minute'
           ORDER BY lease_expires_at
           LIMIT $1`,
  },
  {
    check: "telegram_outbox_undelivered",
    sql: `-- tenant: system — общесистемное наблюдение за доставкой
          SELECT id::text AS id FROM telegram_outbox
           WHERE status IN ('pending', 'sending', 'retry')
             AND available_at < now() - interval '10 minutes'
           ORDER BY available_at
           LIMIT $1`,
  },
  {
    check: "episodes_unprocessed",
    sql: `-- tenant: system — общесистемное наблюдение за суточными эпизодами
          SELECT id::text AS id FROM checkin_episodes
           WHERE local_date < (now() AT TIME ZONE 'UTC')::date - 1
             AND evening_message_id IS NULL
           ORDER BY local_date
           LIMIT $1`,
  },
  {
    // Векторного столбца в схеме ещё нет: гибридный поиск вводит шаг 18.
    // Сверка объявлена сейчас, чтобы её не забыли, но делать вид, что
    // она что-то проверяет, нельзя — она честно отвечает «нечего».
    check: "embeddings_missing",
    sql: null,
    unavailable: "vector_column_absent_until_step_18",
  },
  {
    check: "subscriptions_unreconciled",
    sql: `-- tenant: system — общесистемная сверка сроков подписок
          SELECT id::text AS id FROM subscriptions
           WHERE status IN ('trialing', 'active', 'past_due')
             AND current_period_end IS NOT NULL
             AND current_period_end < now() - interval '1 hour'
           ORDER BY current_period_end
           LIMIT $1`,
  },
  {
    check: "temp_files_orphaned",
    sql: `-- tenant: system — общесистемная сверка временных записей доставки
          SELECT id::text AS id FROM telegram_outbox
           WHERE status = 'dead'
             AND updated_at < now() - interval '7 days'
           ORDER BY updated_at
           LIMIT $1`,
  },
];

export class ReconcileService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /**
   * Выполнить все сверки.
   *
   * Отказ одной сверки не отменяет остальные: причина застревания у них
   * разная, и потерять шесть ответов из-за седьмого — худший исход.
   * Отказавшая сверка попадает в отчёт со статусом `failed`, чтобы её
   * нельзя было спутать со здоровым нулём.
   */
  async run(signal?: AbortSignal): Promise<ReconcileReport> {
    const findings: ReconcileFinding[] = [];
    for (const definition of CHECKS) {
      if (signal?.aborted) break;
      if (!definition.sql) {
        findings.push({
          check: definition.check,
          status: "not_applicable",
          count: 0,
          samples: [],
          reason: definition.unavailable,
        });
        continue;
      }
      const sql = definition.sql;
      try {
        const { rows } = await this.db.withSystemScope(
          `jobs.reconcile.${definition.check}`,
          async () => await this.db.query<{ id: string }>(sql, [SAMPLE_LIMIT]),
          { crossUser: true },
        );
        findings.push({
          check: definition.check,
          status: "checked",
          count: rows.length,
          samples: rows.map((row) => row.id),
        });
      } catch (error) {
        this.logger.warn("Сверка не выполнена", {
          check: definition.check,
          code: error instanceof Error ? error.name : "unknown_error",
        });
        findings.push({
          check: definition.check,
          status: "failed",
          count: 0,
          samples: [],
          reason: error instanceof Error ? error.name : "unknown_error",
        });
      }
    }
    const total = findings.reduce(
      (sum, item) => sum + (item.status === "checked" ? item.count : 0),
      0,
    );
    if (total > 0) {
      this.logger.warn("Сверка нашла застрявшие записи", {
        total,
        checks: findings.filter((item) => item.count > 0).map((item) => item.check),
      });
    }
    return {
      findings,
      total,
      degraded: findings.filter((item) => item.status === "failed").map((item) => item.check),
    };
  }
}
