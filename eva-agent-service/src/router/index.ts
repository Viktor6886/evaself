/**
 * Точка входа сервиса llm-router.
 *
 * Тот же образ, что и eva-agent-service, другая команда — так же, как
 * admin-api, eva-updater и health-worker.
 */

import pg from "pg";
import { Redis } from "ioredis";

import { createLogger } from "../logger.js";
import { guardPool } from "../tenancy/index.js";
import { DEFAULT_OPTIONS, LlmRouter } from "./router.js";
import { ValkeyRouterLimits } from "./limits.js";
import { createRouterServer } from "./server.js";
import { RouterStore } from "./store.js";

const { Pool } = pg;

function intFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function enabled(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

async function main(): Promise<void> {
  const logger = createLogger(process.env.EVA_ROUTER_LOG_LEVEL ?? "info", "evaself-llm-router");

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const encryptionKey = (process.env.LLM_CONFIG_ENCRYPTION_KEY ?? "").trim();
  const apiKey = (process.env.EVA_ROUTER_API_KEY ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL обязателен");
  if (encryptionKey.length < 32) {
    throw new Error("LLM_CONFIG_ENCRYPTION_KEY должен содержать не менее 32 символов");
  }
  if (apiKey.length < 16) {
    throw new Error("EVA_ROUTER_API_KEY обязателен и должен быть не короче 16 символов");
  }

  // Router пишет телеметрию llm_requests, помеченную владельцем хода.
  // Пул проходит ту же границу, а сам маршрут объявляет системную
  // область: чужих данных router не читает и читать не должен.
  const pool = guardPool(new Pool({
    connectionString: databaseUrl,
    max: 8,
    application_name: "evaself-llm-router",
  }));
  await pool.query("SELECT 1");

  const store = new RouterStore(pool, encryptionKey);
  const distributedLimits = enabled("EVA_DISTRIBUTED_LIMITS");
  const valkeyUrl = (process.env.VALKEY_URL ?? "").trim();
  if (distributedLimits && !valkeyUrl) {
    throw new Error("VALKEY_URL обязателен при EVA_DISTRIBUTED_LIMITS=true");
  }
  const redis = distributedLimits
    ? new Redis(valkeyUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
        enableOfflineQueue: true,
      })
    : null;
  redis?.on("error", (error) => logger.warn("LLM Router: ошибка Valkey", {
    code: error.name,
  }));
  const router = new LlmRouter(store, logger, {
    ...DEFAULT_OPTIONS,
    breakerThreshold: intFromEnv("EVA_ROUTER_BREAKER_THRESHOLD", DEFAULT_OPTIONS.breakerThreshold),
    breakerWindowMs: intFromEnv("EVA_ROUTER_BREAKER_WINDOW_MS", DEFAULT_OPTIONS.breakerWindowMs),
    breakerCooldownMs: intFromEnv("EVA_ROUTER_BREAKER_COOLDOWN_MS", DEFAULT_OPTIONS.breakerCooldownMs),
    maxRetryAfterMs: intFromEnv("EVA_ROUTER_MAX_RETRY_AFTER_MS", 5_000),
    retryAfterJitterMs: intFromEnv("EVA_ROUTER_RETRY_AFTER_JITTER_MS", 250),
    reservationTtlMs: intFromEnv("EVA_ROUTER_LIMIT_RESERVATION_TTL_MS", 300_000),
    limits: redis ? new ValkeyRouterLimits(redis) : undefined,
  });

  const app = createRouterServer({ router, store, logger, apiKey });
  const port = intFromEnv("EVA_ROUTER_PORT", 8073);
  await app.listen({ host: process.env.EVA_ROUTER_BIND ?? "0.0.0.0", port });
  logger.info("LLM Router запущен", { port });

  const shutdown = (signal: string) => {
    logger.info("LLM Router останавливается", { signal });
    void app.close()
      .then(() => store.close())
      .then(() => pool.end())
      .then(() => redis?.quit())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "evaself-llm-router",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
