/**
 * Prometheus-совместимая выдача /metrics.
 *
 * Смысл здесь один: сделать наблюдаемым то, что до сих пор было видно
 * только в логах и только задним числом — глубина и возраст очередей,
 * сколько ходов идёт прямо сейчас, сколько человек ждут своей очереди,
 * что с пулом PostgreSQL и не встал ли event loop.
 *
 * Пользовательских данных в выдаче нет по построению: только числа и
 * фиксированные метки состояний. Идентификатора пользователя,
 * conversation и текста здесь не появляется — иначе метрики стали бы
 * ещё одним каналом утечки, который никто не читает как утечку.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { Database } from "./db.js";
import type { TurnClass } from "./turns/semaphores.js";
import { TURN_STATES } from "./turns/states.js";

export interface MetricsPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface MetricsSources {
  db: Database;
  /** Сессии Agent SDK: занятые ходом и просто открытые. */
  sessions: () => { active: number; idle: number };
  /** Блокировки пользователей: удерживаемые и ожидающие в FIFO. */
  locks: () => { held: number; queued: number };
  poolStats: () => MetricsPoolStats;
  /** Занятость глобальных слотов хода по классам. */
  slots?: () => Promise<Record<TurnClass, { used: number; limit: number }>>;
  /** Возвраты записи из-за блокировки, занятой другим владельцем. */
  foreignLockReleases?: () => number;
  version: string;
  turnLifecycleEnabled: boolean;
}

interface Sample {
  name: string;
  help: string;
  type: "gauge" | "counter";
  values: Array<{ labels?: Record<string, string>; value: number }>;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function render(samples: Sample[]): string {
  const lines: string[] = [];
  for (const sample of samples) {
    lines.push(`# HELP ${sample.name} ${sample.help}`);
    lines.push(`# TYPE ${sample.name} ${sample.type}`);
    for (const item of sample.values) {
      const labels = item.labels
        ? Object.entries(item.labels)
          .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
          .join(",")
        : "";
      const value = Number.isFinite(item.value) ? item.value : 0;
      lines.push(labels ? `${sample.name}{${labels}} ${value}` : `${sample.name} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function number(value: unknown): number {
  // Драйвер отдаёт bigint и numeric строкой: без приведения в выдачу
  // ушло бы NaN, а Prometheus молча выбросил бы всю метрику.
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export class MetricsCollector {
  private readonly loop: IntervalHistogram;

  constructor(private readonly sources: MetricsSources) {
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
  }

  stop(): void {
    this.loop.disable();
  }

  /**
   * Выдача в текстовом формате Prometheus.
   *
   * Недоступная база не должна ронять сбор: то, что удалось прочитать,
   * отдаётся, остальное остаётся нулями. Метрики нужны в том числе
   * тогда, когда что-то сломалось.
   */
  async render(): Promise<string> {
    const queues = await this.queueDepth();
    const turns = await this.turnStates();
    const timings = await this.turnTimings();
    const sessions = this.sources.sessions();
    const locks = this.sources.locks();
    const pool = this.sources.poolStats();
    const slots = await this.slotUsage();

    const samples: Sample[] = [
      {
        name: "eva_build_info",
        help: "Версия сервиса как метка, значение всегда 1.",
        type: "gauge",
        values: [{ labels: { version: this.sources.version }, value: 1 }],
      },
      {
        name: "eva_turn_lifecycle_enabled",
        help: "Включена ли запись жизненного цикла хода (EVA_TURN_LIFECYCLE).",
        type: "gauge",
        values: [{ value: this.sources.turnLifecycleEnabled ? 1 : 0 }],
      },
      {
        name: "eva_inbox_pending",
        help: "Необработанные Telegram-апдейты в durable inbox.",
        type: "gauge",
        values: [{ value: queues.inboxPending }],
      },
      {
        name: "eva_inbox_oldest_age_seconds",
        help: "Возраст самого старого необработанного апдейта.",
        type: "gauge",
        values: [{ value: queues.inboxOldestSeconds }],
      },
      {
        name: "eva_outbox_pending",
        help: "Неотправленные сообщения в durable outbox.",
        type: "gauge",
        values: [{ value: queues.outboxPending }],
      },
      {
        name: "eva_outbox_oldest_age_seconds",
        help: "Возраст самого старого неотправленного сообщения.",
        type: "gauge",
        values: [{ value: queues.outboxOldestSeconds }],
      },
      {
        name: "eva_turns_active",
        help: "Незавершённые ходы по состояниям.",
        type: "gauge",
        values: TURN_STATES.map((state) => ({
          labels: { state },
          value: turns.get(state) ?? 0,
        })),
      },
      {
        name: "eva_turns_active_total",
        help: "Незавершённые ходы всего.",
        type: "gauge",
        values: [{ value: [...turns.values()].reduce((sum, item) => sum + item, 0) }],
      },
      {
        name: "eva_turn_wait_ms",
        help: "Ожидание хода в очереди за последний час.",
        type: "gauge",
        values: [
          { labels: { stat: "avg" }, value: timings.waitAvg },
          { labels: { stat: "max" }, value: timings.waitMax },
        ],
      },
      {
        name: "eva_turn_duration_ms",
        help: "Длительность завершённого хода за последний час.",
        type: "gauge",
        values: [
          { labels: { stat: "avg" }, value: timings.durationAvg },
          { labels: { stat: "max" }, value: timings.durationMax },
        ],
      },
      {
        name: "eva_turn_samples",
        help: "Сколько ходов за последний час дали измерение.",
        type: "gauge",
        values: [
          { labels: { kind: "wait" }, value: timings.waitCount },
          { labels: { kind: "duration" }, value: timings.durationCount },
        ],
      },
      {
        name: "eva_user_locks",
        help: "Блокировки пользователей: удерживаемые и ожидающие в очереди.",
        type: "gauge",
        values: [
          { labels: { state: "held" }, value: locks.held },
          { labels: { state: "queued" }, value: locks.queued },
        ],
      },
      {
        name: "eva_letta_sessions",
        help: "Сессии Agent SDK: занятые ходом и открытые без хода.",
        type: "gauge",
        values: [
          { labels: { state: "active" }, value: sessions.active },
          { labels: { state: "idle" }, value: sessions.idle },
        ],
      },
      {
        name: "eva_postgres_pool_connections",
        help: "Пул PostgreSQL сервиса.",
        type: "gauge",
        values: [
          { labels: { state: "total" }, value: pool.total },
          { labels: { state: "idle" }, value: pool.idle },
          { labels: { state: "waiting" }, value: pool.waiting },
        ],
      },
      {
        name: "eva_turn_slots_used",
        help: "Занятые глобальные слоты хода по классам.",
        type: "gauge",
        values: Object.entries(slots).map(([turnClass, item]) => ({
          labels: { class: turnClass },
          value: item.used,
        })),
      },
      {
        name: "eva_turn_slots_limit",
        help: "Предел слотов по классам. Резерв входит в интерактивный.",
        type: "gauge",
        values: Object.entries(slots).map(([turnClass, item]) => ({
          labels: { class: turnClass },
          value: item.limit,
        })),
      },
      {
        name: "eva_inbox_foreign_lock_releases_total",
        help: "Возвраты записи из-за блокировки, занятой другим владельцем.",
        type: "counter",
        values: [{ value: this.sources.foreignLockReleases?.() ?? 0 }],
      },
      {
        name: "eva_event_loop_lag_seconds",
        help: "Задержка event loop с момента запуска процесса.",
        type: "gauge",
        values: [
          { labels: { quantile: "0.5" }, value: this.loop.percentile(50) / 1e9 },
          { labels: { quantile: "0.99" }, value: this.loop.percentile(99) / 1e9 },
          { labels: { quantile: "1" }, value: this.loop.max / 1e9 },
        ],
      },
    ];

    return render(samples);
  }

  /**
   * Занятость слотов. Без семафоров (последовательный воркер) классы
   * всё равно перечисляются нулями: пропавшая метрика читается как
   * поломка сбора, а не как выключенная возможность.
   */
  private async slotUsage(): Promise<Record<string, { used: number; limit: number }>> {
    const empty = {
      interactive: { used: 0, limit: 0 },
      background: { used: 0, limit: 0 },
      research: { used: 0, limit: 0 },
    };
    if (!this.sources.slots) return empty;
    try {
      return await this.sources.slots();
    } catch {
      return empty;
    }
  }

  /**
   * Глубина и возраст очередей. Выборка идёт по всем пользователям
   * сразу, поэтому область объявлена системной и `crossUser` явно: из
   * таблиц берутся только счётчики и время, ни одной строки данных.
   */
  private async queueDepth(): Promise<{
    inboxPending: number;
    inboxOldestSeconds: number;
    outboxPending: number;
    outboxOldestSeconds: number;
  }> {
    const empty = {
      inboxPending: 0,
      inboxOldestSeconds: 0,
      outboxPending: 0,
      outboxOldestSeconds: 0,
    };
    try {
      return await this.sources.db.withSystemScope(
        "metrics.queue_depth",
        async () => {
          const { rows } = await this.sources.db.query(
            `-- tenant: system — счётчики очередей по всем пользователям,
             -- ни одной строки данных наружу
             SELECT
               (SELECT count(*) FROM telegram_updates WHERE status = 'processing')
                 AS inbox_pending,
               (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(received_at))), 0)
                  FROM telegram_updates WHERE status = 'processing')
                 AS inbox_oldest,
               (SELECT count(*) FROM telegram_outbox
                 WHERE status IN ('pending', 'sending', 'retry'))
                 AS outbox_pending,
               (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)
                  FROM telegram_outbox
                 WHERE status IN ('pending', 'sending', 'retry'))
                 AS outbox_oldest`,
          );
          const row = rows[0];
          if (!row) return empty;
          return {
            inboxPending: number(row.inbox_pending),
            inboxOldestSeconds: number(row.inbox_oldest),
            outboxPending: number(row.outbox_pending),
            outboxOldestSeconds: number(row.outbox_oldest),
          };
        },
        { crossUser: true },
      );
    } catch {
      return empty;
    }
  }

  private async turnStates(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      await this.sources.db.withSystemScope(
        "metrics.turn_states",
        async () => {
          const { rows } = await this.sources.db.query<{ state: string; active: string }>(
            `-- tenant: system — сводка по всем ходам сервиса,
             -- только состояния и счётчики
             SELECT state, count(*) AS active FROM turn_runs
              WHERE finished_at IS NULL
              GROUP BY state`,
          );
          for (const row of rows) result.set(row.state, number(row.active));
        },
        { crossUser: true },
      );
    } catch {
      // Метрики не обязаны падать вместе с базой.
    }
    return result;
  }

  private async turnTimings(): Promise<{
    waitAvg: number;
    waitMax: number;
    waitCount: number;
    durationAvg: number;
    durationMax: number;
    durationCount: number;
  }> {
    const empty = {
      waitAvg: 0,
      waitMax: 0,
      waitCount: 0,
      durationAvg: 0,
      durationMax: 0,
      durationCount: 0,
    };
    try {
      return await this.sources.db.withSystemScope(
        "metrics.turn_timings",
        async () => {
          const { rows } = await this.sources.db.query(
            `-- tenant: system — агрегаты времени по всем ходам сервиса,
             -- ни одной строки данных наружу
             SELECT
               COALESCE(avg(wait_ms), 0) AS wait_avg,
               COALESCE(max(wait_ms), 0) AS wait_max,
               count(wait_ms) AS wait_count,
               COALESCE(avg(duration_ms), 0) AS duration_avg,
               COALESCE(max(duration_ms), 0) AS duration_max,
               count(duration_ms) AS duration_count
             FROM turn_runs
             WHERE created_at > now() - interval '1 hour'`,
          );
          const row = rows[0];
          if (!row) return empty;
          return {
            waitAvg: number(row.wait_avg),
            waitMax: number(row.wait_max),
            waitCount: number(row.wait_count),
            durationAvg: number(row.duration_avg),
            durationMax: number(row.duration_max),
            durationCount: number(row.duration_count),
          };
        },
        { crossUser: true },
      );
    } catch {
      return empty;
    }
  }
}
