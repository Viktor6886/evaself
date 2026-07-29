/**
 * Entry point.
 *
 * Boot order matters: the database and Valkey must be reachable before the
 * HTTP surface accepts traffic, but the App Server is allowed to be slow —
 * `/health` reports it as degraded and Telegram updates remain retryable, rather than the whole
 * service refusing to start because Letta is still warming up.
 */

import { Redis } from "ioredis";

import { AgentToolFactory } from "./agent-tools.js";
import { BackgroundRuntime } from "./background.js";
import { loadConfig, readPersona } from "./config.js";
import { Database } from "./db.js";
import { PostgresTelegramInbox, TelegramInboxWorker } from "./delivery/inbox.js";
import { PostgresTelegramOutbox } from "./delivery/outbox.js";
import { EvaWorkflow } from "./eva-workflow.js";
import { LettaService } from "./letta.js";
import { LlmManager } from "./llm.js";
import { createLogger } from "./logger.js";
import { LavaPayments } from "./payments.js";
import { UserQueue } from "./queue.js";
import { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import { SdkSettingsManager } from "./sdk-settings.js";
import { buildServer, VERSION } from "./server.js";
import { TelegramClient } from "./telegram.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (!config.apiKey) {
    logger.error("EVA_AGENT_API_KEY пуст — все запросы /v1 будут отклонены");
  }

  const persona = await readPersona(config);
  const db = new Database(config.databaseUrl);
  await db.connect();
  logger.info("PostgreSQL подключён");

  const redis = new Redis(config.valkeyUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableOfflineQueue: true,
  });
  redis.on("error", (error) => logger.warn("Ошибка Valkey", { message: error.message }));

  const queue = new UserQueue(redis, { ttlSeconds: config.lockTtlSeconds });
  const letta = new LettaService(config, logger, persona);
  const telegram = new TelegramClient(config, logger);
  const outbox = new PostgresTelegramOutbox(db, telegram, logger, {
    pollMs: config.telegramOutboxPollMs,
    leaseSeconds: config.telegramOutboxLeaseSeconds,
    maxAttempts: config.telegramOutboxMaxAttempts,
  });
  telegram.setOutbox(outbox);
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
  try {
    await llm.initializeDefaultModel();
  } catch (error) {
    // На чистой установке контейнер может стартовать до migration 004.
    // После миграций install.sh импортирует первую конфигурацию из .env.
    logger.warn("Реестр LLM пока не готов", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const toolFactory = new AgentToolFactory(config, db, telegram, logger);
  letta.setToolFactory((conversationId) => toolFactory.forConversation(conversationId));
  const runtimeContext = new RuntimeContextBuilder(db, {
    defaultTimezone: config.defaultTimezone,
  });
  const workflow = new EvaWorkflow(
    config,
    db,
    letta,
    llm,
    queue,
    telegram,
    runtimeContext,
    logger,
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
  const background = new BackgroundRuntime(
    config,
    db,
    letta,
    queue,
    telegram,
    runtimeContext,
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
    payments,
    queue,
    redisPing: async () => (await redis.ping()) === "PONG",
  });

  await app.listen({ port: config.port, host: config.host });
  outbox.start();
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
      outbox.stop();
      letta.shutdown();
      await app.close();
      await db.close();
      redis.disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      service: "eva-agent-service",
      message: "failed to start",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
