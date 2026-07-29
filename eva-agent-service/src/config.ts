/**
 * Configuration, read once from the process environment.
 */

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
  telegramInboxPollMs: number;
  telegramInboxLeaseSeconds: number;
  telegramInboxMaxAttempts: number;
  telegramOutboxPollMs: number;
  telegramOutboxLeaseSeconds: number;
  telegramOutboxMaxAttempts: number;
  ownerTelegramId: number | null;
  telegramApiBaseUrl: string;
  mediaServiceUrl: string;
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
  const str = (name: string, fallback = ""): string =>
    (env[name] ?? fallback).trim();
  const int = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(str(name), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
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
    telegramWebAppMaxAgeSeconds: int("EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS", 3_600),
    telegramInboxPollMs: int("EVA_TELEGRAM_INBOX_POLL_MS", 500),
    telegramInboxLeaseSeconds: int("EVA_TELEGRAM_INBOX_LEASE_SECONDS", 300),
    telegramInboxMaxAttempts: int("EVA_TELEGRAM_INBOX_MAX_ATTEMPTS", 5),
    telegramOutboxPollMs: int("EVA_TELEGRAM_OUTBOX_POLL_MS", 500),
    telegramOutboxLeaseSeconds: int("EVA_TELEGRAM_OUTBOX_LEASE_SECONDS", 120),
    telegramOutboxMaxAttempts: int("EVA_TELEGRAM_OUTBOX_MAX_ATTEMPTS", 8),
    ownerTelegramId: nullableInt("OWNER_TELEGRAM_ID"),
    telegramApiBaseUrl: str("EVA_TELEGRAM_API_BASE_URL", "https://api.telegram.org"),
    mediaServiceUrl: str("EVA_MEDIA_SERVICE_URL", "http://media-service:8090"),
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

    lavaWebhookUser: str("LAVA_WEBHOOK_USER"),
    lavaWebhookPassword: str("LAVA_WEBHOOK_PASSWORD"),
    lavaPlans: json("LAVA_PLANS_JSON", {}),

    lockTtlSeconds: int("EVA_AGENT_LOCK_TTL", 180),
    turnTimeoutMs: int("EVA_AGENT_TURN_TIMEOUT_MS", 240_000),
    sessionPoolSize: int("EVA_AGENT_SESSION_POOL", 25),
    sessionIdleMs: int("EVA_AGENT_SESSION_IDLE_MS", 600_000),
  };
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
