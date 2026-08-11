/**
 * Configuration, read once from the process environment.
 */

import { globalSecretRedactor } from "./admin/redactor.js";

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  apiKey: string;
  domains: {
    root: string;
    app: string;
    api: string;
    nocodb: string;
    letta: string;
    status: string;
  };
  incompleteSettings: string[];

  /** WebSocket URL of the self-hosted Letta App Server. */
  appServerUrl: string;
  /** Capability token presented during the WebSocket upgrade. */
  appServerToken: string;
  appServerRequestTimeoutMs: number;
  routerUrl: string;
  routerApiKey: string;

  model: string;
  personaFile: string;
  llmEncryptionKey: string;
  llmProviderConfigDir: string;
  llmControlFile: string;
  lettaCliPath: string;
  llmProbeTimeoutMs: number;

  databaseUrl: string;
  valkeyUrl: string;

  telegramBotToken: string;
  telegramWebhookSecret: string;
  telegramWebAppMaxAgeSeconds: number;
  webAppSessionTtlSeconds: number;
  rateLimitWindowSeconds: number;
  publicRateLimitPerIp: number;
  publicRateLimitPerUser: number;
  webhookRateLimitPerIp: number;
  healthRateLimitPerIp: number;
  telegramInboxPollMs: number;
  telegramInboxLeaseSeconds: number;
  telegramInboxMaxAttempts: number;
  telegramOutboxPollMs: number;
  telegramOutboxLeaseSeconds: number;
  telegramOutboxMaxAttempts: number;
  parallelOutboxEnabled: boolean;
  outboxConcurrency: number;
  outboxBatchSize: number;
  telegramGlobalRate: number;
  telegramGlobalBurst: number;
  telegramChatRate: number;
  telegramChatBurst: number;
  ownerTelegramId: number | null;
  telegramApiBaseUrl: string;
  mediaServiceUrl: string;
  /** Shared secret presented to media-service as X-Media-Key. */
  mediaServiceToken: string;
  searxngUrl: string;
  todoistApiUrl: string;
  todoistApiToken: string;
  todoistProjectId: string;
  schedulerIntervalMs: number;
  heartbeatIntervalMs: number;
  typingIntervalMs: number;
  defaultTimezone: string;
  profileCompletionEnabled: boolean;
  vectorGoalsEnabled: boolean;
  graphMemoryEnabled: boolean;
  graphContextTimeoutMs: number;
  profileCacheTtlSeconds: number;
  conversationMirrorEnabled: boolean;
  outboxEnabled: boolean;
  /**
   * Запись жизненного цикла хода в `turn_runs`. Shadow-режим: путь
   * обработки сообщения и ответ пользователю от него не зависят.
   */
  turnLifecycleEnabled: boolean;
  /**
   * Параллельный диспетчер durable inbox вместо последовательного
   * воркера. Выключенный флаг возвращает прежний воркер без изменения
   * данных: таблица и её семантика те же.
  */
  parallelInboxEnabled: boolean;
  /** Объединение быстрых последовательных сообщений в один ход. */
  turnAggregationEnabled: boolean;
  /** Сколько ходов процесс ведёт одновременно. */
  inboxConcurrency: number;
  /** Сколько записей диспетчер забирает за один заход в базу. */
  inboxBatchSize: number;
  /** Общий предел одновременных ходов на стенде, делится по классам. */
  turnSlotsTotal: number;
  turnAggregationDebounceMs: number;
  turnAggregationWindowMs: number;
  /**
   * Безопасный менеджер сессий: активная сессия не вытесняется и не
   * закрывается, смена настроек SDK идёт через graceful drain.
   */
  safeSessionManager: boolean;
  /** Сколько ждать освобождения сессий при смене настроек и остановке. */
  sessionDrainMs: number;
  /** Восстановление незавершённых ходов после сбоя. */
  turnRecoveryEnabled: boolean;
  /** Как часто искать ходы с истёкшей арендой. */
  turnRecoveryIntervalMs: number;
  /**
   * Сколько ждать завершения уже начатых ходов при остановке сервиса.
   * Значение обязано укладываться в grace period контейнера (умолчание
   * Docker — 10 с), иначе ожидание кончится уже после SIGKILL.
   */
  shutdownDrainMs: number;
  /**
   * Слой фоновых заданий на BullMQ. Выключенный флаг означает, что
   * очереди не открываются и публикатор не работает: намерения копятся
   * в `job_outbox` и будут опубликованы после включения.
   */
  bullmqJobsEnabled: boolean;
  /** Как часто публикатор переносит намерения из PostgreSQL в очередь. */
  jobOutboxPollMs: number;
  /** Сколько намерений публикатор забирает за один заход. */
  jobOutboxBatchSize: number;
  /** Сверки обслуживания на очередях. Сообщений пользователю не шлют. */
  bullmqMaintenanceEnabled: boolean;
  /** Проактивные сообщения на очередях: напоминания, heartbeat, check-in. */
  bullmqProactiveEnabled: boolean;
  /**
   * Режим зеркала. Включён — очередь только выбирает и сравнивает
   * выборку со старым интервалом, отправляет по-прежнему старый путь.
   * Выключать его можно лишь после доказанного совпадения выборок:
   * доказательство лежит в `job_mirror_samples`.
   */
  jobsMirrorMode: boolean;
  /** Универсальный фоновый ход агента (рефлексия, отчёты, исследования). */
  agentJobsEnabled: boolean;
  /** Локальный час утреннего и вечернего check-in. */
  checkinMorningHour: number;
  checkinEveningHour: number;

  lavaWebhookUser: string;
  lavaWebhookPassword: string;
  lavaPlans: Record<string, {
    plan: string;
    durationDays: number;
    amountMinor: number;
    currency: string;
    paymentUrl?: string;
  }>;

  lockTtlSeconds: number;
  turnTimeoutMs: number;
  /** How many idle sessions to keep open before evicting the oldest. */
  sessionPoolSize: number;
  sessionIdleMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const [name, value] of Object.entries(env)) {
    if (value && /(PASSWORD|SECRET|TOKEN|API_KEY|AUTHORIZATION|ENCRYPTION_KEY)/i.test(name)) {
      globalSecretRedactor.register(value);
    }
  }
  const str = (name: string, fallback = ""): string =>
    (env[name] ?? fallback).trim();
  const int = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(str(name), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  // Значение из .env, зажатое в допустимый диапазон. Для параметров
  // безопасности «поставили побольше» — это не настройка, а ошибка:
  // окно приёма initData в час возвращало бы ровно ту проблему, ради
  // которой его сокращали.
  const clampedInt = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => Math.min(max, Math.max(min, int(name, fallback)));
  const nullableInt = (name: string): number | null => {
    const value = str(name);
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const value = str(name).toLowerCase();
    if (!value) return fallback;
    return ["1", "true", "yes", "on"].includes(value);
  };
  const json = <T>(name: string, fallback: T): T => {
    const value = str(name);
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };

  return {
    port: int("EVA_AGENT_PORT", 8070),
    host: str("EVA_AGENT_HOST", "0.0.0.0"),
    logLevel: str("EVA_AGENT_LOG_LEVEL", "info"),
    apiKey: str("EVA_AGENT_API_KEY"),
    domains: {
      root: str("DOMAIN"),
      app: str("DOMAIN_APP"),
      api: str("DOMAIN_API"),
      nocodb: str("DOMAIN_NOCODB"),
      letta: str("DOMAIN_LETTA"),
      status: str("DOMAIN_STATUS"),
    },
    incompleteSettings: str("EVASELF_INCOMPLETE_SETTINGS")
      .replace(/^['"]|['"]$/g, "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),

    appServerUrl: str("LETTA_APP_SERVER_URL", "ws://letta-app-server:4500/ws"),
    appServerToken: str("LETTA_APP_SERVER_TOKEN"),
    appServerRequestTimeoutMs: int("LETTA_APP_SERVER_TIMEOUT_MS", 180_000),
    routerUrl: str("EVA_ROUTER_URL", "http://llm-router:8073"),
    routerApiKey: str("EVA_ROUTER_API_KEY", ""),

    model: str("EVA_LLM_MODEL"),
    personaFile: str("EVA_AGENT_PERSONA_FILE", "/app/library/persona/eva.md"),
    // Для обновляемых установок EVA_AGENT_API_KEY служит безопасным fallback;
    // новые установки всегда получают отдельный ключ из configure.sh.
    llmEncryptionKey: str("LLM_CONFIG_ENCRYPTION_KEY", str("EVA_AGENT_API_KEY")),
    llmProviderConfigDir: str("LETTA_PROVIDER_CONFIG_DIR", "/data/letta-config"),
    llmControlFile: str("LETTA_LLM_RESTART_FILE", "/data/llm-control/restart.request"),
    lettaCliPath: str("LETTA_CODE_CLI", "/app/node_modules/.bin/letta"),
    llmProbeTimeoutMs: int("EVA_LLM_PROBE_TIMEOUT_MS", 20_000),

    databaseUrl: str("DATABASE_URL"),
    valkeyUrl: str("VALKEY_URL"),

    telegramBotToken: str("EVA_TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: str("EVA_TELEGRAM_WEBHOOK_SECRET"),
    telegramWebAppMaxAgeSeconds: clampedInt(
      "EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS",
      600,
      300,
      600,
    ),
    webAppSessionTtlSeconds: clampedInt(
      "EVA_WEBAPP_SESSION_TTL_SECONDS",
      900,
      300,
      3_600,
    ),
    // Лимиты публичных поверхностей. 0 отключает проверку — это
    // осознанный аварийный рычаг, а не значение по умолчанию.
    rateLimitWindowSeconds: clampedInt("EVA_RATE_LIMIT_WINDOW_SECONDS", 60, 1, 3_600),
    publicRateLimitPerIp: int("EVA_PUBLIC_RATE_LIMIT_PER_IP", 120),
    publicRateLimitPerUser: int("EVA_PUBLIC_RATE_LIMIT_PER_USER", 60),
    // Telegram шлёт обновления пачками, поэтому лимит webhook заметно выше:
    // он защищает от постороннего потока, а не ограничивает сам Telegram.
    webhookRateLimitPerIp: int("EVA_WEBHOOK_RATE_LIMIT_PER_IP", 600),
    // /health опрашивают docker healthcheck и make doctor, поэтому лимит
    // выше публичного, но он есть: маршрут ходит в три бэкенда сразу.
    healthRateLimitPerIp: int("EVA_HEALTH_RATE_LIMIT_PER_IP", 300),
    telegramInboxPollMs: int("EVA_TELEGRAM_INBOX_POLL_MS", 500),
    telegramInboxLeaseSeconds: int("EVA_TELEGRAM_INBOX_LEASE_SECONDS", 300),
    telegramInboxMaxAttempts: int("EVA_TELEGRAM_INBOX_MAX_ATTEMPTS", 5),
    telegramOutboxPollMs: int("EVA_TELEGRAM_OUTBOX_POLL_MS", 500),
    telegramOutboxLeaseSeconds: int("EVA_TELEGRAM_OUTBOX_LEASE_SECONDS", 120),
    telegramOutboxMaxAttempts: int("EVA_TELEGRAM_OUTBOX_MAX_ATTEMPTS", 8),
    parallelOutboxEnabled: bool("EVA_PARALLEL_OUTBOX", false),
    outboxConcurrency: clampedInt("EVA_OUTBOX_CONCURRENCY", 8, 1, 64),
    outboxBatchSize: clampedInt("EVA_OUTBOX_BATCH_SIZE", 16, 1, 100),
    telegramGlobalRate: clampedInt("EVA_TELEGRAM_GLOBAL_RATE", 25, 1, 30),
    telegramGlobalBurst: clampedInt("EVA_TELEGRAM_GLOBAL_BURST", 25, 1, 30),
    telegramChatRate: clampedInt("EVA_TELEGRAM_CHAT_RATE", 1, 1, 20),
    telegramChatBurst: clampedInt("EVA_TELEGRAM_CHAT_BURST", 1, 1, 20),
    ownerTelegramId: nullableInt("OWNER_TELEGRAM_ID"),
    telegramApiBaseUrl: str("EVA_TELEGRAM_API_BASE_URL", "https://api.telegram.org"),
    mediaServiceUrl: str("EVA_MEDIA_SERVICE_URL", "http://media-service:8090"),
    mediaServiceToken: str("MEDIA_SERVICE_TOKEN"),
    searxngUrl: str("SEARXNG_BASE_URL", "http://searxng:8080/"),
    todoistApiUrl: str("TODOIST_API_URL", "https://api.todoist.com/api/v1"),
    todoistApiToken: str("TODOIST_API_TOKEN"),
    todoistProjectId: str("TODOIST_PROJECT_ID"),
    schedulerIntervalMs: int("EVA_SCHEDULER_INTERVAL_MS", 30_000),
    heartbeatIntervalMs: int("EVA_HEARTBEAT_INTERVAL_MS", 10 * 60_000),
    typingIntervalMs: int("EVA_TELEGRAM_TYPING_INTERVAL_MS", 4_000),
    defaultTimezone: str("TZ", "UTC"),
    profileCompletionEnabled: bool("EVA_PROFILE_COMPLETION_ENABLED", true),
    vectorGoalsEnabled: bool("EVA_VECTOR_GOALS_ENABLED", true),
    graphMemoryEnabled: bool("EVA_GRAPH_MEMORY_ENABLED", true),
    graphContextTimeoutMs: int("EVA_GRAPH_CONTEXT_TIMEOUT_MS", 75),
    profileCacheTtlSeconds: int("EVA_PROFILE_CACHE_TTL_SECONDS", 60),
    conversationMirrorEnabled: bool("EVA_CONVERSATION_MIRROR_ENABLED", false),
    outboxEnabled: bool("EVA_OUTBOX_ENABLED", true),
    turnLifecycleEnabled: bool("EVA_TURN_LIFECYCLE", false),
    parallelInboxEnabled: bool("EVA_PARALLEL_INBOX", false),
    turnAggregationEnabled: bool("EVA_TURN_AGGREGATION", false),
    // Первая ступень rollout — 8. Дальше 16, 32, 64, каждая только при
    // зелёных метриках базы, провайдера и сессий.
    inboxConcurrency: clampedInt("EVA_INBOX_CONCURRENCY", 8, 1, 256),
    inboxBatchSize: clampedInt("EVA_INBOX_BATCH_SIZE", 16, 1, 100),
    turnSlotsTotal: clampedInt("EVA_TURN_SLOTS_TOTAL", 128, 4, 1024),
    turnAggregationDebounceMs: clampedInt("EVA_TURN_AGGREGATION_DEBOUNCE_MS", 800, 800, 3_000),
    // Потолок окна ограничен диапазоном из задания: меньше — объединять
    // нечего, больше — человек ждёт ответа дольше, чем готов ждать.
    turnAggregationWindowMs: clampedInt("EVA_TURN_AGGREGATION_WINDOW_MS", 2_500, 2_500, 3_000),
    safeSessionManager: bool("EVA_SAFE_SESSION_MANAGER", false),
    sessionDrainMs: clampedInt("EVA_SESSION_DRAIN_MS", 8_000, 500, 120_000),
    turnRecoveryEnabled: bool("EVA_TURN_RECOVERY", false),
    turnRecoveryIntervalMs: clampedInt("EVA_TURN_RECOVERY_INTERVAL_MS", 30_000, 5_000, 600_000),
    shutdownDrainMs: clampedInt("EVA_SHUTDOWN_DRAIN_MS", 8_000, 1_000, 120_000),
    bullmqJobsEnabled: bool("EVA_BULLMQ_JOBS", false),
    jobOutboxPollMs: clampedInt("EVA_JOBS_OUTBOX_POLL_MS", 1_000, 200, 60_000),
    jobOutboxBatchSize: clampedInt("EVA_JOBS_OUTBOX_BATCH", 32, 1, 200),
    bullmqMaintenanceEnabled: bool("EVA_BULLMQ_MAINTENANCE", false),
    bullmqProactiveEnabled: bool("EVA_BULLMQ_PROACTIVE", false),
    // Умолчание — зеркало: включённая проактивность без доказанного
    // совпадения выборок обязана сначала понаблюдать, а не начать
    // писать людям параллельно со старым интервалом.
    jobsMirrorMode: bool("EVA_JOBS_MIRROR", true),
    agentJobsEnabled: bool("EVA_AGENT_JOBS", false),
    checkinMorningHour: clampedInt("EVA_CHECKIN_MORNING_HOUR", 9, 5, 12),
    checkinEveningHour: clampedInt("EVA_CHECKIN_EVENING_HOUR", 21, 17, 23),

    lavaWebhookUser: str("LAVA_WEBHOOK_USER"),
    lavaWebhookPassword: str("LAVA_WEBHOOK_PASSWORD"),
    lavaPlans: json("LAVA_PLANS_JSON", {}),

    lockTtlSeconds: int("EVA_AGENT_LOCK_TTL", 180),
    turnTimeoutMs: int("EVA_AGENT_TURN_TIMEOUT_MS", 240_000),
    sessionPoolSize: int("EVA_AGENT_SESSION_POOL", 25),
    sessionIdleMs: int("EVA_AGENT_SESSION_IDLE_MS", 600_000),
  };
}

/**
 * Configuration combinations that are individually valid but broken together.
 * Reported at boot as warnings rather than a hard failure: an operator should
 * be told, not locked out of a running installation.
 */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  // The lease is renewed while a turn runs, so a shorter TTL is survivable —
  // but it means every long turn depends on the renewal timer never missing.
  if (config.lockTtlSeconds * 1000 <= config.turnTimeoutMs) {
    warnings.push(
      `EVA_AGENT_LOCK_TTL (${config.lockTtlSeconds} с) не больше ` +
        `EVA_AGENT_TURN_TIMEOUT_MS (${config.turnTimeoutMs} мс): лок держится только ` +
        "за счёт фонового продления. Рекомендуется TTL > таймаута хода.",
    );
  }
  // Флаг, который ничего не включает, — худшая ступень rollout: он
  // выглядит включённым и не делает ничего. Объединение живёт внутри
  // параллельного диспетчера и без него не работает.
  if (config.turnAggregationEnabled && !config.parallelInboxEnabled) {
    warnings.push(
      "EVA_TURN_AGGREGATION включён, а EVA_PARALLEL_INBOX выключен: "
        + "объединение быстрых сообщений работает только в параллельном "
        + "диспетчере и сейчас не действует",
    );
  }
  if (config.parallelOutboxEnabled && !config.outboxEnabled) {
    warnings.push(
      "EVA_PARALLEL_OUTBOX включён, а EVA_OUTBOX_ENABLED выключен: "
        + "параллельная доставка работает только через durable outbox",
    );
  }
  // Восстановление меняет состояние только через жизненный цикл, а он
  // при выключенном флаге не пишет ничего: решения принимались бы,
  // не применялись и оставляли по строке в журнале попыток каждый заход.
  // Проактивные задания без самого слоя заданий — флаг, который ничего
  // не включает: очередей нет, публикатор не работает, сверка зеркала
  // не выполняется ни разу.
  if ((config.bullmqProactiveEnabled || config.bullmqMaintenanceEnabled)
      && !config.bullmqJobsEnabled) {
    warnings.push(
      "EVA_BULLMQ_PROACTIVE или EVA_BULLMQ_MAINTENANCE включён, а EVA_BULLMQ_JOBS "
        + "выключен: очереди не открываются и задания не выполняются",
    );
  }
  // Снятое зеркало — это переключение владения задачей. Оно допустимо
  // только осознанно и после сверки, поэтому о нём предупреждаем всегда.
  if (config.bullmqProactiveEnabled && !config.jobsMirrorMode) {
    warnings.push(
      "EVA_JOBS_MIRROR выключен: напоминания и heartbeat ведёт очередь, "
        + "старые интервалы не запускаются. Убедитесь, что сверка в "
        + "job_mirror_samples показала совпадение выборок",
    );
  }
  if (config.checkinEveningHour <= config.checkinMorningHour) {
    warnings.push(
      `EVA_CHECKIN_EVENING_HOUR (${config.checkinEveningHour}) не позже `
        + `EVA_CHECKIN_MORNING_HOUR (${config.checkinMorningHour}): вечерний `
        + "check-in не сможет опереться на утреннее намерение",
    );
  }
  if (config.turnRecoveryEnabled && !config.turnLifecycleEnabled) {
    warnings.push(
      "EVA_TURN_RECOVERY включён, а EVA_TURN_LIFECYCLE выключен: "
        + "восстановление меняет состояние только через жизненный цикл "
        + "и без него не запускается",
    );
  }
  if (config.telegramBotToken && !config.telegramWebhookSecret) {
    warnings.push("EVA_TELEGRAM_WEBHOOK_SECRET пуст — webhook Telegram будет отклонять все запросы");
  }
  if (!config.mediaServiceToken) {
    warnings.push("MEDIA_SERVICE_TOKEN пуст — media-service принимает запросы без аутентификации");
  }
  return warnings;
}

const FALLBACK_PERSONA =
  "You are Eva, an AI companion and self-discovery assistant. You are warm, " +
  "attentive and honest. You help the person understand themselves better, " +
  "you never diagnose, and you never pretend to be a licensed therapist.";

/** Eva's persona, loaded from library/ so it can be edited without a rebuild. */
export async function readPersona(config: Config): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    const text = await readFile(config.personaFile, "utf8");
    return text.trim() || FALLBACK_PERSONA;
  } catch {
    return FALLBACK_PERSONA;
  }
}
