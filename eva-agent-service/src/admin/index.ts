import { Redis } from "ioredis";
import pg from "pg";

import { createLogger } from "../logger.js";
import { AuthService } from "./auth-service.js";
import { AuditService } from "./audit-service.js";
import { ConfigService } from "./config-service.js";
import { HealthService } from "./health-service.js";
import { loadMasterKey, SecretStore } from "./secret-store.js";
import { OperationService } from "./operation-service.js";
import { IntegrationConfigService } from "./integration-config-service.js";
import { LlmRouterAdminService } from "./llm-router-service.js";
import { InternalAgentClient, ProviderService } from "./provider-service.js";
import { HttpMediaSttClient, SttAdminService } from "./stt-service.js";
import { OutboundGateway } from "./outbound-gateway.js";
import { buildAdminServer } from "./server.js";
import { UserService } from "./user-service.js";
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
  const integrations = new IntegrationConfigService(pool, secrets);
  // Схемы провайдеров и валидацию параметров admin-api спрашивает у
  // media-service: правда живёт там, где адаптеры.
  const stt = new SttAdminService(pool, secrets, new HttpMediaSttClient(secrets));
  const agentClient = new InternalAgentClient(secrets);
  const providers = new ProviderService(agentClient, new OutboundGateway());
  // Переписку admin-api читает через eva-agent-service: он единственный,
  // кому разрешено обращаться к Letta App Server.
  const users = new UserService(pool, agentClient);
  // Перенос действующих MEDIA_ASR_* в реестр. Идемпотентно: если
  // конфигурации уже есть, ничего не делает. Обновление работающей
  // установки не должно ломать голосовые сообщения.
  try {
    const migration = await stt.importLegacyEnv();
    if (migration.imported) {
      logger.info("Настройки распознавания перенесены в реестр", { reason: migration.reason });
    }
    // Снимок рассылается на старте всегда: media-service мог быть
    // пересоздан и потерять том со своей копией.
    await stt.pushSnapshot();
  } catch (error) {
    // Реестр STT не должен мешать старту всей админки: без снимка
    // media-service распознаёт по устаревшим переменным.
    logger.warn("Не удалось разослать снимок STT", {
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }

  const app = buildAdminServer({
    auth,
    audit,
    config,
    secrets,
    health,
    operations,
    providers,
    llmRouter,
    stt,
    integrations,
    users,
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
