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
import { PermanentJobFailure } from "./jobs/policy.js";
import { buildObservability } from "./observability/index.js";
import { LettaService } from "./letta.js";
import { LlmManager } from "./llm.js";
import { createLogger } from "./logger.js";
import { GraphContextService } from "./memory/graph-context.js";
import { ConversationHighlightService } from "./memory/conversation-highlights.js";
import { GraphRepository } from "./memory/graph-repository.js";
import { EpisodeService, EpisodeTracker, type EpisodeRow } from "./memory/episodes.js";
import { CURATOR_JOB_TYPE, MemoryCuratorService } from "./memory/curator/service.js";
import { MemoryUserControl, MiniAppMemoryGateway } from "./memory/curator/user-control.js";
import { MEMORY_DOCTOR_JOB_TYPE, MemoryDoctorService } from "./memory/doctor/service.js";
import { MiniAppDoctorGateway, type DoctorEnqueue } from "./memory/doctor/gateway.js";
import { buildTemporalMemory } from "./memory/temporal/index.js";
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
import { currentTurn } from "./turns/turn-context.js";
import { ApprovalService, type MandatoryApprovalCategory } from "./tools/approvals.js";
import { loadMasterKey, SecretStore } from "./admin/secret-store.js";
import { McpHttpInvoker, McpServerPolicyRepository } from "./tools/gateway.js";

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
  {
    // Сверка установленного пакета Letta с проверенной матрицей.
    // Расхождение попадает в журнал всегда — молча ехать на непроверенной
    // версии нельзя; останавливает старт только включённый флаг, потому
    // что это решение canary, а не умолчание.
    const contract = letta.verifyContract();
    if (!contract.ok) {
      const detail = { missing: contract.missing };
      if (config.lettaSdk060Verify) {
        throw new Error(
          `Контракт Letta не выполняется установленным пакетом: ${contract.missing.join(", ")}`,
        );
      }
      logger.warn("установленный пакет Letta не покрывает проверенную матрицу", detail);
    }
  }
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
  // Temporal-память. Флаг выключен — сборка создаётся, но `enabled`
  // ложен, и ни один писатель в неё не заходит: так контроль памяти в
  // Mini App честно отвечает «выключено» вместо пустого списка.
  const temporalMemory = buildTemporalMemory(config.temporalMemoryEnabled);
  const episodes = new EpisodeService(db, config.memoryCuratorEnabled);
  const memoryControl = config.temporalMemoryEnabled
    ? new MiniAppMemoryGateway(db, new MemoryUserControl(db, temporalMemory))
    : undefined;
  // Постановка задания Curator появляется позже — вместе со слоем
  // заданий, который создаётся после воркфлоу. До тех пор закрытый
  // эпизод просто записывается: задание без очереди поставить некуда, и
  // притворяться, что оно поставлено, нельзя.
  let enqueueCuration: ((episode: EpisodeRow, userId: number) => Promise<void>) | null = null;
  // Диагностика памяти собирается здесь, а ставится заданием — поэтому
  // публикация задания появляется вместе со слоем заданий ниже. Пока
  // его нет, Mini App честно отвечает отказом, а не молча теряет запрос.
  const doctor = config.memoryDoctorEnabled && config.temporalMemoryEnabled
    ? new MemoryDoctorService(db, temporalMemory, logger, true)
    : null;
  let enqueueDoctorRun: DoctorEnqueue | null = null;
  const memoryDoctorGateway = doctor
    ? new MiniAppDoctorGateway(db, doctor, async (userId, intent) => {
      if (!enqueueDoctorRun) throw new Error("Слой заданий не запущен");
      await enqueueDoctorRun(userId, intent);
    })
    : undefined;
  const episodeTracker = new EpisodeTracker(
    episodes,
    async (episode, userId) => { await enqueueCuration?.(episode, userId); },
    logger,
  );
  const timezoneResolver = new TimezoneResolver(db);
  const profile = new UserProfileService(
    db,
    timezoneResolver,
    runtimeContext,
    graph,
  );
  const goals = new GoalService(db, runtimeContext, graph);
  const turns = new TurnLifecycle(db, logger, config.turnLifecycleEnabled);
  const approvals = new ApprovalService(db, config.toolApprovalsEnabled, { outbox, lifecycle: turns });
  // Журнал побочных эффектов включается тем же флагом, что и
  // восстановление: без журнала повтор хода не защищён, и включать одно
  // без другого — значит получить повторные действия.
  const effects = new EffectJournal(
    db,
    logger,
    config.turnRecoveryEnabled || config.toolGatewayEnabled,
    config.toolGatewayEnabled,
  );
  const mcpPolicies = config.toolGatewayEnabled ? new McpServerPolicyRepository(db) : undefined;
  const mcpInvoker = mcpPolicies ? new McpHttpInvoker({
    policies: mcpPolicies,
    secrets: new SecretStore({ masterKey: await loadMasterKey(), pool: db as never }),
    audit: { record: async (entry) => { await db.query(`INSERT INTO audit_log (actor, operation, target, params_redacted_json, result, request_id, duration_ms) VALUES ('eva-agent-service',$1,$2,$3::jsonb,$4,$5,$6)`, [String(entry.operation), String(entry.server ?? "mcp"), JSON.stringify({ tool: entry.tool, stage: entry.stage }), entry.ok ? "success" : "failure", crypto.randomUUID(), Number(entry.duration_ms ?? 0)]); } },
  }) : undefined;
  const toolFactory = new AgentToolFactory(
    config,
    db,
    telegram,
    logger,
    profile,
    goals,
    graph,
    effects,
    mcpPolicies && mcpInvoker ? { policies: mcpPolicies, invoker: mcpInvoker } : undefined,
  );
  toolFactory.setApprovalCompletionCallback(async (execution) => await approvals.completeApprovedExecution(execution));
  letta.setToolFactory((conversationId) => toolFactory.forConversation(conversationId));
  letta.setSessionToolPolicyResolver(async (conversationId) => {
    const policy = await toolFactory.sessionPolicy(conversationId);
    return {
      visibleTools: policy.visibleTools,
      canUseTool: async (name, args, context) => {
        const manifest = toolFactory.manifests.get(name);
        if (!manifest || !policy.visibleTools.includes(name)) {
          return { behavior: "deny", message: "Tool is outside the live conversation policy", interrupt: false };
        }
        return await approvals.canUseTool({
          userId: policy.runtime.userId,
          chatId: policy.runtime.chatId,
          conversationId,
          turn: currentTurn(),
          riskFor: () => manifest.risk,
          categoryFor: () => (manifest as typeof manifest & {
            mandatoryApprovalCategory?: MandatoryApprovalCategory;
          }).mandatoryApprovalCategory,
        })(name, args, context);
      },
    };
  });
  void approvals.recoverPendingApprovals(async (conversationId) => {
    await letta.recoverConversationApprovals(conversationId);
  }).catch((error) => logger.error("pending approval recovery failed", {
    message: error instanceof Error ? error.message : String(error),
  }));
  const crisis = new CrisisMonitor(db, telegram, logger, config.ownerTelegramId);
  // Наблюдатель хода создаётся до approval callback, чтобы пауза и resume
  // использовали тот же канонический lifecycle.
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
    episodeTracker,
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
    approvals,
    ...(memoryControl ? { memory: memoryControl } : {}),
    ...(memoryDoctorGateway ? { memoryDoctor: memoryDoctorGateway } : {}),
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

  // Memory Curator существует только как задание очереди. Без слоя
  // заданий его не собирают вовсе: иначе появился бы второй путь
  // запуска, и требование «не в пути ответа человеку» держалось бы на
  // дисциплине вызывающего, а не на устройстве.
  if (jobs && config.memoryCuratorEnabled && config.temporalMemoryEnabled) {
    const curator = new MemoryCuratorService(
      db, episodes, temporalMemory, jobs.agentJobs, logger, true,
    );
    // Намерение пишется в job_outbox, а не публикуется прямо в очередь:
    // недоступный Valkey не должен терять эпизод, и публикатор поднимет
    // намерение сам.
    enqueueCuration = async (episode, userId) => {
      await db.withUserScope(
        { userId, label: "memory.curator.enqueue", inherit: true },
        async () => await db.transaction(async (client) => {
          await jobs.outbox.record(client, curator.intent({
            userId,
            episodeId: episode.id,
            conversationId: episode.conversationId,
            traceId: crypto.randomUUID(),
          }));
        }),
      );
    };
    jobs.runtime.register(CURATOR_JOB_TYPE, async (context) => {
      const userId = context.envelope.userId;
      const episodeId = Number(context.envelope.payload.episode_id);
      if (!userId || !Number.isFinite(episodeId)) {
        throw new PermanentJobFailure("memory_curator_payload_invalid");
      }
      const outcome = await curator.run({
        runId: context.runId,
        userId,
        agentId: context.envelope.agentId ?? "",
        episodeId,
        parentConversationId: context.envelope.conversationId ?? "",
        signal: context.signal,
      });
      // В журнал уходят только счётчики: содержимое кандидатов — это
      // пересказ разговора, и в логах ему места нет.
      logger.info("Curator обработал эпизод", {
        status: outcome.status,
        candidates: outcome.candidates.length,
        created: outcome.applied.created,
        versioned: outcome.applied.versioned,
      });
    });
  }

  // Memory Doctor — тоже только задание очереди. Причина та же, что у
  // Curator: единственная точка запуска не даёт диагностике попасть в
  // путь ответа человеку ни через Mini App, ни через админку.
  if (jobs && doctor) {
    enqueueDoctorRun = async (userId, intent) => {
      await db.withUserScope(
        { userId, label: "memory.doctor.enqueue", inherit: true },
        async () => await db.transaction(async (client) => {
          await jobs.outbox.record(client, intent);
        }),
      );
    };
    jobs.runtime.register(MEMORY_DOCTOR_JOB_TYPE, async (context) => {
      const userId = context.envelope.userId;
      const reportKey = String(context.envelope.payload.report_key ?? "");
      const trigger = String(context.envelope.payload.trigger ?? "scheduled");
      if (!userId || !reportKey) {
        throw new PermanentJobFailure("memory_doctor_payload_invalid");
      }
      const report = await doctor.run({
        userId,
        reportKey,
        trigger: trigger as Parameters<MemoryDoctorService["run"]>[0]["trigger"],
        signal: context.signal,
      });
      // В журнал уходят только счётчики: находки ссылаются на личные
      // записи, и в логах им места нет.
      logger.info("Memory Doctor завершил прогон", {
        status: report.status,
        findings: report.findings.length,
        sections: report.sections.length,
      });
    });
  }

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
