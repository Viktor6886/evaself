/**
 * Сборка слоя фоновых заданий.
 *
 * Одна точка входа: сервис получает собранный слой или не получает
 * ничего. Промежуточного состояния «реестр есть, журнала нет» не
 * существует — оно означало бы задания без канонической записи.
 *
 * Флаг выключен — слой не собирается вовсе. Намерения при этом всё равно
 * можно записывать в `job_outbox`: запись идёт в PostgreSQL, ничего не
 * знает про Valkey и после включения флага будет опубликована. Это же
 * свойство отвечает на требование 10 шага: недоступный Valkey задерживает
 * публикацию, но не превращает вебхук в синхронного исполнителя.
 */

import type { Redis } from "ioredis";

import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { ConversationPurposeService } from "../conversations/purpose-service.js";
import type { OutboxDelivery } from "../delivery/outbox.js";
import type { LettaService } from "../letta.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";
import type { UserTurnLock } from "../turns/user-turn-lock.js";
import { TemporalBackfill } from "../memory/temporal/backfill.js";
import { AgentJobRunner } from "./agent-job.js";
import { BullMqJobDriver } from "./bullmq-driver.js";
import { ReconcileService } from "./maintenance.js";
import { RetentionService } from "../retention/service.js";
import { MirrorRecorder } from "./mirror.js";
import { LettaProactiveComposer } from "./proactive/composer.js";
import { proactiveStage, legacySchedulerActive } from "./proactive/cutover.js";
import { OutboxProactiveDelivery } from "./proactive/delivery.js";
import type { ProactiveKind } from "./proactive/policy.js";
import { ProactiveRunner } from "./proactive/runner.js";
import { ProactiveSelection } from "./proactive/selection.js";
import { ProactiveService } from "./proactive/service.js";
import { JobOutbox } from "./job-outbox.js";
import { JobRunJournal } from "./job-runs.js";
import { QueueRegistry } from "./queue-registry.js";
import { JobRuntime } from "./runtime.js";
import { JobScheduleRegistry } from "./schedules.js";

export interface JobLayer {
  registry: QueueRegistry;
  outbox: JobOutbox;
  runs: JobRunJournal;
  runtime: JobRuntime;
  schedules: JobScheduleRegistry;
  /** Универсальный фоновый ход агента. Продуктовых заданий пока не несёт. */
  agentJobs: AgentJobRunner;
  /** Политики хранения: предпросмотр доступен и при выключенном удалении. */
  retention: RetentionService;
  /** Запускать ли старые интервалы планировщика. */
  legacySchedulerActive: boolean;
  /** Сверка расписаний и запуск публикатора. */
  start(): Promise<void>;
  /** Остановка без `process.exit`: сначала drain, потом закрытие соединений. */
  stop(drainMs: number): Promise<void>;
}

/**
 * Чем слой заданий пользуется из остального сервиса.
 *
 * Клиента Telegram здесь нет намеренно: доставка проактивных сообщений
 * идёт только через durable outbox, и отправить напрямую воркеру нечем
 * (требование 9 шага 8).
 */
export interface JobLayerDeps {
  letta: LettaService;
  purposes: ConversationPurposeService;
  runtimeContext: RuntimeContextBuilder;
  lock: UserTurnLock;
  outbox: OutboxDelivery;
  /** Выборка старого интервала для режима зеркала. */
  legacySelector?: (kind: ProactiveKind) => Promise<string[]> | null;
  /** Действующие значения настроек: сроки хранения приходят оттуда. */
  settings?: () => Record<string, unknown>;
}

export function buildJobLayer(
  config: Config,
  db: Database,
  redis: Redis,
  logger: Logger,
  deps: JobLayerDeps,
): JobLayer {
  const driver = new BullMqJobDriver(redis);
  const registry = new QueueRegistry(driver, logger);
  const runs = new JobRunJournal(db, logger);
  const runtime = new JobRuntime(db, registry, runs, logger);
  const schedules = new JobScheduleRegistry(db, registry, logger);
  const outbox = new JobOutbox(db, registry, logger, {
    batchSize: config.jobOutboxBatchSize,
    pollMs: config.jobOutboxPollMs,
  });
  const agentJobs = new AgentJobRunner(
    db,
    deps.letta,
    deps.purposes,
    deps.runtimeContext,
    logger,
    config.agentJobsEnabled,
  );

  // Сверки обслуживания переносятся первыми: они ничего не отправляют
  // человеку, и ошибка в них видна в журнале, а не в его переписке.
  const retention = new RetentionService(db, logger, config.retentionEnforcementEnabled);

  if (config.bullmqMaintenanceEnabled) {
    const reconcile = new ReconcileService(db, logger);
    runtime.register("maintenance_reconcile", async (context) => {
      const report = await reconcile.run(context.signal);
      logger.info("Сверка обслуживания выполнена", {
        total: report.total,
        degraded: report.degraded,
      });
    });
    // Применение политик хранения — тоже задача обслуживания: она
    // никому не пишет и работает маленькими пакетами. Выключенный
    // EVA_RETENTION_ENFORCEMENT оставляет её предпросмотром.
    runtime.register("retention_enforce", async (context) => {
      const report = await retention.enforce(deps.settings?.() ?? {}, context.signal);
      logger.info("Политики хранения применены", {
        dryRun: report.dryRun,
        classes: report.classes.length,
        affected: report.classes.reduce((sum, item) => sum + item.affected, 0),
      });
    });
  }

  // Перенос памяти на temporal-путь — тоже обслуживание: он никому не
  // пишет и идёт партиями. Одна партия на запуск задания: прогресс
  // хранится в PostgreSQL, поэтому прерванный перенос продолжается со
  // следующего запуска, а не начинается заново.
  if (config.bullmqMaintenanceEnabled && config.temporalMemoryEnabled) {
    const backfill = new TemporalBackfill();
    runtime.register("memory_temporal_backfill", async () => {
      const result = await db.withSystemScope(
        "memory.temporal.backfill",
        async () => await backfill.runBatch(db, { batchSize: 200 }),
        { crossUser: true },
      );
      logger.info("Партия переноса temporal-памяти выполнена", {
        migrated: result.migrated,
        skipped: result.skipped,
        done: result.done,
      });
    });
  }

  const stage = proactiveStage({
    proactiveEnabled: config.bullmqProactiveEnabled,
    mirrorMode: config.jobsMirrorMode,
  });

  if (config.bullmqProactiveEnabled) {
    const runner = new ProactiveRunner(
      new ProactiveSelection(db),
      new ProactiveService(
        db,
        new LettaProactiveComposer(
          deps.letta,
          deps.purposes,
          deps.runtimeContext,
          deps.lock,
          logger,
        ),
        new OutboxProactiveDelivery(deps.outbox),
        logger,
      ),
      new MirrorRecorder(db, logger),
      stage,
      logger,
      deps.legacySelector ?? (() => null),
      {
        morningHour: config.checkinMorningHour,
        eveningHour: config.checkinEveningHour,
      },
    );
    const kinds: Array<[string, ProactiveKind]> = [
      ["proactive_reminder", "reminder"],
      ["proactive_heartbeat", "heartbeat"],
      ["checkin_morning", "checkin_morning"],
      ["checkin_evening", "checkin_evening"],
    ];
    for (const [jobType, kind] of kinds) {
      runtime.register(jobType, async (context) => {
        await runner.tick(kind, { runId: context.runId, signal: context.signal });
      });
    }
  }

  return {
    registry,
    outbox,
    runs,
    runtime,
    schedules,
    agentJobs,
    retention,
    legacySchedulerActive: legacySchedulerActive(stage),
    async start(): Promise<void> {
      // Сверка идёт до публикатора: расписание, потерянное вместе с
      // томом Valkey, должно вернуться раньше, чем слой начнёт работу.
      const summary = await schedules.reconcile();
      logger.info("Расписания заданий сверены", { ...summary });
      logger.info("Ступень переноса проактивных задач", {
        stage,
        legacyScheduler: legacySchedulerActive(stage),
        handlers: runtime.registeredTypes,
      });
      outbox.start();
    },
    async stop(drainMs: number): Promise<void> {
      outbox.stop();
      // `runtime.stop` закрывает очереди реестра сам; соединения
      // драйвера отпускаются после него, чтобы закрытие очередей успело
      // отправить свои команды.
      await runtime.stop(drainMs);
      driver.disconnect();
    },
  };
}

export {
  AgentJobRunner,
  JobOutbox,
  JobRunJournal,
  JobRuntime,
  JobScheduleRegistry,
  QueueRegistry,
  ReconcileService,
};
