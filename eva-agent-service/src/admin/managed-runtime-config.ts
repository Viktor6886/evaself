import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { parseLiveStreamMode, parseLiveTypingSpeed } from "../telegram/live-pace.js";
import { parseKnowledgeSearchMode, parseKnowledgeVectorBackend } from "../knowledge/search-settings.js";
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
  | "knowledgeUploadsEnabled" | "knowledgeIndexEnabled" | "knowledgeChunkSize" | "knowledgeChunkOverlap" | "knowledgeEmbeddingBatch"
  | "knowledgeSearchEnabled" | "knowledgeSearchMode" | "knowledgeVectorBackend" | "knowledgeSearchShadow"
  | "knowledgePrivateEnabled" | "knowledgeGlobalEnabled"
  | "knowledgeRerankEnabled" | "knowledgeRerankProvider" | "knowledgeRerankModel" | "knowledgeContextNeighbors"
>;
/** Поиск по базе знаний: ключ панели → поле конфигурации. Поиск читает их при каждом вызове. */
const KNOWLEDGE_SEARCH_BOOLEANS: Array<[string, keyof LiveSettings]> = [
  ["runtime.knowledge_search_enabled", "knowledgeSearchEnabled"],
  ["runtime.knowledge_search_shadow", "knowledgeSearchShadow"],
  ["runtime.knowledge_private_enabled", "knowledgePrivateEnabled"],
  ["runtime.knowledge_global_enabled", "knowledgeGlobalEnabled"],
  ["runtime.knowledge_rerank_enabled", "knowledgeRerankEnabled"],
];
const KNOWLEDGE_SEARCH_FIELDS: Array<[string, keyof LiveSettings]> = [
  ...KNOWLEDGE_SEARCH_BOOLEANS,
  ["runtime.knowledge_search_mode", "knowledgeSearchMode"],
  ["runtime.knowledge_vector_backend", "knowledgeVectorBackend"],
  ["runtime.knowledge_rerank_provider", "knowledgeRerankProvider"],
  ["runtime.knowledge_rerank_model", "knowledgeRerankModel"],
  ["runtime.knowledge_context_neighbors", "knowledgeContextNeighbors"],
];
/** База знаний: ключ панели → поле конфигурации. Задания читают их при каждом запуске. */
const KNOWLEDGE_FIELDS: Array<[string, keyof LiveSettings]> = [
  ["runtime.knowledge_uploads_enabled", "knowledgeUploadsEnabled"],
  ["runtime.knowledge_index_enabled", "knowledgeIndexEnabled"],
  ["runtime.knowledge_chunk_size", "knowledgeChunkSize"],
  ["runtime.knowledge_chunk_overlap", "knowledgeChunkOverlap"],
  ["runtime.knowledge_embedding_batch", "knowledgeEmbeddingBatch"],
  ...KNOWLEDGE_SEARCH_FIELDS,
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

/** Admin-api живёт отдельно от агента и читает канонический флаг при приёме файла. */
export async function readKnowledgeUploadsSetting(db: Pick<Database, "query">, bootstrap: boolean): Promise<boolean> {
  const { rows } = await db.query<{ value_json: unknown }>(
    "SELECT value_json FROM system_settings WHERE key = $1", ["runtime.knowledge_uploads_enabled"],
  );
  return typeof rows[0]?.value_json === "boolean" ? rows[0].value_json : bootstrap;
}

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
      knowledgeUploadsEnabled: config.knowledgeUploadsEnabled,
      knowledgeIndexEnabled: config.knowledgeIndexEnabled,
      knowledgeChunkSize: config.knowledgeChunkSize,
      knowledgeChunkOverlap: config.knowledgeChunkOverlap,
      knowledgeEmbeddingBatch: config.knowledgeEmbeddingBatch,
      knowledgeSearchEnabled: config.knowledgeSearchEnabled,
      knowledgeSearchMode: config.knowledgeSearchMode,
      knowledgeVectorBackend: config.knowledgeVectorBackend,
      knowledgeSearchShadow: config.knowledgeSearchShadow,
      knowledgePrivateEnabled: config.knowledgePrivateEnabled,
      knowledgeGlobalEnabled: config.knowledgeGlobalEnabled,
      knowledgeRerankEnabled: config.knowledgeRerankEnabled,
      knowledgeRerankProvider: config.knowledgeRerankProvider,
      knowledgeRerankModel: config.knowledgeRerankModel,
      knowledgeContextNeighbors: config.knowledgeContextNeighbors,
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
      // Приём файлов читает флаг при каждом запросе, задания — при запуске.
      case "runtime.knowledge_uploads_enabled":
        config.knowledgeUploadsEnabled = boolean(value, config.knowledgeUploadsEnabled);
        break;
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
      // Поиск по базе знаний читает настройки при каждом вызове.
      case "runtime.knowledge_search_enabled":
      case "runtime.knowledge_search_shadow":
      case "runtime.knowledge_private_enabled":
      case "runtime.knowledge_global_enabled":
      case "runtime.knowledge_rerank_enabled": {
        const field = KNOWLEDGE_SEARCH_BOOLEANS.find(([key]) => key === row.key)![1];
        (config as Record<keyof LiveSettings, unknown>)[field] = boolean(value, config[field] as boolean);
        break;
      }
      case "runtime.knowledge_search_mode":
        config.knowledgeSearchMode = parseKnowledgeSearchMode(value, config.knowledgeSearchMode);
        break;
      case "runtime.knowledge_vector_backend":
        config.knowledgeVectorBackend = parseKnowledgeVectorBackend(value, config.knowledgeVectorBackend);
        break;
      case "runtime.knowledge_rerank_provider":
        if (typeof value === "string") config.knowledgeRerankProvider = value.trim().slice(0, 64);
        break;
      case "runtime.knowledge_rerank_model":
        if (typeof value === "string") config.knowledgeRerankModel = value.trim().slice(0, 200);
        break;
      case "runtime.knowledge_context_neighbors":
        config.knowledgeContextNeighbors = Math.min(Math.max(integer(value, config.knowledgeContextNeighbors), 0), 2);
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
