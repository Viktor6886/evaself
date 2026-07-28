/**
 * Configuration, read once from the process environment.
 */

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  apiKey: string;

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

  return {
    port: int("EVA_AGENT_PORT", 8070),
    host: str("EVA_AGENT_HOST", "0.0.0.0"),
    logLevel: str("EVA_AGENT_LOG_LEVEL", "info"),
    apiKey: str("EVA_AGENT_API_KEY"),

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
