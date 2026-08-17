import type { Config } from "../config.js";
import type { Database } from "../db.js";

interface SettingRow {
  key: string;
  value_json: unknown;
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? value as number : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Apply PostgreSQL settings over bootstrap environment values. */
export async function applyManagedRuntimeConfig(
  config: Config,
  db: Database,
): Promise<string[]> {
  const { rows } = await db.query<SettingRow>(
    `SELECT key, value_json
       FROM system_settings
      WHERE key LIKE 'runtime.%'`,
  );
  const changed: string[] = [];
  for (const row of rows) {
    const value = row.value_json;
    switch (row.key) {
      case "runtime.timezone":
        if (typeof value === "string" && value) config.defaultTimezone = value;
        break;
      case "runtime.scheduler_interval_seconds":
        config.schedulerIntervalMs = integer(value, config.schedulerIntervalMs / 1000) * 1000;
        break;
      case "runtime.heartbeat_interval_seconds":
        config.heartbeatIntervalMs = integer(value, config.heartbeatIntervalMs / 1000) * 1000;
        break;
      case "runtime.telegram_typing_interval_ms":
        config.typingIntervalMs = integer(value, config.typingIntervalMs);
        break;
      case "runtime.profile_completion_enabled":
        config.profileCompletionEnabled = boolean(value, config.profileCompletionEnabled);
        break;
      case "runtime.vector_goals_enabled":
        config.vectorGoalsEnabled = boolean(value, config.vectorGoalsEnabled);
        break;
      case "runtime.profile_cache_ttl_seconds":
        config.profileCacheTtlSeconds = integer(value, config.profileCacheTtlSeconds);
        break;
      case "runtime.conversation_mirror_enabled":
        config.conversationMirrorEnabled = boolean(value, config.conversationMirrorEnabled);
        break;
      case "runtime.outbox_enabled":
        config.outboxEnabled = boolean(value, config.outboxEnabled);
        break;
      case "runtime.log_level":
        if (typeof value === "string" && value) config.logLevel = value;
        break;
      case "runtime.lock_ttl_seconds":
        config.lockTtlSeconds = integer(value, config.lockTtlSeconds);
        break;
      case "runtime.turn_timeout_ms":
        config.turnTimeoutMs = integer(value, config.turnTimeoutMs);
        break;
      default:
        continue;
    }
    changed.push(row.key);
  }
  return changed;
}
