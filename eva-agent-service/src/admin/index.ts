import { Redis } from "ioredis";
import pg from "pg";

import { createLogger } from "../logger.js";
import { guardPool, runInScope, systemScope } from "../tenancy/index.js";
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
import { ArtifactRegistry } from "../artifacts/registry.js";
import { AgentDirectoryService } from "./agent-directory.js";
import { AdminAgentService } from "./agent-admin-service.js";
import { SubscriptionAdminService } from "./subscription-service.js";
import { PersonaAdminService } from "./persona-admin-service.js";
import { LettaConsoleService } from "./letta-console-service.js";
import { ToolApprovalService } from "./tool-approvals.js";
import { McpServerPolicyRepository } from "../tools/mcp.js";
import { TurnOperationsService } from "./turn-operations.js";
import { DeleteGuard } from "../letta/delete-guard.js";
import { SecurityAuditService } from "./security-audit.js";
import { RetentionService } from "../retention/service.js";
import { UpdaterClient } from "./updater-client.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const logger = createLogger(process.env.EVA_ADMIN_LOG_LEVEL ?? "info", "evaself-admin-api");
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const valkeyUrl = (process.env.VALKEY_URL ?? "").trim();
  if (!databaseUrl || !valkeyUrl) throw new Error("DATABASE_URL и VALKEY_URL обязательны");

  const masterKey = await loadMasterKey();
  // Пул админки проходит ту же границу арендатора, что и пул сервиса:
  // обращение к данным пользователей возможно только внутри запроса с
  // проверенной ролью и записью аудита.
  const pool = guardPool(new Pool({
    connectionString: databaseUrl,
    max: 10,
    application_name: "evaself-admin-api",
  }));
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
  const stt = new SttAdminService(pool, secrets, new HttpMediaSttClient(secrets), logger);
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

  /**
   * Повторная рассылка снимка, пока он не доедет.
   *
   * media-service может подняться позже admin-api, перезапуститься или
   * временно отвечать 401 из-за расхождения токенов. Без повтора
   * несостоявшаяся доставка чинилась бы только следующей правкой в
   * панели — то есть распознавание оставалось бы сломанным, пока
   * администратор случайно что-нибудь не сохранит.
   *
   * Пока снимок доставлен, попытки не делаются вовсе: unref() снимает
   * таймер со счётчика событий, чтобы он не держал процесс живым.
   */
  const snapshotRetry = setInterval(() => {
    if (stt.pushStatus().delivered) return;
    void stt.pushSnapshot().then((result) => {
      if (result.applied) logger.info("Снимок STT доставлен после повторной попытки");
    });
  }, 60_000);
  snapshotRetry.unref();

  // Один узкий адаптер пула на все реестровые сервисы: `pg` типизирует
  // строку как `QueryResultRow`, а сервисам достаточно объекта с полями.
  const registryDb = {
    query: async (sql: string, values: unknown[] = []) =>
      await pool.query(sql, values) as unknown as {
        rows: Record<string, unknown>[];
        rowCount: number | null;
      },
  };
  const artifacts = new ArtifactRegistry(registryDb);

  // Каталог агентов нужен и разделу «Агенты» единой панели, и старому
  // CRUD за флагом. Экземпляр один: два означали бы два разных стража
  // удаления на одних и тех же данных.
  const directory = new AgentDirectoryService(registryDb, new DeleteGuard({
    query: registryDb.query,
    withSystemScope: async (_reason, work) => await work(),
  }));

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
    securityAudit: new SecurityAuditService({ env: process.env, db: pool }),
    // Единый реестр артефактов. Артефакты общесистемные: владельца среди
    // пользователей Евы у них нет, поэтому граница арендатора к ним не
    // применяется, а доступ ограничен ролью маршрута и записан в аудит.
    artifacts: artifacts,
    // Полный административный CRUD (шаг 12). Собирается всегда, но
    // регистрируется только при включённом EVA_ADMIN_CRUD: собранный, но
    // незарегистрированный сервис ничего не стоит и ни к чему не
    // обращается.
    // Разделы единой панели. Все изменяющие действия уходят в
    // eva-agent-service тем же путём, каким работает production: агентов
    // создаёт и удаляет только он, персону раскатывает только он.
    panel: {
      agents: new AdminAgentService(pool, directory, agentClient),
      subscriptions: new SubscriptionAdminService(pool),
      persona: new PersonaAdminService(agentClient),
      letta: new LettaConsoleService(agentClient),
    },
    crud: {
      directory,
      tools: new ToolApprovalService(registryDb),
      mcp: new McpServerPolicyRepository(registryDb as never),
      turns: new TurnOperationsService(registryDb),
    },
    // Предпросмотр всегда доступен и всегда безопасен: сам сервис
    // создаётся выключенным (`enabled = false`), удалять из админки
    // нечем — удаление выполняет задание очереди обслуживания.
    retention: new RetentionService(
      {
        // Приведение к узкому контракту: `pg` типизирует строку как
        // `QueryResultRow`, сервису достаточно объекта с полями.
        query: async <T>(sql: string, values: unknown[] = []) =>
          await pool.query(sql, values) as unknown as { rows: T[]; rowCount: number | null },
        // Область объявляется настоящая: запросы предпросмотра идут по
        // всем пользователям сразу, и граница арендатора обязана это
        // видеть, а не обходиться заглушкой.
        withSystemScope: async (reason, work, options) =>
          await runInScope(systemScope(reason, options ?? {}), work),
      },
      logger,
      false,
    ),
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
