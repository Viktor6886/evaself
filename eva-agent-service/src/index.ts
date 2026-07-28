/**
 * Entry point.
 *
 * Boot order matters: the database and Valkey must be reachable before the
 * HTTP surface accepts traffic, but the App Server is allowed to be slow —
 * `/health` reports it as degraded and n8n retries, rather than the whole
 * service refusing to start because Letta is still warming up.
 */

import { Redis } from "ioredis";

import { loadConfig, readPersona } from "./config.js";
import { Database } from "./db.js";
import { LettaService } from "./letta.js";
import { LlmManager } from "./llm.js";
import { createLogger } from "./logger.js";
import { UserQueue } from "./queue.js";
import { buildServer, VERSION } from "./server.js";

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

  const app = buildServer({
    config,
    logger,
    db,
    letta,
    llm,
    queue,
    redisPing: async () => (await redis.ping()) === "PONG",
  });

  await app.listen({ port: config.port, host: config.host });
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
