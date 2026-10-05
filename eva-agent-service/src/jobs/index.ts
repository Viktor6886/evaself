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
import type { TelegramClient } from "../telegram.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";
import type { UserTurnLock } from "../turns/user-turn-lock.js";
import { BullMqJobDriver } from "./bullmq-driver.js";
import { ReconcileService } from "./maintenance.js";
import { RetentionService } from "../retention/service.js";
import { MirrorRecorder } from "./mirror.js";
import { LiveMessageWatch } from "../turns/live-message.js";
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
import { ResearchJobWorker, researchJobTiming } from "../research/worker.js";
import { SearxCrawlAdapters } from "../research/adapters.js";
import { UsernameProfilesCollector, WebSearchCollector } from "../osint/collectors.js";
import { HarvesterCollector, InfrastructureCollector, SpiderfootCollector } from "../osint/infra-collectors.js";
import { HarvesterClient, SpiderfootClient } from "../osint/service-clients.js";
import { EgrulCollector } from "../osint/registry-collectors.js";
import { OSINT_JOB_TIMING, OsintJobWorker, osintCollectorEnabled } from "../osint/job.js";
import { LettaOsintNarrator } from "../osint/narrator.js";
import { OSINT_JOB_TYPE } from "../osint/service.js";
import { OsintWorkerClient } from "../osint/worker-client.js";
import { jobProcessor } from "./consumer.js";
import type { JobQueueDriver, JobQueueName } from "./queue-registry.js";
import { KnowledgeIngestWorker, KNOWLEDGE_INGEST_JOB, KNOWLEDGE_INGEST_TIMING } from "../knowledge/lifecycle.js";
import { scanKnowledgeDocument } from "../knowledge/ingestion.js";
import { parseJobEnvelope } from "./envelope.js";
import { KNOWLEDGE_INDEX_JOB, KNOWLEDGE_INDEX_TIMING, KnowledgeIndexer, knowledgeIndexScheduler } from "../knowledge/indexer.js";
import {
  KNOWLEDGE_MAINTENANCE_TIMING,
  KNOWLEDGE_REBUILD_JOB,
  KNOWLEDGE_RECONCILE_JOB,
  KnowledgeMaintenance,
} from "../knowledge/maintenance.js";
import { QdrantClient } from "../knowledge/qdrant-client.js";
import { KnowledgeVectorStore } from "../knowledge/vector-store.js";
import { LlmRouterClient } from "../router/client.js";

export interface JobLayer {
  registry: QueueRegistry;
  outbox: JobOutbox;
  runs: JobRunJournal;
  runtime: JobRuntime;
  schedules: JobScheduleRegistry;
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
  /** Исследование субагентами Letta; без него работает конвейер. */
  researchDelegation?: NonNullable<ConstructorParameters<typeof ResearchJobWorker>[2]["delegation"]>;
  letta: LettaService;
  purposes: ConversationPurposeService;
  runtimeContext: RuntimeContextBuilder;
  lock: UserTurnLock;
  outbox: OutboxDelivery;
  /** Выборка старого интервала для режима зеркала. */
  legacySelector?: (kind: ProactiveKind) => Promise<string[]> | null;
  /**
   * Заход инициативы. Собирается в точке сборки и передаётся сюда, а не
   * строится заново: механизмов запуска два, а заход обязан быть один
   * (инвариант 9). Пока идут старые интервалы, задание не регистрируется
   * вовсе — иначе окно сработало бы дважды.
   */
  initiative?: { tick(options?: { runId?: string; signal?: AbortSignal }): Promise<unknown> } | null;
  /** Действующие значения настроек: сроки хранения приходят оттуда. */
  settings?: () => Record<string, unknown>;
  /**
   * Драйвер очередей. В сервисе — BullMQ поверх того же Valkey; подмена
   * нужна проверке «у каждой очереди с обработчиками есть потребитель»,
   * которой иначе понадобился бы живой Valkey.
   */
  driver?: JobQueueDriver;
  /**
   * Отправка текста Евы тем же путём, что её ответы: разметка Telegram,
   * деление длинного текста, durable outbox. Без него итог исследования
   * приходит шаблоном.
   */
  telegram?: Pick<TelegramClient, "withDeliveryContext" | "sendMessage">;
}

export function buildJobLayer(
  config: Config,
  db: Database,
  redis: Redis,
  logger: Logger,
  deps: JobLayerDeps,
): JobLayer {
  const bull = deps.driver ? null : new BullMqJobDriver(redis);
  const driver: JobQueueDriver = deps.driver ?? bull!;
  const registry = new QueueRegistry(driver, logger);
  const runs = new JobRunJournal(db, logger);
  const runtime = new JobRuntime(db, registry, runs, logger);
  const schedules = new JobScheduleRegistry(db, registry, logger);
  const outbox = new JobOutbox(db, registry, logger, {
    batchSize: config.jobOutboxBatchSize,
    pollMs: config.jobOutboxPollMs,
  });
  /**
   * Очереди, которые этот процесс исполняет, и сколько заданий каждой
   * идёт одновременно. Очередь попадает сюда вместе с обработчиками,
   * которые в ней живут: потребитель без обработчика отправлял бы
   * задания в DLQ с `job_handler_missing`.
   */
  const consumed = new Map<JobQueueName, number>();
  // База знаний: обработчики регистрируются всегда, независимо от
  // EVA_KNOWLEDGE_UPLOADS. Флаг закрывает только приём новых загрузок, а
  // удаление, переиндексация, перестройка и сверка ставятся и при нём
  // выключенном: без обработчиков их задания навсегда оставались бы в
  // очереди, а удалённый документ — в Qdrant и на диске. Загрузка,
  // принятая до выключения флага, тоже дорабатывается, а не висит `queued`.
  const router = new LlmRouterClient(config.routerUrl, config.routerApiKey);
  // Индексация в Qdrant (docs/knowledge-base.md): без ключа Qdrant не
  // используется вовсе, и задания индексации новых документов не ставятся.
  // Задания удаления ставятся всегда: исходный файл удалённого документа
  // снимается и без Qdrant.
  const configured = (): boolean => Boolean(config.qdrantApiKey);
  const indexEnabled = (): boolean => config.knowledgeIndexEnabled && configured();
  const uploadsRoot = "/data/knowledge-uploads";
  const scheduler = knowledgeIndexScheduler(outbox, indexEnabled);
  const knowledge = new KnowledgeIngestWorker(db, {
    tempRoot: "/tmp",
    embed: (text, signal) => router.embed(text, signal),
    embedBatch: (texts, signal) => router.embedLegacyMany(texts, signal),
    legacyEmbeddings: () => config.knowledgeSearchMode === "legacy" || config.knowledgeVectorBackend !== "qdrant",
    embedBatchSize: () => config.knowledgeEmbeddingBatch,
    chunking: () => ({ size: config.knowledgeChunkSize, overlap: config.knowledgeChunkOverlap }),
    index: scheduler,
    scan: scanKnowledgeDocument,
  });
  const store = new KnowledgeVectorStore(new QdrantClient({ url: config.qdrantUrl || "http://qdrant:6333", apiKey: config.qdrantApiKey ?? "" }));
  const indexer = new KnowledgeIndexer(db, router, store, {
    enabled: indexEnabled,
    configured,
    batchSize: () => config.knowledgeEmbeddingBatch,
    uploadsRoot,
    jobs: scheduler,
  });
  const maintenance = new KnowledgeMaintenance(db, store, indexer, {
    enabled: indexEnabled,
    configured,
    uploadsRoot,
    outbox,
    index: scheduler,
  });
  registry.queue("memory");
  runtime.register(KNOWLEDGE_INGEST_JOB, async (context) => await knowledge.run(context), KNOWLEDGE_INGEST_TIMING);
  runtime.register(KNOWLEDGE_INDEX_JOB, async (context) => { await indexer.run(context); }, KNOWLEDGE_INDEX_TIMING);
  runtime.register(KNOWLEDGE_REBUILD_JOB, async (context) => {
    const result = await maintenance.rebuild(context);
    logger.info("Перестройка индекса базы знаний: порция", { status: result.status, processed: result.processed });
  }, KNOWLEDGE_MAINTENANCE_TIMING);
  runtime.register(KNOWLEDGE_RECONCILE_JOB, async (context) => {
    const report = await maintenance.reconcile(context.signal);
    logger.info("Сверка индекса базы знаний", { ...report });
  }, KNOWLEDGE_MAINTENANCE_TIMING);
  // Без потребителя загрузка навсегда оставалась `queued`: публикатор
  // ставил задание в Valkey, а забирать его было некому. По одному:
  // антивирус и эмбеддинги тяжёлые, а загрузки редки.
  consumed.set("memory", 1);

  if (config.researchOrchestratorEnabled) {
    const research = new ResearchJobWorker(db, deps.outbox, {
      searxUrl: config.searxngUrl,
      crawlUrl: config.crawl4aiUrl,
      crawlToken: config.crawl4aiToken,
      router: new LlmRouterClient(config.routerUrl, config.routerApiKey),
      ...(deps.researchDelegation ? { delegation: deps.researchDelegation } : {}),
    });
    registry.queue("research");
    // Субагентам нужен свой бюджет сверх срока конвейера — иначе сигнал
    // задания обрывает их раньше, чем успевает запасной конвейер.
    runtime.register(
      "research_run",
      async (context) => await research.run(context),
      deps.researchDelegation?.enabled() ? researchJobTiming(config.delegationTimeoutMs) : {},
    );
  }

  // OSINT-исследование: детерминированные сборщики без модели.
  // Обработчик регистрируется всегда: флаги переключаются в панели без
  // перезапуска, и задание, поставленное при включённом флаге, не должно
  // уйти в dead letter. Включён ли контур и каждый источник — решается
  // в момент выполнения.
  {
    const worker = new OsintWorkerClient({ baseUrl: config.osintWorkerUrl, token: config.osintWorkerToken });
    const web = new SearxCrawlAdapters(config.searxngUrl, config.crawl4aiUrl, { crawlToken: config.crawl4aiToken });
    const services = { token: config.osintWorkerToken };
    const osint = new OsintJobWorker(db, [
      // Реестры и журналы — первыми: они дешёвые и дают следы (адреса,
      // AS, организацию), по которым идут остальные сборщики.
      new InfrastructureCollector(worker),
      new EgrulCollector(worker),
      new HarvesterCollector(new HarvesterClient({ baseUrl: config.osintHarvesterUrl, ...services })),
      new SpiderfootCollector(new SpiderfootClient({ baseUrl: config.osintSpiderfootUrl, ...services })),
      new UsernameProfilesCollector(worker, { topSites: 300 }),
      // Запросов на идентификатор столько, чтобы прошли все записи номера
      // или имени и поиск по открытым страницам соцсетей; страниц — только
      // те, чей сниппет не показал искомого.
      new WebSearchCollector(web, { queriesPerIdentifier: 12, pagesPerIdentifier: 6, maxPageBytes: 512_000 }),
    ], {
      enabled: () => config.osintEnabled,
      collectorEnabled: (name) => osintCollectorEnabled(config, name),
    }, deps.telegram ? {
      // Итог рассказывает сама Ева, как только исследование готово, —
      // человеку не нужно писать ей, чтобы узнать результат.
      narrator: new LettaOsintNarrator(db, deps.letta, deps.runtimeContext, deps.lock),
      send: async (chatId, text, deliveryKey) => {
        const telegram = deps.telegram!;
        await telegram.withDeliveryContext(deliveryKey, async () => await telegram.sendMessage(chatId, text), "reminder");
      },
    } : null);
    registry.queue("research");
    runtime.register(OSINT_JOB_TYPE, async (context) => await osint.run(context), OSINT_JOB_TIMING);
    // Два исследования одновременно: сборщики ходят во внешние сервисы
    // со своими лимитами, и третье только поделило бы их на троих.
    consumed.set("research", 2);
  }

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
    // Сверка и хранение идут маленькими пакетами одна за другой: второе
    // параллельное задание только спорило бы с первым за те же строки.
    consumed.set("maintenance", 1);
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
          // Ход инициативы держит блокировку человека и уступает живому
          // сообщению так же, как выполнение задачи.
          new LiveMessageWatch(db),
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
    // По заданию на вид: заход check-in с ходами Евы длится минуты, и
    // напоминание, которое стоит раз в минуту, не должно ждать его в
    // очереди. Повтор одного вида ловят слот в `proactive_messages` и
    // блокировка человека.
    consumed.set("proactive", kinds.length);
  }

  // Окна инициативы регистрируются только там, где старые интервалы уже
  // не работают. На ступенях `legacy` и `mirror` заход делает
  // `BackgroundRuntime`, и второй владелец означал бы два сообщения в
  // одно окно — от слота спасает только то, что механизм один.
  if (deps.initiative && !legacySchedulerActive(stage)) {
    const initiative = deps.initiative;
    runtime.register("proactive_initiative", async (context) => {
      await initiative.tick({ runId: context.runId, signal: context.signal });
    });
    // Ступень `queue` бывает только при включённой очереди proactive, и
    // окно инициативы получает в ней своё место рядом с остальными видами.
    consumed.set("proactive", (consumed.get("proactive") ?? 0) + 1);
  }

  return {
    registry,
    outbox,
    runs,
    runtime,
    schedules,
    retention,
    legacySchedulerActive: legacySchedulerActive(stage),
    async start(): Promise<void> {
      // Сверка идёт до публикатора: расписание, потерянное вместе с
      // томом Valkey, должно вернуться раньше, чем слой начнёт работу.
      const summary = await schedules.reconcile();
      logger.info("Расписания заданий сверены", { ...summary });
      const expiredUploads = await knowledge.recoverExpiredUploads();
      if (expiredUploads) logger.warn("Просроченные загрузки доступны для повтора", { count: expiredUploads });
      logger.info("Ступень переноса проактивных задач", {
        stage,
        legacyScheduler: legacySchedulerActive(stage),
        handlers: runtime.registeredTypes,
      });
      outbox.start();
      const processor = jobProcessor(runtime, async (data, code) => {
        const parsed = parseJobEnvelope(data);
        if (parsed.ok && parsed.envelope.type === KNOWLEDGE_INGEST_JOB) {
          await knowledge.reject(parsed.envelope, code);
        }
      });
      for (const [queue, concurrency] of consumed) registry.consume(queue, processor, concurrency);
    },
    async stop(drainMs: number): Promise<void> {
      // Сначала перестаём брать новые задания: иначе во время ожидания
      // активных потребитель брал бы следующие, а остановленный runtime
      // возвращал бы их повтором и тратил на это попытки.
      await registry.pauseConsumers();
      outbox.stop();
      // `runtime.stop` закрывает очереди реестра сам; соединения
      // драйвера отпускаются после него, чтобы закрытие очередей успело
      // отправить свои команды.
      await runtime.stop(drainMs);
      bull?.disconnect();
    },
  };
}

export {
  JobOutbox,
  JobRunJournal,
  JobRuntime,
  JobScheduleRegistry,
  QueueRegistry,
  ReconcileService,
};
