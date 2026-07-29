import { Redis } from "ioredis";
import pg from "pg";

import { createLogger } from "../logger.js";
import { HealthWorker } from "./health-worker.js";
import { UpdaterClient } from "./updater-client.js";

const { Pool } = pg;

async function main() {
  const logger = createLogger(
    process.env.EVA_ADMIN_LOG_LEVEL ?? "info",
    "evaself-health-worker",
  );
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const valkeyUrl = (process.env.VALKEY_URL ?? "").trim();
  if (!databaseUrl || !valkeyUrl) throw new Error("DATABASE_URL и VALKEY_URL обязательны");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 6,
    application_name: "evaself-health-worker",
  });
  const redis = new Redis(valkeyUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  redis.on("error", () => logger.warn("Valkey временно недоступен"));
  await pool.query("SELECT 1");
  await redis.ping();

  const worker = new HealthWorker(pool, redis, new UpdaterClient(), logger);
  worker.start();
  logger.info("health-worker запущен", {
    interval_seconds: process.env.EVA_HEALTH_INTERVAL_SECONDS ?? "60",
  });

  const shutdown = async (signal: string) => {
    logger.info("Остановка health-worker", { signal });
    worker.stop();
    redis.disconnect();
    await pool.end();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  createLogger("error", "evaself-health-worker").error(
    "Не удалось запустить health-worker",
    { code: error instanceof Error ? error.name : "unknown_error" },
  );
  process.exit(1);
});
