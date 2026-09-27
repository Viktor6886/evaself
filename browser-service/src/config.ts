/**
 * Настройки browser-service.
 *
 * Все пределы — числа с потолком: опечатка в окружении не должна
 * превратить изолированный браузер в браузер без ограничений.
 */

export interface BrowserServiceConfig {
  port: number;
  host: string;
  token: string;
  production: boolean;
  maxSessions: number;
  maxSessionsPerOwner: number;
  sessionIdleMs: number;
  sessionMaxAgeMs: number;
  operationTimeoutMs: number;
  navigationTimeoutMs: number;
  snapshotMaxChars: number;
  maxTypeChars: number;
  executablePath: string | undefined;
}

function clamped(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrowserServiceConfig {
  const production = (env.EVA_ENV ?? "production") === "production";
  const token = env.BROWSER_SERVICE_TOKEN ?? "";
  // Сервис управляет браузером в интернете от имени установки. Без
  // общего секрета в production им мог бы пользоваться любой сосед по
  // сети — запуск отказывает, а не открывается.
  if (production && token.length < 16) {
    throw new Error("BROWSER_SERVICE_TOKEN не задан или короче 16 знаков: в production сервис не стартует");
  }
  return {
    port: clamped("BROWSER_SERVICE_PORT", 8098, 1, 65_535, env),
    host: env.BROWSER_SERVICE_HOST ?? "0.0.0.0",
    token,
    production,
    maxSessions: clamped("BROWSER_MAX_SESSIONS", 8, 1, 32, env),
    maxSessionsPerOwner: clamped("BROWSER_MAX_SESSIONS_PER_OWNER", 2, 1, 8, env),
    sessionIdleMs: clamped("BROWSER_SESSION_IDLE_MS", 300_000, 30_000, 3_600_000, env),
    sessionMaxAgeMs: clamped("BROWSER_SESSION_MAX_AGE_MS", 1_800_000, 60_000, 4 * 3_600_000, env),
    operationTimeoutMs: clamped("BROWSER_OPERATION_TIMEOUT_MS", 15_000, 1_000, 60_000, env),
    navigationTimeoutMs: clamped("BROWSER_NAVIGATION_TIMEOUT_MS", 20_000, 2_000, 60_000, env),
    snapshotMaxChars: clamped("BROWSER_SNAPSHOT_MAX_CHARS", 12_000, 1_000, 60_000, env),
    maxTypeChars: clamped("BROWSER_MAX_TYPE_CHARS", 2_000, 1, 10_000, env),
    executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
  };
}
