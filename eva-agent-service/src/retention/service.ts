/**
 * Применение политик хранения.
 *
 * Два режима, и по умолчанию работает первый: предпросмотр считает, что
 * попало бы под удаление, и ничего не трогает. Удаление включается
 * отдельным флагом и только после того, как человек увидел отчёт
 * (раздел «НЕ ДЕЛАЙ» шага 10 требует именно такого порядка).
 *
 * Три свойства, без которых удаление опасно:
 *
 *   1. Пакетами. Одна транзакция на миллион строк держит блокировки и
 *      раздувает WAL; здесь удаление идёт кусками по `batchSize` и
 *      останавливается по сигналу отмены.
 *   2. Идемпотентно и возобновляемо. Прогон не помнит «докуда дошёл» в
 *      памяти: он каждый раз выбирает то, что старше срока, поэтому
 *      прерванный заход продолжается сам собой.
 *   3. С задержками. Активная запись `retention_holds` останавливает
 *      удаление класса целиком — включая класс целиком, если задержка
 *      поставлена без пользователя.
 *
 * Каноническая память не удаляется автоматически ни при каких
 * настройках: у её класса действие `manual`, и кода удаления для него
 * не существует.
 */

import type { Logger } from "../logger.js";
import {
  BACKUP_ROTATION_DAYS,
  RETENTION_CLASSES,
  type RetentionClass,
  effectivePolicies,
} from "./policy.js";

/**
 * Что нужно сервису от базы.
 *
 * Узкий контракт вместо полного `Database`: тот же код обслуживает и
 * агент-сервис, и admin-api, а у второго есть только пул. Оба
 * структурно подходят, и адаптер не превращается в фиктивный объект с
 * `as never`.
 */
export interface RetentionDatabase {
  // Строка не типизируется параметром: у `Database` он ограничен типом
  // драйвера, и общий параметр здесь сделал бы контракт несовместимым с
  // обоими вызывающими сразу. Поля читаются на месте.
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  withSystemScope<T>(
    reason: string,
    work: () => Promise<T>,
    options?: { crossUser?: boolean; inherit?: boolean },
  ): Promise<T>;
}

export interface RetentionClassReport {
  code: string;
  title: string;
  action: string;
  /** Срок в днях. `null` — автоматического удаления нет. */
  days: number | null;
  /** Сколько строк подпадает под политику прямо сейчас. */
  eligible: number;
  /** Сколько затронуто в этом заходе. В предпросмотре всегда 0. */
  affected: number;
  /** Активна ли задержка удаления. */
  held: boolean;
  targets: string;
  note?: string;
}

export interface RetentionReport {
  dryRun: boolean;
  classes: RetentionClassReport[];
  /**
   * Сколько дней удалённое ещё живёт в уже созданных резервных копиях.
   * Обещать мгновенное физическое удаление из них нельзя.
   */
  backupRotationDays: number;
  generatedAt: string;
}

/**
 * Что удаляет или чистит класс.
 *
 * Списками, а не одиночными запросами: один класс данных живёт в
 * нескольких таблицах. «Сырой payload Telegram» — это и входящие, и
 * исходящие сообщения, и вычистить только половину значит объявить
 * политику выполненной, оставив вторую половину на диске.
 */
interface ClassQueries {
  /** Сколько строк подпадает. Суммируется по всем источникам. */
  count: string[];
  /** Что сделать с пакетом. Возвращает число затронутых строк. */
  apply?: string[];
}

/**
 * Запросы по классам.
 *
 * `$1` — срок в днях, `$2` — размер пакета. Удаление всегда ограничено
 * подзапросом с `LIMIT`: пакет обязан быть маленьким, даже если
 * накопилось много.
 */
export const RETENTION_QUERIES: Record<string, ClassQueries> = {
  telegram_payload: {
    count: [
      `-- tenant: system — общесистемное применение политики хранения
       SELECT count(*)::int AS value FROM telegram_updates
        WHERE received_at < now() - make_interval(days => $1)
          AND payload <> '{}'::jsonb`,
      `-- tenant: system — общесистемное применение политики хранения
       SELECT count(*)::int AS value FROM telegram_outbox
        WHERE created_at < now() - make_interval(days => $1)
          AND status IN ('sent', 'dead')
          AND payload <> '{}'::jsonb`,
    ],
    // Редактирование, а не удаление: строка остаётся, и ключ
    // идемпотентности вместе с ней — иначе повторная доставка того же
    // апдейта Telegram создала бы второй ход.
    //
    // У исходящих вычищаются только завершённые строки: у ожидающей
    // доставки payload — это само сообщение, и без него отправлять
    // будет нечего.
    apply: [
      `-- tenant: system — общесистемное применение политики хранения
       UPDATE telegram_updates
          SET payload = '{}'::jsonb
        WHERE id IN (
          SELECT id FROM telegram_updates
           WHERE received_at < now() - make_interval(days => $1)
             AND payload <> '{}'::jsonb
           ORDER BY received_at
           LIMIT $2
        )`,
      `-- tenant: system — общесистемное применение политики хранения
       UPDATE telegram_outbox
          SET payload = '{}'::jsonb
        WHERE id IN (
          SELECT id FROM telegram_outbox
           WHERE created_at < now() - make_interval(days => $1)
             AND status IN ('sent', 'dead')
             AND payload <> '{}'::jsonb
           ORDER BY created_at
           LIMIT $2
        )`,
    ],
  },
  telegram_idempotency: {
    // Статусы — те, что действительно существуют в схеме
    // (`telegram_updates_status_check`): обработанный апдейт получает
    // `completed`, а не `done`. Несуществующее значение в фильтре не
    // ошибка синтаксиса — оно просто никогда не совпадает, и политика
    // молча не работает.
    count: [
      `-- tenant: system — общесистемное применение политики хранения
       SELECT count(*)::int AS value FROM telegram_updates
        WHERE received_at < now() - make_interval(days => $1)
          AND status IN ('completed', 'ignored', 'dead')`,
      `-- tenant: system — общесистемное применение политики хранения
       SELECT count(*)::int AS value FROM telegram_outbox
        WHERE created_at < now() - make_interval(days => $1)
          AND status IN ('sent', 'dead')`,
    ],
    apply: [
      `-- tenant: system — общесистемное применение политики хранения
       DELETE FROM telegram_updates
        WHERE id IN (
          SELECT id FROM telegram_updates
           WHERE received_at < now() - make_interval(days => $1)
             AND status IN ('completed', 'ignored', 'dead')
           ORDER BY received_at
           LIMIT $2
        )`,
      `-- tenant: system — общесистемное применение политики хранения
       DELETE FROM telegram_outbox
        WHERE id IN (
          SELECT id FROM telegram_outbox
           WHERE created_at < now() - make_interval(days => $1)
             AND status IN ('sent', 'dead')
           ORDER BY created_at
           LIMIT $2
        )`,
    ],
  },
  dead_letters: {
    count: [`-- tenant: system — общесистемное применение политики хранения
            SELECT count(*)::int AS value FROM job_dead_letters
             WHERE created_at < now() - make_interval(days => $1)`],
    apply: [`-- tenant: system — общесистемное применение политики хранения
            DELETE FROM job_dead_letters
             WHERE id IN (
               SELECT id FROM job_dead_letters
                WHERE created_at < now() - make_interval(days => $1)
                ORDER BY created_at
                LIMIT $2
             )`],
  },
  metrics_aggregated: {
    count: [`-- tenant: system — общесистемное применение политики хранения
            SELECT count(*)::int AS value FROM job_mirror_samples
             WHERE created_at < now() - make_interval(days => $1)`],
    apply: [`-- tenant: system — общесистемное применение политики хранения
            DELETE FROM job_mirror_samples
             WHERE id IN (
               SELECT id FROM job_mirror_samples
                WHERE created_at < now() - make_interval(days => $1)
                ORDER BY created_at
                LIMIT $2
             )`],
  },
  // app_logs и media_temp живут вне PostgreSQL: журналы — в драйвере
  // логов Docker, временные файлы — в media-service. Политика для них
  // объявлена и показывается, но исполняет её не этот код, и делать
  // вид, что исполняет, нельзя.
  app_logs: {
    count: [`SELECT 0::int AS value`],
  },
  media_temp: {
    count: [`SELECT 0::int AS value`],
  },
};

export interface RetentionOptions {
  /** Размер пакета удаления. Маленький намеренно. */
  batchSize?: number;
  /** Сколько пакетов за один заход. Ограничивает длительность задания. */
  maxBatches?: number;
}

export class RetentionService {
  private readonly batchSize: number;
  private readonly maxBatches: number;

  constructor(
    private readonly db: RetentionDatabase,
    private readonly logger: Logger,
    private readonly enabled: boolean,
    options: RetentionOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 500;
    this.maxBatches = options.maxBatches ?? 10;
  }

  get active(): boolean {
    return this.enabled;
  }

  /** Предпросмотр: считает и ничего не трогает. Доступен всегда. */
  async preview(settings: Record<string, unknown> = {}): Promise<RetentionReport> {
    return await this.run(settings, { dryRun: true });
  }

  /**
   * Применение политик.
   *
   * Выключённый флаг не выполняет удаление, но и не притворяется: он
   * возвращает тот же отчёт, что и предпросмотр, с пометкой `dryRun`.
   */
  async enforce(
    settings: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<RetentionReport> {
    return await this.run(settings, { dryRun: !this.enabled, signal });
  }

  private async run(
    settings: Record<string, unknown>,
    options: { dryRun: boolean; signal?: AbortSignal },
  ): Promise<RetentionReport> {
    const policies = effectivePolicies(settings);
    const holds = await this.activeHolds();
    const classes: RetentionClassReport[] = [];

    for (const item of RETENTION_CLASSES) {
      if (options.signal?.aborted) break;
      const seconds = policies[item.code];
      const days = seconds ? Math.round(seconds / 86_400) : null;
      const held = holds.has(item.code);
      const report: RetentionClassReport = {
        code: item.code,
        title: item.title,
        action: item.action,
        days,
        eligible: 0,
        affected: 0,
        held,
        targets: item.targets,
      };

      if (item.action === "manual") {
        report.note = "Удаляется только по решению пользователя";
        classes.push(report);
        continue;
      }
      if (item.action === "external") {
        report.note = "Срок настраивается на стороне внешней системы";
        classes.push(report);
        continue;
      }

      const queries = RETENTION_QUERIES[item.code];
      if (!queries || days === null) {
        report.note = "Исполняется вне этого сервиса";
        classes.push(report);
        continue;
      }

      // Счётчик суммируется по всем источникам класса: «сырой payload
      // Telegram» — это и входящие, и исходящие.
      for (const sql of queries.count) {
        report.eligible += await this.count(sql, days);
      }
      if (!queries.apply) {
        report.note = "Исполняется вне этого сервиса";
        classes.push(report);
        continue;
      }
      if (held) {
        // Задержка останавливает удаление целиком, а не «частично»:
        // частичное удаление под инцидентом — худший исход, чем его
        // отсутствие.
        report.note = "Удаление приостановлено активной задержкой";
        await this.record(item, report, options.dryRun, "skipped");
        classes.push(report);
        continue;
      }
      if (!options.dryRun && report.eligible > 0) {
        for (const sql of queries.apply) {
          report.affected += await this.applyBatches(item, sql, days, options.signal);
        }
      }
      await this.record(item, report, options.dryRun, "succeeded");
      classes.push(report);
    }

    return {
      dryRun: options.dryRun,
      classes,
      backupRotationDays: BACKUP_ROTATION_DAYS,
      generatedAt: new Date().toISOString(),
    };
  }

  private async count(sql: string, days: number): Promise<number> {
    try {
      const { rows } = await this.db.withSystemScope(
        "retention.count",
        async () => await this.db.query(sql, [days]),
        { crossUser: true },
      );
      return Number(rows[0]?.value ?? 0);
    } catch (error) {
      this.logger.warn("Не удалось посчитать подпадающие строки", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
      return 0;
    }
  }

  /**
   * Удалить пакетами.
   *
   * Заход ограничен и по числу пакетов, и по сигналу отмены: задание не
   * имеет права выполняться дольше своего дедлайна, а остаток дождётся
   * следующего захода — выборка идёт по возрасту, и она не сдвигается.
   */
  private async applyBatches(
    item: RetentionClass,
    sql: string,
    days: number,
    signal?: AbortSignal,
  ): Promise<number> {
    let affected = 0;
    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      if (signal?.aborted) break;
      try {
        const result = await this.db.withSystemScope(
          "retention.apply",
          async () => await this.db.query(sql, [days, this.batchSize]),
          { crossUser: true },
        );
        const rows = result.rowCount ?? 0;
        affected += rows;
        if (rows < this.batchSize) break;
      } catch (error) {
        this.logger.warn("Пакет удаления не выполнен", {
          class: item.code,
          code: error instanceof Error ? error.name : "unknown_error",
        });
        break;
      }
    }
    if (affected > 0) {
      this.logger.info("Политика хранения применена", { class: item.code, affected });
    }
    return affected;
  }

  /** Активные задержки по классам. Просроченные не считаются. */
  private async activeHolds(): Promise<Set<string>> {
    try {
      const { rows } = await this.db.withSystemScope(
        "retention.holds",
        async () => await this.db.query(
          `-- tenant: system — задержки ставятся оператором на класс данных
           SELECT DISTINCT data_class FROM retention_holds
            WHERE released_at IS NULL AND expires_at > now()`,
        ),
        { crossUser: true },
      );
      return new Set(rows.map((row) => String(row.data_class)));
    } catch (error) {
      // Неизвестно, есть ли задержки — значит удалять нельзя: отказ
      // чтения не должен превращаться в разрешение.
      this.logger.warn("Не удалось прочитать задержки удаления: удаление пропущено", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
      return new Set(RETENTION_CLASSES.map((item) => item.code));
    }
  }

  private async record(
    item: RetentionClass,
    report: RetentionClassReport,
    dryRun: boolean,
    status: string,
  ): Promise<void> {
    try {
      await this.db.withSystemScope(
        "retention.record",
        async () => await this.db.query(
          `INSERT INTO retention_runs
             (data_class, dry_run, examined, affected, held, status, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [item.code, dryRun, report.eligible, report.affected, report.held ? 1 : 0, status],
        ),
      );
    } catch (error) {
      this.logger.warn("Прогон удаления не записан", {
        class: item.code,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}
