export type StatusColor = "gray" | "blue" | "red" | "yellow" | "green";
export type TargetType = "service" | "integration" | "provider" | "infrastructure";

export interface ServiceDefinition {
  id: string;
  title: string;
  purpose: string;
  group: "core" | "storage" | "ai" | "infrastructure";
  container: string;
  healthUrl?: string;
  publicSetting?: string;
  optional?: boolean;
  restartable?: boolean;
}

export interface IntegrationDefinition {
  id: string;
  title: string;
  purpose: string;
  group: "external" | "media" | "data";
  serviceId?: string;
  requiredSecrets?: string[];
  requiredSettings?: string[];
  publicSetting?: string;
  optional?: boolean;
}

export const SERVICES: readonly ServiceDefinition[] = [
  {
    id: "agent-runtime",
    title: "Agent Runtime",
    purpose: "Telegram, очереди, инструменты и официальный Letta Agent SDK",
    group: "core",
    container: "eva-agent-service",
    healthUrl: "http://eva-agent-service:8070/health",
    restartable: true,
  },
  {
    id: "app-server",
    title: "Letta App Server",
    purpose: "Агенты, conversation и память",
    group: "core",
    container: "letta-app-server",
    restartable: true,
  },
  {
    id: "admin-api",
    title: "Административный API",
    purpose: "Защищённый контур управления Evaself",
    group: "core",
    container: "admin-api",
    healthUrl: "http://admin-api:8071/health",
    restartable: true,
  },
  {
    id: "postgres",
    title: "PostgreSQL",
    purpose: "Основные данные, связи агентов и конфигурация",
    group: "storage",
    container: "postgres",
    restartable: true,
  },
  {
    id: "valkey",
    title: "Valkey",
    purpose: "Блокировки, кеш и очереди",
    group: "storage",
    container: "valkey",
    restartable: true,
  },
  {
    id: "nocodb",
    title: "NocoDB",
    purpose: "Табличный интерфейс базы Eva",
    group: "storage",
    container: "nocodb",
    healthUrl: "http://nocodb:8080/api/v1/health",
    publicSetting: "bootstrap.env.domain.nocodb",
    restartable: true,
  },
  {
    id: "media-service",
    title: "Голос и медиа",
    purpose: "ASR, TTS и обработка вложений",
    group: "ai",
    container: "media-service",
    healthUrl: "http://media-service:8090/health",
    restartable: true,
  },
  {
    id: "searxng",
    title: "SearXNG",
    purpose: "Приватный метапоиск",
    group: "ai",
    container: "searxng",
    healthUrl: "http://searxng:8080/healthz",
    restartable: true,
  },
  {
    id: "crawl4ai",
    title: "Crawl4AI",
    purpose: "Загрузка и очистка веб-страниц",
    group: "ai",
    container: "crawl4ai",
    healthUrl: "http://crawl4ai:11235/health",
    optional: true,
    restartable: true,
  },
  {
    id: "caddy",
    title: "Caddy",
    purpose: "HTTPS, сертификаты и reverse proxy",
    group: "infrastructure",
    container: "caddy",
    restartable: true,
  },
  {
    id: "webapp",
    title: "WebApp",
    purpose: "Главная страница и Telegram Mini App",
    group: "infrastructure",
    container: "webapp",
    healthUrl: "http://webapp:8082/healthz",
    publicSetting: "bootstrap.env.domain.app",
    restartable: true,
  },
  {
    id: "letta-ui",
    title: "Letta",
    purpose: "Отдельная консоль агентов и диалогов",
    group: "infrastructure",
    container: "letta-ui",
    healthUrl: "http://letta-ui:8081/healthz",
    publicSetting: "bootstrap.env.domain.letta",
    restartable: true,
  },
  {
    id: "admin-ui",
    title: "Admin WebUI",
    purpose: "Главная административная панель",
    group: "infrastructure",
    container: "admin-ui",
    healthUrl: "http://admin-ui:8083/healthz",
    restartable: true,
  },
  {
    id: "backup-service",
    title: "Backup Service",
    purpose: "Версионные дампы PostgreSQL",
    group: "infrastructure",
    container: "backup-service",
    restartable: true,
  },
  {
    id: "monitoring",
    title: "Monitoring",
    purpose: "Проверки доступности в Uptime Kuma",
    group: "infrastructure",
    container: "uptime-kuma",
    publicSetting: "bootstrap.env.domain.status",
    optional: true,
    restartable: true,
  },
] as const;

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: "telegram",
    title: "Telegram",
    purpose: "Бот, webhook, Mini App, inbox и outbox",
    group: "external",
    serviceId: "agent-runtime",
    requiredSecrets: ["sec_eva_telegram_bot_token", "sec_eva_telegram_webhook_secret"],
    requiredSettings: ["bootstrap.env.owner.telegram.id"],
  },
  {
    id: "todoist",
    title: "Todoist",
    purpose: "Проекты и задачи пользователя",
    group: "external",
    serviceId: "agent-runtime",
    requiredSecrets: ["sec_todoist_api_token"],
    requiredSettings: ["bootstrap.env.todoist.project.id"],
    optional: true,
  },
  {
    id: "searxng",
    title: "SearXNG",
    purpose: "Поиск в интернете без передачи ключей",
    group: "external",
    serviceId: "searxng",
    requiredSecrets: ["sec_searxng_secret"],
  },
  {
    id: "crawl4ai",
    title: "Crawl4AI",
    purpose: "Извлечение содержимого веб-страниц",
    group: "external",
    serviceId: "crawl4ai",
    requiredSecrets: ["sec_crawl4ai_api_token"],
    optional: true,
  },
  {
    id: "asr",
    title: "Распознавание речи",
    purpose: "Преобразование голосовых сообщений в текст",
    group: "media",
    serviceId: "media-service",
    requiredSecrets: ["sec_media_asr_api_key"],
    requiredSettings: ["bootstrap.env.media.asr.base.url"],
    optional: true,
  },
  {
    id: "tts",
    title: "Синтез речи",
    purpose: "Голосовые ответы Евы",
    group: "media",
    serviceId: "media-service",
    requiredSecrets: ["sec_media_tts_api_key"],
    requiredSettings: ["bootstrap.env.media.tts.base.url"],
    optional: true,
  },
  {
    id: "nocodb",
    title: "NocoDB",
    purpose: "Подключение всех таблиц базы Eva",
    group: "data",
    serviceId: "nocodb",
    publicSetting: "bootstrap.env.domain.nocodb",
  },
  {
    id: "monitoring",
    title: "Monitoring",
    purpose: "Внешняя статусная страница установки",
    group: "external",
    serviceId: "monitoring",
    publicSetting: "bootstrap.env.domain.status",
    optional: true,
  },
] as const;

export const SERVICE_BY_ID = new Map(SERVICES.map((item) => [item.id, item]));
export const INTEGRATION_BY_ID = new Map(INTEGRATIONS.map((item) => [item.id, item]));

export function statusColor(input: {
  enabled: boolean;
  configured: boolean;
  checking?: boolean;
  running?: boolean;
  ok?: boolean | null;
  lastOkAt?: Date | null;
  intervalSeconds?: number;
  degraded?: boolean;
  now?: Date;
}): StatusColor {
  if (!input.enabled) return "gray";
  if (input.checking) return "blue";
  if (input.running === false || input.ok === false) return "red";
  if (!input.configured || input.degraded) return "yellow";
  const now = input.now ?? new Date();
  const interval = input.intervalSeconds ?? 60;
  if (!input.lastOkAt ||
      now.getTime() - input.lastOkAt.getTime() > interval * 3 * 1000) {
    return "yellow";
  }
  return input.ok === true ? "green" : "yellow";
}
