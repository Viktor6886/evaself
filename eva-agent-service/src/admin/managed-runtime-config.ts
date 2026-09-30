import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { parseLiveStreamMode, parseLiveTypingSpeed } from "../telegram/live-pace.js";
import { KNOWLEDGE_SETTINGS, OSINT_SETTINGS, type SettingDefinition } from "./settings-registry.js";

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
  | "knowledgeIndexEnabled" | "knowledgeChunkSize" | "knowledgeChunkOverlap" | "knowledgeEmbeddingBatch"
>;
/** База знаний: ключ панели → поле конфигурации. Задания читают их при каждом запуске. */
const KNOWLEDGE_FIELDS: Array<[string, keyof LiveSettings]> = [
  ["runtime.knowledge_index_enabled", "knowledgeIndexEnabled"],
  ["runtime.knowledge_chunk_size", "knowledgeChunkSize"],
  ["runtime.knowledge_chunk_overlap", "knowledgeChunkOverlap"],
  ["runtime.knowledge_embedding_batch", "knowledgeEmbeddingBatch"],
];
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
  ...KNOWLEDGE_FIELDS,
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
      knowledgeIndexEnabled: config.knowledgeIndexEnabled,
      knowledgeChunkSize: config.knowledgeChunkSize,
      knowledgeChunkOverlap: config.knowledgeChunkOverlap,
      knowledgeEmbeddingBatch: config.knowledgeEmbeddingBatch,
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
      // База знаний: индексация читает флаг и нарезку при каждом задании.
      case "runtime.knowledge_index_enabled":
        config.knowledgeIndexEnabled = boolean(value, config.knowledgeIndexEnabled);
        break;
      case "runtime.knowledge_chunk_size":
        config.knowledgeChunkSize = integer(value, config.knowledgeChunkSize);
        break;
      case "runtime.knowledge_chunk_overlap":
        config.knowledgeChunkOverlap = integer(value, config.knowledgeChunkOverlap);
        break;
      case "runtime.knowledge_embedding_batch":
        config.knowledgeEmbeddingBatch = integer(value, config.knowledgeEmbeddingBatch);
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

/** Ключ OSINT-настройки → поле конфигурации: единая таблица для импорта и применения. */
const OSINT_FIELDS: ReadonlyMap<string, keyof LiveSettings> = new Map([
  ...OSINT_FLAGS,
  ["runtime.osint_daily_limit", "osintDailyLimit"],
]);

/**
 * Перенос OSINT-настроек из окружения в панель.
 *
 * Ключи OSINT появились после того, как установка прошла первичный
 * импорт окружения, и панель показывала бы для них значения по
 * умолчанию. Установка, работающая с `EVA_OSINT_ENABLED=true`, выглядела
 * бы выключенной, а первое же сохранение любой настройки записало бы
 * показанное `false` и выключило бы работающий контур. Поэтому при старте
 * значение окружения, отличное от умолчания, записывается в панель — если
 * там ещё ничего нет. Значение панели не трогается никогда.
 */
export async function importEnvironmentOsintSettings(
  config: Config,
  db: Pick<Database, "query">,
): Promise<string[]> {
  return await importEnvironmentSettings(config, db, OSINT_SETTINGS, OSINT_FIELDS);
}

/**
 * Перенос настроек базы знаний из окружения в панель — по той же причине,
 * что и OSINT: ключи появились после первичного импорта, и установка с
 * `EVA_KNOWLEDGE_INDEX=true` выглядела бы в панели выключенной.
 */
export async function importEnvironmentKnowledgeSettings(
  config: Config,
  db: Pick<Database, "query">,
): Promise<string[]> {
  return await importEnvironmentSettings(config, db, KNOWLEDGE_SETTINGS, new Map(KNOWLEDGE_FIELDS));
}

async function importEnvironmentSettings(
  config: Config,
  db: Pick<Database, "query">,
  definitions: readonly SettingDefinition[],
  fields: ReadonlyMap<string, keyof LiveSettings>,
): Promise<string[]> {
  const imported: string[] = [];
  for (const definition of definitions) {
    const field = fields.get(definition.key);
    if (!field) continue;
    const value = config[field];
    if (value === definition.default) continue;
    const { rowCount } = await db.query(
      `INSERT INTO system_settings (key, value_json) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [definition.key, JSON.stringify(value)],
    );
    if (rowCount) {
      await db.query(
        `INSERT INTO config_versions (scope, key, old_value_json, new_value_json)
         VALUES ('environment', $1, NULL, $2::jsonb)`,
        [definition.key, JSON.stringify(value)],
      );
      imported.push(definition.key);
    }
  }
  return imported;
}
