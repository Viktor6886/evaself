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
import { AgentToolFactory, isHostExecutionTool, toolApprovalCategory, toolRisk } from "./agent-tools.js";
import { BackgroundRuntime } from "./background.js";
import {
  configWarnings,
  loadConfig,
  readPersona,
  readSystemPrompt,
  SYSTEM_PROMPT_FILE,
} from "./config.js";
import { CrisisMonitor } from "./crisis.js";
import { ConversationPurposeService } from "./conversations/purpose-service.js";
import { Database } from "./db.js";
import { ParallelInboxDispatcher } from "./delivery/dispatcher.js";
import { PostgresTelegramInbox, TelegramInboxWorker } from "./delivery/inbox.js";
import { PostgresTelegramOutbox } from "./delivery/outbox.js";
import { TelegramDeliveryLimiter } from "./delivery/telegram-limits.js";
import { badRequest, notFound } from "./errors.js";
import { EvaWorkflow } from "./eva-workflow.js";
import { GoalService } from "./goals/goal-service.js";
import { buildJobLayer } from "./jobs/index.js";
import { KnowledgeUploadService } from "./knowledge/lifecycle.js";
import { ResearchEnqueuer } from "./research/enqueue.js";
import { buildObservability } from "./observability/index.js";
import { LettaService } from "./letta.js";
import { LlmManager } from "./llm.js";
import { createLogger } from "./logger.js";
import { LavaPayments } from "./payments.js";
import { t } from "./i18n/index.js";
import { SubscriptionExpiryNotices } from "./payments/expiry-notices.js";
import { PLAN_TITLE, StarsPayments } from "./payments/stars.js";
import { UserProfileService } from "./profile/profile-service.js";
import { ValkeyRateLimiter } from "./public/rate-limit.js";
import { ValkeyMiniAppSessions } from "./public/webapp-session.js";
import { UserTurnLock } from "./turns/user-turn-lock.js";
import { PersonaSync } from "./letta/persona-sync.js";
import { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import { CanonicalContextStore } from "./runtime/canonical-context.js";
import { ArtifactRegistry } from "./artifacts/registry.js";
import { SdkSettingsManager } from "./sdk-settings.js";
import { ChannelLinkService } from "./channels/channel-links.js";
import { buildServer, VERSION } from "./server.js";
import { TelegramClient } from "./telegram.js";
import { TimezoneResolver } from "./time/timezone-resolver.js";
import { TurnAggregator } from "./turns/aggregator.js";
import { EffectJournal } from "./turns/effect-journal.js";
import { TurnRecoveryService } from "./turns/recovery.js";
import { TurnSemaphores } from "./turns/semaphores.js";
import { TurnLifecycle } from "./turns/turn-lifecycle.js";
import { currentTurn } from "./turns/turn-context.js";
import { ApprovalService } from "./tools/approvals.js";
import { loadMasterKey, SecretStore } from "./admin/secret-store.js";
import { McpHttpInvoker, McpServerPolicyRepository } from "./tools/mcp.js";

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

  // Значение по умолчанию — файлы репозитория. Правка из панели живёт
  // версией в реестре артефактов и подменяет их на чтении; пока правок
  // нет, поведение установки в точности прежнее.
  const canonicalDefaults = {
    persona: await readPersona(config),
    systemPrompt: await readSystemPrompt(),
    personaPath: config.personaFile,
    systemPromptPath: SYSTEM_PROMPT_FILE,
  };
  let persona = canonicalDefaults.persona;
  let systemPrompt = canonicalDefaults.systemPrompt;
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
  // Реестр артефактов ведёт версии обоих канонических текстов. Узкий
  // адаптер пула: `pg` типизирует строку как `QueryResultRow`, реестру
  // достаточно объекта с полями.
  const canonicalStore = new CanonicalContextStore(
    new ArtifactRegistry({
      query: async (sql: string, values: unknown[] = []) =>
        await db.query(sql, values) as unknown as {
          rows: Record<string, unknown>[];
          rowCount: number | null;
        },
    }),
    canonicalDefaults,
    process.env.EVA_ENV ?? "production",
  );
  try {
    const stored = await canonicalStore.current();
    persona = stored.persona;
    systemPrompt = stored.systemPrompt;
  } catch (error) {
    // Установка без миграции 067: таблиц реестра нет, тексты берутся из
    // файлов. Это рабочее состояние, а не отказ — обновление накатывает
    // миграцию отдельным шагом, и до него сервис обязан подниматься.
    logger.warn("Реестр канонических текстов недоступен, читаются файлы", {
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }
  const letta = new LettaService(config, logger, persona, systemPrompt);
  {
    // Сверка установленного пакета Letta с проверенной матрицей.
    // Расхождение попадает в журнал всегда — молча ехать на непроверенной
    // версии нельзя; останавливает старт только включённый флаг, потому
    // что это решение canary, а не умолчание.
    const contract = letta.verifyContract();
    if (!contract.ok) {
      const detail = { missing: contract.missing };
      if (config.lettaContractVerify) {
        throw new Error(
          `Контракт Letta не выполняется установленным пакетом: ${contract.missing.join(", ")}`,
        );
      }
      logger.warn("установленный пакет Letta не покрывает проверенную матрицу", detail);
    }
  }
  // Канонические prompt и persona — существующим агентам. Новый агент
  // получает их при создании; созданного раньше приводит к текущей версии
  // тот же проход, не меняя agent_id, память или conversations.
  //
  const personaSync = new PersonaSync(
    db,
    logger,
    letta,
  );
  // Массовая синхронизация идёт в фоне: старт сервиса её не ждёт. Тот
  // агент, чей человек написал раньше, чем она до него дошла, получит
  // prompt и persona в своём же ходе — коротким проходом перед обращением к
  // модели.
  void personaSync.sync(persona, systemPrompt).catch((error: unknown) => {
    logger.warn("Синхронизация prompt/persona не выполнена", {
      code: error instanceof Error ? error.name : "unknown_error",
    });
  });
  const telegram = new TelegramClient(config, logger, db);
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
  // Указатель на роутер ставится безусловно. Попутная проверка legacy
  // vision metadata best-effort и не мешает старту при недоступной БД/LLM.
  await llm.initializeDefaultModel();
  const runtimeContext = new RuntimeContextBuilder(db, {
    defaultTimezone: config.defaultTimezone,
    cacheTtlMs: Math.max(1, config.profileCacheTtlSeconds) * 1_000,
    profileCompletionEnabled: config.profileCompletionEnabled,
    vectorGoalsEnabled: config.vectorGoalsEnabled,
    routingMarkerSecret: config.routerApiKey,
  });
  const timezoneResolver = new TimezoneResolver(db);
  const profile = new UserProfileService(db, timezoneResolver, runtimeContext);
  const goals = new GoalService(db, runtimeContext);
  const turns = new TurnLifecycle(db, logger, config.turnLifecycleEnabled);
  const approvals = new ApprovalService(db, config.toolApprovalsEnabled, { outbox, lifecycle: turns, logger });
  // Журнал побочных эффектов включается тем же флагом, что и
  // восстановление: без журнала повтор хода не защищён, и включать одно
  // без другого — значит получить повторные действия.
  const effects = new EffectJournal(db, logger, config.turnRecoveryEnabled);
  // Мастер-ключ секретов монтируется только административным контейнерам:
  // у eva-agent-service его нет, и раньше эта ветка не поднималась вовсе —
  // MCP жил под флагом gateway. Ключа нет — нет и удалённых MCP-серверов,
  // но это не повод не поднять сервис: продуктовые инструменты, память и
  // диалог от него не зависят.
  const masterKey = await loadMasterKey().catch(() => null);
  if (!masterKey) logger.info("Мастер-ключ секретов не настроен: MCP-серверы недоступны");
  const mcpPolicies = masterKey ? new McpServerPolicyRepository(db) : undefined;
  const mcpInvoker = masterKey && mcpPolicies ? new McpHttpInvoker({
    policies: mcpPolicies,
    secrets: new SecretStore({ masterKey, pool: db as never }),
    audit: { record: async (entry) => { await db.query(`INSERT INTO audit_log (actor, operation, target, params_redacted_json, result, request_id, duration_ms) VALUES ('eva-agent-service',$1,$2,$3::jsonb,$4,$5,$6)`, [String(entry.operation), String(entry.server ?? "mcp"), JSON.stringify({ tool: entry.tool, stage: entry.stage }), entry.ok ? "success" : "failure", crypto.randomUUID(), Number(entry.duration_ms ?? 0)]); } },
  }) : undefined;
  const toolFactory = new AgentToolFactory(
    config,
    db,
    telegram,
    logger,
    profile,
    goals,
    effects,
    mcpPolicies && mcpInvoker ? { policies: mcpPolicies, invoker: mcpInvoker } : undefined,
    // Самопроверка смотрит на уже собранные факты сессии SDK. Состав
    // legacy blocks через HTTP не запрашивается: App Server WebSocket-only.
    {
      facts: () => ({ runtime: letta.runtimeFacts, session: letta.sessionFacts }),
      memory: async (_agentId: string) => null,
      agentOf: async (userId: number) => await db.agentIdOfUser(userId),
    },
    runtimeContext,
  );
  toolFactory.setApprovalCompletionCallback(async (execution) => await approvals.completeApprovedExecution(execution));
  letta.setToolFactory((conversationId) => toolFactory.forConversation(conversationId));
  // Что увидит модель, решает Letta. Отсюда приходит только подтверждение
  // действия человеком: у него есть владелец и чат, которых SDK не знает.
  letta.setSessionApprovalResolver(async (conversationId) => {
    const runtime = await toolFactory.sessionRuntime(conversationId);
    const approve = approvals.canUseTool({
      userId: runtime.userId,
      chatId: runtime.chatId,
      conversationId,
      turn: currentTurn(),
      riskFor: toolRisk,
      categoryFor: toolApprovalCategory,
    });
    return async (toolName, toolInput, context) => {
      // Оболочка и произвольная запись в файловую систему хоста —
      // граница детерминированная, а не предмет подтверждения: за
      // пределами продуктовых сценариев подтверждать такой вызов
      // человеку в чате нечем. Проверка стоит до подтверждений
      // намеренно: при выключенном флаге подтверждений граница обязана
      // остаться.
      if (isHostExecutionTool(toolName)) {
        logger.warn("вызов инструмента выполнения отклонён", { tool: toolName, conversationId });
        return { behavior: "deny", message: "Инструмент недоступен агенту Евы", interrupt: false };
      }
      return await approve(toolName, toolInput, context);
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
  // Оплата звёздами. Своего хранилища нет: те же payment_intents,
  // payments и subscriptions, что и у карточной оплаты.
  const stars = new StarsPayments({ db });
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
    turns,
    // Связь «сообщение канала → ход → conversation» ведётся всегда:
    // она не зависит от флага дневника, потому что отвечает за общий
    // аккаунт, а не за дневник.
    new ChannelLinkService(db),
    {
       syncAgent: (input, text, options, prompt) => personaSync.syncAgent(input, text, options, prompt),
      // Живое значение процесса, а не снимок старта: администратор
      // правит персону из панели, и ход обязан сверяться с тем, что
      // действует сейчас.
      persona: () => letta.canonicalContext().persona,
      systemPrompt: () => letta.canonicalContext().systemPrompt,
    },
    stars,
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
    // Владелец, разговаривающий с Евой в своём же чате, попадал в слепую
    // зону: подробность уходила только в «другой» чат, а этим другим он и
    // был. Он видел «попробуйте ещё раз» и не имел ни одного способа
    // узнать причину, не открывая журнал на сервере.
    const ownerReadsThisChat = config.ownerTelegramId !== null
      && config.ownerTelegramId === record.chatId;
    await telegram.withDeliveryContext(`telegram-dead:${record.updateId}`, async () => {
      if (record.chatId) {
        await telegram.sendMessage(
          record.chatId,
          "Не получилось обработать сообщение после нескольких попыток. Ошибка сохранена; попробуйте отправить сообщение ещё раз."
            + (ownerReadsThisChat ? `\n\nПричина: ${message.slice(0, 1200)}` : ""),
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

  const knowledgeUploads = jobs && config.knowledgeUploadsEnabled ? new KnowledgeUploadService(db,jobs.outbox,"/data/knowledge-uploads") : null;
  const research = jobs && config.researchOrchestratorEnabled ? new ResearchEnqueuer(db,jobs.outbox,jobs.runs) : null;
  // Telegram id is a verified identity key. Resolution is the only cross-user
  // lookup and therefore runs in an explicitly named system scope; every
  // subsequent user-table operation binds the resolved owner.
  const internalUser = async(telegramId:number)=>await db.withSystemScope("verified-identity.resolve",async()=>{const{rows}=await db.query<{id:string}>("SELECT id FROM users WHERE telegram_id=$1",[telegramId]);if(!rows[0])throw new Error("user_missing");return Number(rows[0].id);},{inherit:true});
  const knowledgeResearch = knowledgeUploads || research ? {
    upload:async(t:number,x:{name:string;mime:string;stream:import("node:stream").Readable;truncated:()=>boolean})=>{if(!knowledgeUploads)throw new Error("knowledge_disabled");return await knowledgeUploads.createFromStream(t,x);},
    uploadStatus:async(t:number,id:string)=>await knowledgeUploads?.status(t,id),
    // Диалог исследования открывает сервер, а не браузер.
    //
    // Раньше `conversation_id` и `agent_id` приходили из тела запроса, а
    // `ResearchEnqueuer` требовал уже существующий активный conversation
    // назначения `research`. Открывать его было некому: ни один путь
    // такой conversation не создавал, и любое исследование кончалось
    // `research_conversation_unauthorized` — пятисоткой, в которой
    // вызывающему нечего понять. Назначение здесь — техническое имя
    // продуктовой операции и её политики инструментов, а не разбор
    // смысла запроса.
    researchCreate:async(t:number,x:Record<string,unknown>)=>{
      if(!research)throw badRequest("Исследования отключены");
      const query=String(x.query??"").trim();
      if(!query||query.length>4_000)throw badRequest("Запрос исследования пуст или длиннее 4000 знаков");
      const link=await db.getAgentLink(t);
      if(!link)throw notFound("Агент ещё не создан: начните диалог с Евой");
      const userId=await internalUser(t);
      const conversation=await purposes.ensure({userId,agentId:link.agent_id,purpose:"research"});
      return {id:await research.enqueue({
        userId,
        conversationId:conversation.conversationId,
        agentId:link.agent_id,
        query,
        ...(typeof x.request_id==="string"?{requestId:x.request_id}:{}),
      })};
    },
    researchStatus:async(t:number,id:string)=>await research?.status(await internalUser(t),id),
    researchReport:async(t:number,id:string)=>await research?.report(await internalUser(t),id),
    researchCancel:async(t:number,id:string)=>({cancelled:await research?.cancel(await internalUser(t),id)??false}),
  } : undefined;

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
    stars,
    queue,
    telegram,
    slots,
    dispatcher,
    redisPing: async () => (await redis.ping()) === "PONG",
    observability,
    miniAppSessions,
    rateLimiter,
    approvals,
    runtimeContext,
    // Готовность спрашивает у runtime, доступны ли продуктовые
    // инструменты на самом деле. Имена берутся из той же фабрики,
    // которая их регистрирует, — второго списка не заводим.
    productToolNames: () => toolFactory.forConversation("readiness-probe").map((tool) => tool.name),
    // Правка персоны и системного промпта из панели. Доставку живым
    // агентам выполняет тот же PersonaSync, что и при старте: второго
    // пути синхронизации не появляется.
    canonicalContext: {
      store: canonicalStore,
      sync: async (nextPersona, nextSystemPrompt) =>
        await personaSync.sync(nextPersona, nextSystemPrompt),
    },
    ...(knowledgeResearch ? { knowledgeResearch } : {}),
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


  background.start(jobs ? jobs.legacySchedulerActive : true);

  // Предупреждения о конце подписки.
  //
  // Своего планировщика у них нет (инвариант 9): проверка идёт тем же
  // часовым тиком, что и остальная фоновая работа, а от повторов
  // защищает отметка в самой подписке, а не расписание.
  const expiryNotices = new SubscriptionExpiryNotices({
    db,
    logger,
    notify: async ({ chatId, plan, daysLeft }) => {
      const offers = await stars.offers().catch(() => []);
      const buttons: Array<Array<Record<string, unknown>>> = offers.map((offer) => [{
        text: `${offer.title} — ${offer.stars} ⭐`,
        callback_data: `buy:${offer.plan}:${offer.period}`,
      }]);
      if (config.domains?.app) {
        buttons.push([{
          text: t("ru", "openSubscriptionApp"),
          web_app: { url: `https://${config.domains.app}` },
        }]);
      }
      const key = daysLeft === 0
        ? "subscriptionEndsToday"
        : daysLeft === 1 ? "subscriptionEndsTomorrow" : "subscriptionEndsInDays";
      await telegram.withDeliveryContext(
        `subscription-expiry:${chatId}:${daysLeft}`,
        async () => await telegram.withPriority("command", async () => {
          await telegram.sendMessage(
            chatId,
            t("ru", key, { plan: PLAN_TITLE[plan] ?? plan, days: String(daysLeft) }),
            buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {},
          );
        }),
      );
    },
  });
  const expiryTimer = setInterval(() => {
    void expiryNotices.run().catch((error: unknown) => {
      logger.warn("Проверка окончания подписок не выполнена", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    });
  }, 60 * 60_000);
  expiryTimer.unref();
  void expiryNotices.run().catch(() => undefined);
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
  // Вебхук приводится к действующему списку видов апдейтов.
  //
  // Ставится он редко — при установке и при переезде на другого бота, —
  // а список растёт вместе с продуктом. Без этой сверки бот,
  // зарегистрированный раньше, молча не получает новые виды: так и не
  // работала оплата звёздами.
  void telegram.ensureWebhook(
    config.domains?.api ? `https://${config.domains.api}/telegram/webhook` : "",
    config.telegramWebhookSecret,
  ).then((outcome) => {
    if (outcome === "updated") logger.info("Webhook приведён к действующему списку апдейтов");
  }).catch(() => undefined);

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
