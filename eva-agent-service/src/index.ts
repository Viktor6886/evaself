/**
 * Entry point.
 *
 * Boot order matters: the database and Valkey must be reachable before the
 * HTTP surface accepts traffic, but the App Server is allowed to be slow —
 * `/health` reports it as degraded and Telegram updates remain retryable, rather than the whole
 * service refusing to start because Letta is still warming up.
 */

import { Redis } from "ioredis";

import { applyManagedRuntimeConfig } from "./admin/managed-runtime-config.js";
import { AgentToolFactory } from "./agent-tools.js";
import { BackgroundRuntime } from "./background.js";
import { configWarnings, loadConfig, readPersona } from "./config.js";
import { CrisisMonitor } from "./crisis.js";
import { ConversationPurposeService } from "./conversations/purpose-service.js";
import { Database } from "./db.js";
import { ParallelInboxDispatcher } from "./delivery/dispatcher.js";
import { PostgresTelegramInbox, TelegramInboxWorker } from "./delivery/inbox.js";
import { PostgresTelegramOutbox } from "./delivery/outbox.js";
import { TelegramDeliveryLimiter } from "./delivery/telegram-limits.js";
import { EvaWorkflow } from "./eva-workflow.js";
import { GoalService } from "./goals/goal-service.js";
import { buildJobLayer } from "./jobs/index.js";
import { buildObservability } from "./observability/index.js";
import { LettaService } from "./letta.js";
import { LlmManager } from "./llm.js";
import { createLogger } from "./logger.js";
import { GraphContextService } from "./memory/graph-context.js";
import { ConversationHighlightService } from "./memory/conversation-highlights.js";
import { GraphRepository } from "./memory/graph-repository.js";
import { LavaPayments } from "./payments.js";
import { UserProfileService } from "./profile/profile-service.js";
import { ValkeyRateLimiter } from "./public/rate-limit.js";
import { ValkeyMiniAppSessions } from "./public/webapp-session.js";
import { UserTurnLock } from "./turns/user-turn-lock.js";
import { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import { SdkSettingsManager } from "./sdk-settings.js";
import { buildServer, VERSION } from "./server.js";
import { TelegramClient } from "./telegram.js";
import { TimezoneResolver } from "./time/timezone-resolver.js";
import { TurnAggregator } from "./turns/aggregator.js";
import { EffectJournal } from "./turns/effect-journal.js";
import { TurnRecoveryService } from "./turns/recovery.js";
import { TurnSemaphores } from "./turns/semaphores.js";
import { TurnLifecycle } from "./turns/turn-lifecycle.js";

async function main(): Promise<void> {
  const config = loadConfig();
  let logger = createLogger(config.logLevel);

  for (const warning of configWarnings(config)) logger.warn(warning);

  if (!config.apiKey) {
    logger.error("EVA_AGENT_API_KEY пуст — все запросы /v1 будут отклонены");
  }

  // Наблюдаемость собирается до всего остального: провайдер трасс обязан
  // существовать раньше модулей, которые инструментируются при загрузке,
  // иначе трассы окажутся пустыми (требование 2 шага 09).
  const observability = buildObservability(config, VERSION, logger);

  const persona = await readPersona(config);
  const db = new Database(config.databaseUrl);
  await db.connect();
  logger.info("PostgreSQL подключён");
  try {
    const managedKeys = await applyManagedRuntimeConfig(config, db);
    logger = createLogger(config.logLevel);
    logger.info("Настройки Config Service применены", { count: managedKeys.length });
  } catch (error) {
    logger.warn("Config Service пока не готов, используются bootstrap-настройки", {
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }

  const redis = new Redis(config.valkeyUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableOfflineQueue: true,
  });
  redis.on("error", (error) => logger.warn("Ошибка Valkey", { message: error.message }));
  const configEvents = redis.duplicate();
  configEvents.on("error", () => logger.warn("Канал Config Service временно недоступен"));
  await configEvents.subscribe("eva.config.changed");
  configEvents.on("message", (_channel, message) => {
    void applyManagedRuntimeConfig(config, db)
      .then(() => logger.info("Кеш Config Service обновлён", {
        event: (() => {
          try {
            const parsed = JSON.parse(message) as { version?: unknown };
            return { version: parsed.version ?? null };
          } catch {
            return { version: null };
          }
        })(),
      }))
      .catch(() => logger.warn("Не удалось обновить кеш Config Service"));
  });

  const queue = new UserTurnLock(redis, { ttlSeconds: config.lockTtlSeconds });
  // Сессии Mini App живут в Valkey: состояние восстановимо, потеря Valkey
  // означает лишь повторное открытие приложения.
  const miniAppSessions = new ValkeyMiniAppSessions(redis);
  const rateLimiter = new ValkeyRateLimiter(redis);
  const letta = new LettaService(config, logger, persona);
  const telegram = new TelegramClient(config, logger);
  const telegramLimiter = new TelegramDeliveryLimiter(redis, {
    globalPerSecond: config.telegramGlobalRate,
    globalBurst: config.telegramGlobalBurst,
    chatPerSecond: config.telegramChatRate,
    chatBurst: config.telegramChatBurst,
  });
  const outbox = new PostgresTelegramOutbox(db, telegram, logger, {
    pollMs: config.telegramOutboxPollMs,
    leaseSeconds: config.telegramOutboxLeaseSeconds,
    maxAttempts: config.telegramOutboxMaxAttempts,
    parallel: config.parallelOutboxEnabled
      ? {
          concurrency: config.outboxConcurrency,
          batchSize: config.outboxBatchSize,
          limits: telegramLimiter,
        }
      : null,
  });
  if (config.outboxEnabled) telegram.setOutbox(outbox);
  const sdk = new SdkSettingsManager(config, db, letta);
  try {
    await sdk.initialize();
  } catch (error) {
    // Во время первого запуска миграции могут ещё применяться контейнером PostgreSQL.
    logger.warn("Настройки SDK пока не загружены, используются безопасные defaults из .env", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const llm = new LlmManager(config, db, letta, logger);
  // Указатель на роутер ставится безусловно и в базу не ходит, поэтому
  // упасть здесь нечему: прежняя обёртка ловила ошибку чтения реестра LLM,
  // которого больше нет.
  await llm.initializeDefaultModel();
  const runtimeContext = new RuntimeContextBuilder(db, {
    defaultTimezone: config.defaultTimezone,
    cacheTtlMs: Math.max(1, config.profileCacheTtlSeconds) * 1_000,
    profileCompletionEnabled: config.profileCompletionEnabled,
    vectorGoalsEnabled: config.vectorGoalsEnabled,
    routingMarkerSecret: config.routerApiKey,
  });
  const graph = config.graphMemoryEnabled ? new GraphRepository(db) : undefined;
  const graphContext = new GraphContextService(
    db,
    {
      enabled: config.graphMemoryEnabled,
      timeoutMs: config.graphContextTimeoutMs,
    },
    logger,
  );
  const highlights = new ConversationHighlightService(db, letta, logger);
  const timezoneResolver = new TimezoneResolver(db);
  const profile = new UserProfileService(
    db,
    timezoneResolver,
    runtimeContext,
    graph,
  );
  const goals = new GoalService(db, runtimeContext, graph);
  // Журнал побочных эффектов включается тем же флагом, что и
  // восстановление: без журнала повтор хода не защищён, и включать одно
  // без другого — значит получить повторные действия.
  const effects = new EffectJournal(db, logger, config.turnRecoveryEnabled);
  const toolFactory = new AgentToolFactory(
    config,
    db,
    telegram,
    logger,
    profile,
    goals,
    graph,
    effects,
  );
  letta.setToolFactory((conversationId) => toolFactory.forConversation(conversationId));
  const crisis = new CrisisMonitor(db, telegram, logger, config.ownerTelegramId);
  // Наблюдатель хода. Флаг выключен по умолчанию: с ним ход пишется в
  // turn_runs, без него не пишется ничего, и путь обработки в обоих
  // случаях один и тот же.
  const turns = new TurnLifecycle(db, logger, config.turnLifecycleEnabled);
  const workflow = new EvaWorkflow(
    config,
    db,
    letta,
    llm,
    queue,
    telegram,
    runtimeContext,
    profile,
    logger,
    crisis,
    graphContext,
    highlights,
    turns,
  );
  const inbox = new PostgresTelegramInbox(db);
  // Уведомление о мёртвой записи одно на оба пути обработки: человек
  // должен узнать про потерянное сообщение независимо от того, каким
  // воркером оно обрабатывалось.
  const notifyDeadUpdate = async (
    record: { updateId: number; chatId: number | null; telegramUserId: number | null },
    error: unknown,
  ): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    await telegram.withDeliveryContext(`telegram-dead:${record.updateId}`, async () => {
      if (record.chatId) {
        await telegram.sendMessage(
          record.chatId,
          "Не получилось обработать сообщение после нескольких попыток. Ошибка сохранена; попробуйте отправить сообщение ещё раз.",
        );
      }
      if (config.ownerTelegramId && config.ownerTelegramId !== record.chatId) {
        await telegram.sendMessage(
          config.ownerTelegramId,
          `Ошибка Евы: update ${record.updateId}, user ${record.telegramUserId ?? "?"}: ${message.slice(0, 1200)}`,
        );
      }
    });
  };
  const inboxWorker = new TelegramInboxWorker(
    inbox,
    async (update) => await workflow.processQueued(update),
    logger,
    {
      pollMs: config.telegramInboxPollMs,
      leaseSeconds: config.telegramInboxLeaseSeconds,
      maxAttempts: config.telegramInboxMaxAttempts,
      onDead: notifyDeadUpdate,
    },
  );
  // Параллельный диспетчер и последовательный воркер читают один и тот
  // же durable inbox. Флаг выбирает, кто из них работает; таблица и её
  // семантика в обоих случаях те же, поэтому откат — это перезапуск с
  // выключенным флагом, а не миграция данных.
  const slots = new TurnSemaphores(redis, {
    total: config.turnSlotsTotal,
    leaseSeconds: Math.max(config.lockTtlSeconds, 60),
  });
  const aggregator = config.turnAggregationEnabled
    ? new TurnAggregator(inbox, logger, {
      debounceMs: config.turnAggregationDebounceMs,
      maxWindowMs: config.turnAggregationWindowMs,
    })
    : undefined;
  const dispatcher = new ParallelInboxDispatcher(
    inbox,
    async (records) => await workflow.processAggregated(records.map((item) => item.payload)),
    logger,
    {
      pollMs: config.telegramInboxPollMs,
      leaseSeconds: config.telegramInboxLeaseSeconds,
      maxAttempts: config.telegramInboxMaxAttempts,
      concurrency: config.inboxConcurrency,
      batchSize: config.inboxBatchSize,
      onDead: notifyDeadUpdate,
    },
    slots,
    aggregator,
    queue,
  );

  const recovery = new TurnRecoveryService(
    db,
    logger,
    effects,
    turns,
    config.turnRecoveryEnabled,
  );
  let recoveryTimer: NodeJS.Timeout | null = null;

  const payments = new LavaPayments(config, db, telegram, logger);
  const purposes = new ConversationPurposeService(db, letta, logger);
  const background = new BackgroundRuntime(
    config,
    db,
    letta,
    queue,
    telegram,
    runtimeContext,
    purposes,
    logger,
  );

  const app = buildServer({
    config,
    logger,
    db,
    letta,
    sdk,
    llm,
    inbox,
    profile,
    goals,
    payments,
    queue,
    telegram,
    slots,
    dispatcher,
    redisPing: async () => (await redis.ping()) === "PONG",
    observability,
    miniAppSessions,
    rateLimiter,
  });

  await app.listen({ port: config.port, host: config.host });
  if (config.outboxEnabled) outbox.start();
  if (config.parallelInboxEnabled) dispatcher.start();
  else inboxWorker.start();
  // Сочетание флагов проверяет `configWarnings`: заход без жизненного
  // цикла принимал бы решения, применить их не мог и оставлял бы по
  // строке в журнале попыток каждые тридцать секунд.
  if (config.turnRecoveryEnabled && turns.active) {
    recoveryTimer = setInterval(() => void recovery.sweep(), config.turnRecoveryIntervalMs);
    recoveryTimer.unref();
  }
  // Слой фоновых заданий. Ступень переноса решает, кто ведёт напоминания
  // и heartbeat: пока идёт зеркало — старые интервалы, после снятия
  // зеркала — очередь, и тогда интервалы не запускаются вовсе.
  const jobs = config.bullmqJobsEnabled
    ? buildJobLayer(config, db, redis, logger, {
      letta,
      purposes,
      runtimeContext,
      lock: queue,
      outbox,
      // Выборка старого интервала для режима зеркала. Сравнивать есть с
      // чем только у тех видов, у которых старый механизм существует:
      // check-in до этого шага не было вовсе.
      legacySelector: (kind) =>
        kind === "reminder" || kind === "heartbeat"
          ? background.previewSelection(kind)
          : null,
    })
    : null;
  background.start(jobs ? jobs.legacySchedulerActive : true);
  if (jobs) {
    await jobs.start().catch((error: unknown) => {
      // Недоступный Valkey не должен мешать сервису отвечать людям:
      // намерения продолжают копиться в PostgreSQL, публикатор поднимет
      // их после восстановления брокера.
      logger.warn("Слой фоновых заданий не стартовал", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    });
  }
  logger.info("eva-agent-service принимает запросы", {
    version: VERSION,
    port: config.port,
    inbox: config.parallelInboxEnabled ? "parallel" : "sequential",
    outbox: config.parallelOutboxEnabled ? "parallel" : "sequential",
    concurrency: config.parallelInboxEnabled ? config.inboxConcurrency : 1,
    aggregation: config.turnAggregationEnabled,
    appServer: config.appServerUrl,
    model: config.model || "(app server default)",
  });

  // A slow probe at boot is informational only.
  void letta.ping().then((result) => {
    if (result.ok) logger.info("App Server доступен", { models: result.models });
    else logger.warn("App Server пока недоступен", { error: result.error });
  });

  const shutdown = async (signal: string) => {
    logger.info("Остановка сервиса", { signal });
    try {
      background.stop();
      if (recoveryTimer) clearInterval(recoveryTimer);
      dispatcher.stop();
      inboxWorker.stop();
      if (config.outboxEnabled) outbox.stop();
      // Оба ожидания идут одновременно, а не по очереди: их сумма
      // иначе превысила бы grace period контейнера, и SIGKILL пришёл бы
      // посреди drain — то есть ожидание не сработало бы вовсе.
      await Promise.all([
        // Слой заданий останавливается вместе с ходами и доставкой:
        // ждать его после них значило бы выйти за grace period.
        jobs ? jobs.stop(config.shutdownDrainMs) : Promise.resolve(),
        // Уже начатые ходы дописываются: аренда записи ещё наша, и
        // бросить её посреди хода значит отдать её другому воркеру с
        // наполовину выполненной работой.
        dispatcher.drain(config.shutdownDrainMs),
        config.parallelOutboxEnabled
          ? outbox.drain(config.shutdownDrainMs)
          : Promise.resolve(),
        config.safeSessionManager
          ? letta.drainSessions(config.sessionDrainMs)
          : Promise.resolve(),
      ]);
      letta.shutdown();
      // Телеметрия сбрасывается последней и уже после остановки приёма:
      // терять её не хочется, но задерживать из-за неё остановку — тем
      // более.
      await observability.shutdown();
      await app.close();
      configEvents.disconnect();
      redis.disconnect();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  createLogger("error").error("Не удалось запустить eva-agent-service", {
    code: error instanceof Error ? error.name : "unknown_error",
  });
  process.exit(1);
});
