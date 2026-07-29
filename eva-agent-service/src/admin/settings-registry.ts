export type SettingType = "string" | "integer" | "boolean" | "select";

export interface SettingDefinition {
  key: string;
  env: string;
  title: string;
  group: string;
  type: SettingType;
  default: string | number | boolean;
  min?: number;
  max?: number;
  required: boolean;
  requires_restart: boolean;
  description: string;
  affects: string[];
}

export const SETTINGS_REGISTRY: readonly SettingDefinition[] = [
  {
    key: "runtime.timezone",
    env: "TZ",
    title: "Часовой пояс",
    group: "runtime",
    type: "string",
    default: "UTC",
    required: true,
    requires_restart: true,
    description: "Часовой пояс установки в формате IANA",
    affects: ["agent-runtime", "scheduler"],
  },
  {
    key: "runtime.scheduler_interval_seconds",
    env: "EVA_SCHEDULER_INTERVAL_MS",
    title: "Интервал планировщика",
    group: "runtime",
    type: "integer",
    default: 60,
    min: 10,
    max: 3600,
    required: true,
    requires_restart: true,
    description: "Как часто scheduler опрашивает очередь задач",
    affects: ["scheduler"],
  },
  {
    key: "runtime.heartbeat_interval_seconds",
    env: "EVA_HEARTBEAT_INTERVAL_MS",
    title: "Интервал heartbeat",
    group: "runtime",
    type: "integer",
    default: 600,
    min: 30,
    max: 86400,
    required: true,
    requires_restart: true,
    description: "Период фоновой проверки контакта",
    affects: ["heartbeat"],
  },
  {
    key: "runtime.telegram_typing_interval_ms",
    env: "EVA_TELEGRAM_TYPING_INTERVAL_MS",
    title: "Интервал Telegram typing",
    group: "runtime",
    type: "integer",
    default: 4000,
    min: 1000,
    max: 10000,
    required: true,
    requires_restart: false,
    description: "Частота продления индикатора набора сообщения",
    affects: ["telegram-runtime"],
  },
  {
    key: "runtime.profile_completion_enabled",
    env: "EVA_PROFILE_COMPLETION_ENABLED",
    title: "Заполнение профиля",
    group: "runtime",
    type: "boolean",
    default: true,
    required: true,
    requires_restart: true,
    description: "Разрешить Еве дополнять профиль пользователя",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.vector_goals_enabled",
    env: "EVA_VECTOR_GOALS_ENABLED",
    title: "Цели VECTOR",
    group: "runtime",
    type: "boolean",
    default: true,
    required: true,
    requires_restart: true,
    description: "Включить инструменты VECTOR для целей",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.graph_memory_enabled",
    env: "EVA_GRAPH_MEMORY_ENABLED",
    title: "Графовая память",
    group: "runtime",
    type: "boolean",
    default: true,
    required: true,
    requires_restart: true,
    description: "Использовать граф связей памяти",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.graph_context_timeout_ms",
    env: "EVA_GRAPH_CONTEXT_TIMEOUT_MS",
    title: "Timeout графового контекста",
    group: "runtime",
    type: "integer",
    default: 75,
    min: 10,
    max: 5000,
    required: true,
    requires_restart: true,
    description: "Максимальное время подготовки графового контекста",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.profile_cache_ttl_seconds",
    env: "EVA_PROFILE_CACHE_TTL_SECONDS",
    title: "TTL кеша профиля",
    group: "runtime",
    type: "integer",
    default: 60,
    min: 1,
    max: 3600,
    required: true,
    requires_restart: true,
    description: "Срок кеширования профиля пользователя",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.conversation_mirror_enabled",
    env: "EVA_CONVERSATION_MIRROR_ENABLED",
    title: "Зеркало conversation",
    group: "runtime",
    type: "boolean",
    default: false,
    required: true,
    requires_restart: true,
    description: "Хранить служебное зеркало диалога в PostgreSQL",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.outbox_enabled",
    env: "EVA_OUTBOX_ENABLED",
    title: "Надёжная очередь исходящих",
    group: "runtime",
    type: "boolean",
    default: true,
    required: true,
    requires_restart: true,
    description: "Отправлять Telegram-сообщения через outbox",
    affects: ["telegram-runtime", "outbox"],
  },
  {
    key: "runtime.log_level",
    env: "EVA_AGENT_LOG_LEVEL",
    title: "Уровень журналирования",
    group: "runtime",
    type: "select",
    default: "info",
    required: true,
    requires_restart: true,
    description: "Минимальный уровень структурированных логов",
    affects: ["agent-runtime", "admin-api"],
  },
  {
    key: "runtime.lock_ttl_seconds",
    env: "EVA_AGENT_LOCK_TTL",
    title: "TTL блокировки пользователя",
    group: "runtime",
    type: "integer",
    default: 180,
    min: 30,
    max: 3600,
    required: true,
    requires_restart: true,
    description: "Срок блокировки параллельной обработки пользователя",
    affects: ["agent-runtime"],
  },
  {
    key: "runtime.turn_timeout_ms",
    env: "EVA_AGENT_TURN_TIMEOUT_MS",
    title: "Timeout одного хода",
    group: "runtime",
    type: "integer",
    default: 240000,
    min: 10000,
    max: 900000,
    required: true,
    requires_restart: true,
    description: "Максимальная длительность одного ответа агента",
    affects: ["agent-runtime"],
  },
] as const;

export const SETTING_BY_KEY = new Map(SETTINGS_REGISTRY.map((item) => [item.key, item]));

export function parseBootstrapSetting(definition: SettingDefinition, raw: string): unknown {
  if (definition.key === "runtime.scheduler_interval_seconds" ||
      definition.key === "runtime.heartbeat_interval_seconds") {
    const milliseconds = Number.parseInt(raw, 10);
    return Number.isFinite(milliseconds) ? Math.round(milliseconds / 1000) : definition.default;
  }
  if (definition.type === "integer") {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : definition.default;
  }
  if (definition.type === "boolean") {
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  }
  return raw.trim();
}
