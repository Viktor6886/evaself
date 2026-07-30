import { Redis } from "ioredis";
import pg from "pg";

import { createLogger } from "../logger.js";
import { AuthService } from "./auth-service.js";
import { AuditService } from "./audit-service.js";
import { ConfigService } from "./config-service.js";
import { HealthService } from "./health-service.js";
import { loadMasterKey, SecretStore } from "./secret-store.js";
import { OperationService } from "./operation-service.js";
import { LlmRouterAdminService } from "./llm-router-service.js";
import { InternalAgentClient, ProviderService } from "./provider-service.js";
import { OutboundGateway } from "./outbound-gateway.js";
import { buildAdminServer } from "./server.js";
import { UpdaterClient } from "./updater-client.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const logger = createLogger(process.env.EVA_ADMIN_LOG_LEVEL ?? "info", "evaself-admin-api");
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const valkeyUrl = (process.env.VALKEY_URL ?? "").trim();
  if (!databaseUrl || !valkeyUrl) throw new Error("DATABASE_URL и VALKEY_URL обязательны");

  const masterKey = await loadMasterKey();
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    application_name: "evaself-admin-api",
  });
  const redis = new Redis(valkeyUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  redis.on("error", () => logger.warn("Valkey временно недоступен"));
  await pool.query("SELECT 1");
  await redis.ping();

  const secrets = new SecretStore({ masterKey, pool });
  await secrets.primeRedactor();
  const auth = new AuthService(pool, redis);
  const audit = new AuditService(pool);
  const config = new ConfigService(pool, redis);
  const health = new HealthService(pool, redis);
  const operations = new OperationService(pool, redis, new UpdaterClient());
  const llmRouter = new LlmRouterAdminService(pool);
  const providers = new ProviderService(
    new InternalAgentClient(secrets),
    new OutboundGateway(),
  );
  const app = buildAdminServer({
    auth,
    audit,
    config,
    secrets,
    health,
    operations,
    providers,
    llmRouter,
    events: redis,
    logger,
    readiness: async () => {
      try {
        await pool.query("SELECT 1");
        return (await redis.ping()) === "PONG";
      } catch {
        return false;
      }
    },
  });
  const port = Number.parseInt(process.env.EVA_ADMIN_PORT ?? "8071", 10);
  const host = process.env.EVA_ADMIN_BIND ?? "0.0.0.0";
  await app.listen({ port, host });
  logger.info("admin-api принимает запросы", { port, phase: 2 });

  const shutdown = async (signal: string) => {
    logger.info("Остановка admin-api", { signal });
    await app.close();
    await pool.end();
    redis.disconnect();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  const logger = createLogger("error", "evaself-admin-api");
  logger.error("Не удалось запустить admin-api", {
    code: error instanceof Error ? error.name : "unknown_error",
  });
  process.exit(1);
});
