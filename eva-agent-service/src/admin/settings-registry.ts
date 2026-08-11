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
  /** Что поставить, если не уверен. Показывается НАД полем ввода. */
  recommended?: string;
  /** Готовые значения выпадающим списком вместо ручного ввода. */
  presets?: Array<{ value: string | number | boolean; title: string }>;
  /**
   * Параметр для тонкой настройки. Такие спрятаны за «показать
   * остальные»: администратору в обычной ситуации они не нужны, а
   * длинный список из пятнадцати полей читать невозможно.
   */
  advanced?: boolean;
}

/**
 * Наборы значений сразу для нескольких параметров.
 *
 * Отдельные поля вроде «интервал планировщика» осмысленны только
 * вместе: экономный режим — это одновременно редкий планировщик, редкий
 * heartbeat и предупреждения в журнале. Поэтому кроме пресетов на поле
 * есть пресеты на весь профиль.
 */
export interface SettingProfile {
  code: string;
  title: string;
  description: string;
  values: Record<string, string | number | boolean>;
}

export const SETTING_PROFILES: readonly SettingProfile[] = [
  {
    code: "economy",
    title: "Экономный",
    description: "Меньше фоновых обращений и логов. Для маленького VPS: Ева отвечает так же, но реже проверяет расписание.",
    values: {
      "runtime.scheduler_interval_seconds": 300,
      "runtime.heartbeat_interval_seconds": 1800,
      "runtime.log_level": "warn",
      "runtime.graph_memory_enabled": false,
      "runtime.profile_cache_ttl_seconds": 600,
    },
  },
  {
    code: "balanced",
    title: "Сбалансированный",
    description: "Значения по умолчанию. Подходит большинству установок.",
    values: {
      "runtime.scheduler_interval_seconds": 60,
      "runtime.heartbeat_interval_seconds": 600,
      "runtime.log_level": "info",
      "runtime.graph_memory_enabled": true,
      "runtime.profile_cache_ttl_seconds": 60,
    },
  },
  {
    code: "responsive",
    title: "Отзывчивый",
    description: "Частые проверки расписания и подробный журнал. Заметно нагружает сервер — для отладки и мощных машин.",
    values: {
      "runtime.scheduler_interval_seconds": 15,
      "runtime.heartbeat_interval_seconds": 120,
      "runtime.log_level": "debug",
      "runtime.graph_memory_enabled": true,
      "runtime.profile_cache_ttl_seconds": 15,
    },
  },
] as const;

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
    recommended: "Часовой пояс, в котором живёт владелец — от него считаются «утро» и «вечер» в напоминаниях.",
    presets: [{ value: "Europe/Moscow", title: "Москва" }, { value: "Asia/Yekaterinburg", title: "Екатеринбург" }, { value: "Europe/Kaliningrad", title: "Калининград" }, { value: "Asia/Novosibirsk", title: "Новосибирск" }, { value: "UTC", title: "UTC" }],
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
    recommended: "60 секунд. Реже — меньше нагрузка, но напоминания приходят с задержкой до этого интервала.",
    presets: [{ value: 300, title: "Экономно — раз в 5 минут" }, { value: 60, title: "Обычно — раз в минуту" }, { value: 15, title: "Часто — раз в 15 секунд" }],
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
    recommended: "60 секунд. Это проверка живости фоновых задач, а не опрос Telegram.",
    presets: [{ value: 1800, title: "Экономно — раз в 30 минут" }, { value: 600, title: "Обычно — раз в 10 минут" }, { value: 120, title: "Часто — раз в 2 минуты" }],
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
    recommended: "4000 мс. Telegram сам гасит индикатор через 5 секунд, чаще слать бессмысленно.",
    advanced: true,
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
    recommended: "Включено. Ева постепенно уточняет город, часовой пояс и предпочтения в разговоре.",
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
    recommended: "Включено, если пользуетесь целями и рабочими блоками.",
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
    recommended: "Включено. Выключение экономит память и время ответа, но Ева перестаёт связывать людей и события между собой.",
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
    recommended: "Сколько ждать графовый контекст, прежде чем отвечать без него.",
    advanced: true,
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
    recommended: "300 секунд. Больше — меньше запросов к базе, но правки профиля применяются с задержкой.",
    advanced: true,
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
    recommended: "Включено. Нужно для истории переписки в панели.",
    advanced: true,
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
    recommended: "Включено. Выключать только при разборе проблем с доставкой: без очереди сообщения теряются при сбое.",
    advanced: true,
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
    recommended: "info в обычной работе, debug — только когда разбираете проблему: журнал растёт быстро.",
    presets: [{ value: "warn", title: "Только предупреждения" }, { value: "info", title: "Обычный" }, { value: "debug", title: "Подробный — для отладки" }],
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
    recommended: "Защита от параллельной обработки двух сообщений одного пользователя.",
    advanced: true,
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
    recommended: "Потолок на один ход агента вместе с инструментами.",
    advanced: true,
  },
] as const;

/**
 * Сроки хранения по классам данных (шаг 10).
 *
 * Живут здесь, а не в отдельной системе политик: Config Service уже
 * даёт типы, границы, версию, аудит и откат — ровно то, чего требует
 * шаг. Границы `min`/`max` и есть «допустимые границы» из задания:
 * сократить срок логов до нуля или растянуть его на год через админку
 * нельзя.
 *
 * Классов данных больше, чем настроек: у канонической памяти и
 * сохранённых документов срока нет по существу, и настройка «сколько
 * дней хранить память» была бы обещанием, которого код не выполняет.
 */
const RETENTION_SETTINGS: readonly SettingDefinition[] = [
  {
    key: "retention.app_logs_days",
    env: "EVA_RETENTION_APP_LOGS_DAYS",
    title: "Логи и debug-трассы",
    group: "retention",
    type: "integer",
    default: 7,
    min: 1,
    max: 30,
    required: false,
    requires_restart: false,
    description: "Сколько дней хранятся логи приложения и отладочные трассы",
    affects: ["agent-runtime"],
    recommended: "7 дней. Дольше — дороже хранение и шире окно, в котором отладочные данные вообще существуют.",
  },
  {
    key: "retention.telegram_payload_days",
    env: "EVA_RETENTION_TELEGRAM_PAYLOAD_DAYS",
    title: "Сырой payload Telegram",
    group: "retention",
    type: "integer",
    default: 7,
    min: 1,
    max: 30,
    required: false,
    requires_restart: false,
    description: "Через сколько дней содержание входящих и исходящих сообщений вычищается из очередей",
    affects: ["agent-runtime"],
    recommended: "7 дней. Строка остаётся — вычищается только содержание, поэтому защита от дублей не ломается.",
  },
  {
    key: "retention.media_temp_days",
    env: "EVA_RETENTION_MEDIA_TEMP_DAYS",
    title: "Временные медиафайлы",
    group: "retention",
    type: "integer",
    default: 7,
    min: 1,
    max: 30,
    required: false,
    requires_restart: false,
    description: "Сколько дней живут временные голосовые, изображения, документы и производные",
    affects: ["media-service"],
    recommended: "7 дней. Сохранённые пользователем документы под это правило не подпадают.",
  },
  {
    key: "retention.telegram_idempotency_days",
    env: "EVA_RETENTION_TELEGRAM_IDEMPOTENCY_DAYS",
    title: "Метаданные идемпотентности",
    group: "retention",
    type: "integer",
    default: 30,
    min: 7,
    max: 180,
    required: false,
    requires_restart: false,
    description: "Сколько дней хранятся строки очередей без содержания — защита от повторной доставки",
    affects: ["agent-runtime"],
    recommended: "30 дней. Короче — растёт риск обработать один и тот же апдейт дважды.",
    advanced: true,
  },
  {
    key: "retention.langfuse_metadata_days",
    env: "EVA_RETENTION_LANGFUSE_DAYS",
    title: "Метаданные наблюдаемости",
    group: "retention",
    type: "integer",
    default: 30,
    min: 1,
    max: 90,
    required: false,
    requires_restart: false,
    description: "Заявленный срок хранения метаданных в Langfuse; удаление выполняется на его стороне",
    affects: ["observability"],
    recommended: "30 дней. Это объявление политики, а не удаление: чужой системой управляет её администратор.",
    advanced: true,
  },
  {
    key: "retention.dead_letters_days",
    env: "EVA_RETENTION_DEAD_LETTERS_DAYS",
    title: "Мёртвые задания",
    group: "retention",
    type: "integer",
    default: 90,
    min: 30,
    max: 365,
    required: false,
    requires_restart: false,
    description: "Сколько дней хранятся безопасные метаданные dead-letter",
    affects: ["agent-runtime"],
    recommended: "90 дней: срок разбора редких отказов, а не срок жизни данных.",
    advanced: true,
  },
  {
    key: "retention.metrics_days",
    env: "EVA_RETENTION_METRICS_DAYS",
    title: "Агрегированные метрики",
    group: "retention",
    type: "integer",
    default: 365,
    min: 365,
    max: 1095,
    required: false,
    requires_restart: false,
    description: "Сколько дней хранятся агрегаты без содержания",
    affects: ["observability"],
    recommended: "Не меньше года: сравнивать нагрузку год к году иначе не с чем.",
    advanced: true,
  },
];

export const ALL_SETTINGS: readonly SettingDefinition[] = [
  ...SETTINGS_REGISTRY,
  ...RETENTION_SETTINGS,
];

export const SETTING_BY_KEY = new Map(ALL_SETTINGS.map((item) => [item.key, item]));

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
