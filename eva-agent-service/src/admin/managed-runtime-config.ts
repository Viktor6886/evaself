import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { parseLiveStreamMode, parseLiveTypingSpeed } from "../telegram/live-pace.js";

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

/**
 * Значения, с которыми процесс стартовал из окружения, — для флагов,
 * которые панель переключает без перезапуска.
 *
 * Откат первого сохранения удаляет строку настройки. Без запомненного
 * исходного значения флаг остался бы в памяти таким, каким его включили,
 * и держался бы до перезапуска, хотя панель уже показывает другое.
 */
type LiveSettings = Pick<
  Config,
  | "audioFileTranscriptsEnabled" | "telegramStreamMode" | "telegramTypingSpeed"
  | "osintEnabled" | "osintRuRegistriesEnabled" | "osintDailyLimit"
  | "osintCollectorMaigret" | "osintCollectorWeb" | "osintCollectorInfrastructure"
  | "osintCollectorHarvester" | "osintCollectorSpiderfoot"
>;
/** Флаги OSINT: ключ панели → поле конфигурации. Все читаются на каждом ходе и задании. */
const OSINT_FLAGS: Array<[string, keyof LiveSettings]> = [
  ["runtime.osint_enabled", "osintEnabled"],
  ["runtime.osint_ru_registries", "osintRuRegistriesEnabled"],
  ["runtime.osint_collector_maigret", "osintCollectorMaigret"],
  ["runtime.osint_collector_web", "osintCollectorWeb"],
  ["runtime.osint_collector_infrastructure", "osintCollectorInfrastructure"],
  ["runtime.osint_collector_theharvester", "osintCollectorHarvester"],
  ["runtime.osint_collector_spiderfoot", "osintCollectorSpiderfoot"],
];
const bootstrapLiveSettings = new WeakMap<Config, LiveSettings>();
const LIVE_SETTING_FIELDS: Array<[string, keyof LiveSettings]> = [
  ["runtime.audio_file_transcripts", "audioFileTranscriptsEnabled"],
  ["runtime.telegram_stream_mode", "telegramStreamMode"],
  ["runtime.telegram_typing_speed", "telegramTypingSpeed"],
  ...OSINT_FLAGS,
  ["runtime.osint_daily_limit", "osintDailyLimit"],
];

/** Apply PostgreSQL settings over bootstrap environment values. */
export async function applyManagedRuntimeConfig(
  config: Config,
  db: Database,
): Promise<string[]> {
  if (!bootstrapLiveSettings.has(config)) {
    bootstrapLiveSettings.set(config, {
      audioFileTranscriptsEnabled: config.audioFileTranscriptsEnabled,
      telegramStreamMode: config.telegramStreamMode,
      telegramTypingSpeed: config.telegramTypingSpeed,
      osintEnabled: config.osintEnabled,
      osintRuRegistriesEnabled: config.osintRuRegistriesEnabled,
      osintDailyLimit: config.osintDailyLimit,
      osintCollectorMaigret: config.osintCollectorMaigret,
      osintCollectorWeb: config.osintCollectorWeb,
      osintCollectorInfrastructure: config.osintCollectorInfrastructure,
      osintCollectorHarvester: config.osintCollectorHarvester,
      osintCollectorSpiderfoot: config.osintCollectorSpiderfoot,
    });
  }
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
      // Флаг читается на каждом сообщении, поэтому переключатель в
      // панели действует сразу, без перезапуска.
      case "runtime.audio_file_transcripts":
        config.audioFileTranscriptsEnabled = boolean(value, config.audioFileTranscriptsEnabled);
        break;
      // Режим и темп показа читаются при каждом ответе: переключатель в
      // панели действует со следующего сообщения.
      case "runtime.telegram_stream_mode":
        config.telegramStreamMode = parseLiveStreamMode(value, config.telegramStreamMode);
        break;
      case "runtime.telegram_typing_speed":
        config.telegramTypingSpeed = parseLiveTypingSpeed(value, config.telegramTypingSpeed);
        break;
      // OSINT: инструменты, сервис и задания читают флаги при каждом
      // вызове, поэтому переключатель действует без перезапуска.
      case "runtime.osint_enabled":
      case "runtime.osint_ru_registries":
      case "runtime.osint_collector_maigret":
      case "runtime.osint_collector_web":
      case "runtime.osint_collector_infrastructure":
      case "runtime.osint_collector_theharvester":
      case "runtime.osint_collector_spiderfoot": {
        const field = OSINT_FLAGS.find(([key]) => key === row.key)![1];
        (config as Record<keyof LiveSettings, unknown>)[field] = boolean(value, config[field] as boolean);
        break;
      }
      case "runtime.osint_daily_limit":
        config.osintDailyLimit = integer(value, config.osintDailyLimit);
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
  const bootstrap = bootstrapLiveSettings.get(config)!;
  for (const [key, field] of LIVE_SETTING_FIELDS) {
    if (!rows.some((row) => row.key === key)) {
      (config as Record<keyof LiveSettings, unknown>)[field] = bootstrap[field];
    }
  }
  return changed;
}
