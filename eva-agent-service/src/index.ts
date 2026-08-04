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
import { PostgresTelegramInbox, TelegramInboxWorker } from "./delivery/inbox.js";
import { PostgresTelegramOutbox } from "./delivery/outbox.js";
import { EvaWorkflow } from "./eva-workflow.js";
import { GoalService } from "./goals/goal-service.js";
import { LettaService } from "./letta.js";
import { LlmManager } from "./llm.js";
import { createLogger } from "./logger.js";
import { GraphContextService } from "./memory/graph-context.js";
import { ConversationHighlightService } from "./memory/conversation-highlights.js";
import { GraphRepository } from "./memory/graph-repository.js";
import { LavaPayments } from "./payments.js";
import { UserProfileService } from "./profile/profile-service.js";
import { ValkeyMiniAppSessions } from "./public/webapp-session.js";
import { UserQueue } from "./queue.js";
import { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import { SdkSettingsManager } from "./sdk-settings.js";
import { buildServer, VERSION } from "./server.js";
import { TelegramClient } from "./telegram.js";
import { TimezoneResolver } from "./time/timezone-resolver.js";

async function main(): Promise<void> {
  const config = loadConfig();
  let logger = createLogger(config.logLevel);

  for (const warning of configWarnings(config)) logger.warn(warning);

  if (!config.apiKey) {
    logger.error("EVA_AGENT_API_KEY пуст — все запросы /v1 будут отклонены");
  }

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

  const queue = new UserQueue(redis, { ttlSeconds: config.lockTtlSeconds });
  // Сессии Mini App живут в Valkey: состояние восстановимо, потеря Valkey
  // означает лишь повторное открытие приложения.
  const miniAppSessions = new ValkeyMiniAppSessions(redis);
  const letta = new LettaService(config, logger, persona);
  const telegram = new TelegramClient(config, logger);
  const outbox = new PostgresTelegramOutbox(db, telegram, logger, {
    pollMs: config.telegramOutboxPollMs,
    leaseSeconds: config.telegramOutboxLeaseSeconds,
    maxAttempts: config.telegramOutboxMaxAttempts,
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
  const toolFactory = new AgentToolFactory(
    config,
    db,
    telegram,
    logger,
    profile,
    goals,
    graph,
  );
  letta.setToolFactory((conversationId) => toolFactory.forConversation(conversationId));
  const crisis = new CrisisMonitor(db, telegram, logger, config.ownerTelegramId);
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
  );
  const inbox = new PostgresTelegramInbox(db);
  const inboxWorker = new TelegramInboxWorker(
    inbox,
    async (update) => await workflow.processQueued(update),
    logger,
    {
      pollMs: config.telegramInboxPollMs,
      leaseSeconds: config.telegramInboxLeaseSeconds,
      maxAttempts: config.telegramInboxMaxAttempts,
      onDead: async (record, error) => {
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
      },
    },
  );
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
    redisPing: async () => (await redis.ping()) === "PONG",
    miniAppSessions,
  });

  await app.listen({ port: config.port, host: config.host });
  if (config.outboxEnabled) outbox.start();
  inboxWorker.start();
  background.start();
  logger.info("eva-agent-service принимает запросы", {
    version: VERSION,
    port: config.port,
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
      inboxWorker.stop();
      if (config.outboxEnabled) outbox.stop();
      letta.shutdown();
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
