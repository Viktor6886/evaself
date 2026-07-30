/**
 * Редактируемые настройки внешних интеграций.
 *
 * Раньше карточка интеграции умела только показать цвет и поставить
 * проверку в очередь: Base URL, ключ и выбор провайдера правились
 * исключительно в .env на сервере с последующим перезапуском вручную.
 *
 * Здесь описан набор полей каждой интеграции и один путь записи:
 * значения без секрета идут в system_settings под теми же ключами
 * bootstrap.env.*, которые уже проверяет каталог сервисов, а ключи — в
 * Secret Store. Сохранённый секрет наружу не возвращается никогда: в
 * ответе есть только признак «настроен».
 *
 * Важное ограничение, которое честно отражено в ответе: значения читают
 * контейнеры из своего окружения, поэтому изменение вступает в силу
 * после перезапуска сервиса, указанного в restart_required.
 */

import type pg from "pg";

import { adminBadRequest, adminNotFound } from "./errors.js";
import type { SecretStore } from "./secret-store.js";
import { INTEGRATION_BY_ID } from "./service-catalog.js";

export type FieldKind = "text" | "url" | "secret" | "select";

export interface IntegrationField {
  /** Имя поля в запросе на запись. */
  name: string;
  kind: FieldKind;
  title: string;
  hint: string;
  /** Для kind="secret" — ссылка в Secret Store, иначе ключ настройки. */
  ref: string;
  required: boolean;
  placeholder?: string;
  options?: Array<{ value: string; title: string }>;
}

interface IntegrationForm {
  fields: readonly IntegrationField[];
  /** Какой контейнер перечитывает эти значения при старте. */
  restartService: string | null;
  note?: string;
}

const setting = (
  name: string,
  ref: string,
  title: string,
  hint: string,
  extra: Partial<IntegrationField> = {},
): IntegrationField => ({
  name, kind: "text", title, hint, ref, required: false, ...extra,
});

const secret = (name: string, ref: string, title: string, hint: string): IntegrationField => ({
  name, kind: "secret", title, hint, ref, required: true,
});

/**
 * Наборы полей заданы явно, а не выведены из requiredSecrets: у Base URL
 * и модели нет секрета, а у провайдера вообще нет отдельной переменной —
 * это выбор, который подставляет Base URL и модель разом.
 */
const FORMS: Record<string, IntegrationForm> = {
  asr: {
    restartService: "media-service",
    note: "Провайдер задаётся адресом OpenAI-совместимого endpoint и моделью.",
    fields: [
      setting("provider", "bootstrap.env.media.asr.provider", "Провайдер",
        "Подставляет Base URL и модель; «Свой» оставляет поля как есть", {
          kind: "select",
          options: [
            { value: "openai", title: "OpenAI Whisper" },
            { value: "deepgram", title: "Deepgram" },
            { value: "custom", title: "Свой endpoint" },
          ],
        }),
      setting("base_url", "bootstrap.env.media.asr.base.url", "Base URL",
        "Адрес OpenAI-совместимого API распознавания", {
          kind: "url", required: true, placeholder: "https://api.openai.com/v1",
        }),
      secret("api_key", "sec_media_asr_api_key", "API Key", "Показывается только признак «настроен»"),
      setting("model", "bootstrap.env.media.asr.model", "Модель", "Например, whisper-1", {
        placeholder: "whisper-1",
      }),
      setting("language", "bootstrap.env.media.asr.language", "Язык",
        "Код языка или пусто для автоопределения", { placeholder: "ru" }),
    ],
  },
  tts: {
    restartService: "media-service",
    fields: [
      setting("provider", "bootstrap.env.media.tts.provider", "Провайдер",
        "Подставляет Base URL и модель; «Свой» оставляет поля как есть", {
          kind: "select",
          options: [
            { value: "openai", title: "OpenAI TTS" },
            { value: "custom", title: "Свой endpoint" },
          ],
        }),
      setting("base_url", "bootstrap.env.media.tts.base.url", "Base URL",
        "Адрес OpenAI-совместимого API синтеза", {
          kind: "url", required: true, placeholder: "https://api.openai.com/v1",
        }),
      secret("api_key", "sec_media_tts_api_key", "API Key", "Показывается только признак «настроен»"),
      setting("model", "bootstrap.env.media.tts.model", "Модель", "Например, tts-1", {
        placeholder: "tts-1",
      }),
      setting("voice", "bootstrap.env.media.tts.voice", "Голос", "Идентификатор голоса провайдера", {
        placeholder: "nova",
      }),
    ],
  },
  todoist: {
    restartService: "eva-agent-service",
    fields: [
      setting("api_url", "bootstrap.env.todoist.api.url", "Base URL", "Адрес API Todoist", {
        kind: "url", placeholder: "https://api.todoist.com/api/v1",
      }),
      secret("api_token", "sec_todoist_api_token", "API Token", "Персональный токен Todoist"),
      setting("project_id", "bootstrap.env.todoist.project.id", "ID проекта",
        "Проект, куда попадают задачи Евы"),
    ],
  },
  searxng: {
    restartService: "searxng",
    fields: [
      setting("base_url", "bootstrap.env.searxng.base.url", "Base URL",
        "Внутренний адрес SearXNG", { kind: "url", placeholder: "http://searxng:8080/" }),
      secret("secret", "sec_searxng_secret", "Secret", "Внутренний ключ подписи SearXNG"),
    ],
  },
  crawl4ai: {
    restartService: "crawl4ai",
    fields: [
      secret("api_token", "sec_crawl4ai_api_token", "API Token", "Ключ доступа к Crawl4AI"),
    ],
  },
  telegram: {
    restartService: "eva-agent-service",
    note: "Смена токена бота требует переустановки webhook.",
    fields: [
      setting("api_base_url", "bootstrap.env.eva.telegram.api.base.url", "Base URL",
        "Адрес Bot API; менять только для собственного Bot API Server", {
          kind: "url", placeholder: "https://api.telegram.org",
        }),
      secret("bot_token", "sec_eva_telegram_bot_token", "Bot Token", "Токен от BotFather"),
      setting("owner_id", "bootstrap.env.owner.telegram.id", "Telegram ID владельца",
        "Кому уходят критические уведомления", { required: true }),
    ],
  },
};

export interface IntegrationConfig {
  id: string;
  title: string;
  purpose: string;
  editable: boolean;
  restart_required: string | null;
  note: string | null;
  fields: Array<IntegrationField & { value: string | null; configured: boolean }>;
  last_check: {
    state: string;
    color: string;
    ok_at: string | null;
    checked_at: string | null;
    message: string | null;
  } | null;
}

export class IntegrationConfigService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly secrets: SecretStore,
  ) {}

  async get(id: string): Promise<IntegrationConfig> {
    const definition = INTEGRATION_BY_ID.get(id);
    if (!definition) throw adminNotFound("Интеграция не найдена");
    const form = FORMS[id];

    const [settings, configuredSecrets, status] = await Promise.all([
      this.settingValues(form ? form.fields.filter((f) => f.kind !== "secret").map((f) => f.ref) : []),
      this.configuredSecrets(),
      this.status(id),
    ]);

    return {
      id,
      title: definition.title,
      purpose: definition.purpose,
      editable: Boolean(form),
      restart_required: form?.restartService ?? null,
      note: form?.note ?? null,
      fields: (form?.fields ?? []).map((field) => ({
        ...field,
        // Значение секрета не возвращается ни при каких условиях.
        value: field.kind === "secret" ? null : (settings.get(field.ref) ?? null),
        configured: field.kind === "secret"
          ? configuredSecrets.has(field.ref)
          : Boolean(settings.get(field.ref)),
      })),
      last_check: status,
    };
  }

  /**
   * Записывает присланные поля. Пустая строка у секрета означает «не
   * трогать»: форма не показывает текущее значение, и пустое поле — это
   * «оставил как было», а не «стереть».
   */
  async put(id: string, body: Record<string, unknown>, actorId: string): Promise<IntegrationConfig> {
    // Сначала каталог: несуществующая интеграция должна давать 404, а не
    // «нет редактируемых настроек» — это разные ситуации для вызывающего.
    if (!INTEGRATION_BY_ID.has(id)) throw adminNotFound("Интеграция не найдена");
    const form = FORMS[id];
    if (!form) throw adminBadRequest("Для этой интеграции нет редактируемых настроек");

    const settingUpdates: Array<[string, string]> = [];
    const secretUpdates: Array<[string, string]> = [];

    for (const field of form.fields) {
      if (!(field.name in body)) continue;
      const raw = body[field.name];
      if (raw !== null && typeof raw !== "string") {
        throw adminBadRequest(`${field.title}: ожидается строка`);
      }
      const value = (raw ?? "").trim();

      if (field.kind === "secret") {
        if (!value) continue;
        secretUpdates.push([field.ref, value]);
        continue;
      }
      if (field.required && !value) {
        throw adminBadRequest(`${field.title}: обязательное поле`);
      }
      if (field.kind === "url" && value && !isHttpUrl(value)) {
        throw adminBadRequest(`${field.title}: ожидается адрес http(s)://`);
      }
      if (field.kind === "select" && value) {
        const allowed = (field.options ?? []).map((option) => option.value);
        if (!allowed.includes(value)) {
          throw adminBadRequest(`${field.title}: недопустимое значение`);
        }
      }
      settingUpdates.push([field.ref, value]);
    }

    if (settingUpdates.length === 0 && secretUpdates.length === 0) {
      throw adminBadRequest("Нет полей для сохранения");
    }

    // Настройки пишутся одной транзакцией; секреты — своим хранилищем,
    // у которого собственная запись в аудит и версионирование.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [key, value] of settingUpdates) {
        await client.query(
          `INSERT INTO system_settings (key, value_json)
           VALUES ($1, to_jsonb($2::text))
           ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
          [key, value],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    for (const [ref, value] of secretUpdates) {
      await this.secrets.put(ref, value, undefined, actorId);
    }

    return await this.get(id);
  }

  private async settingValues(keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const { rows } = await this.pool.query<{ key: string; value_json: unknown }>(
      "SELECT key, value_json FROM system_settings WHERE key = ANY($1::text[])",
      [keys],
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.key, typeof row.value_json === "string" ? row.value_json : String(row.value_json ?? ""));
    }
    return map;
  }

  private async configuredSecrets(): Promise<Set<string>> {
    const list = await this.secrets.list();
    return new Set(list.filter((item) => item.configured).map((item) => item.secret_ref));
  }

  private async status(id: string): Promise<IntegrationConfig["last_check"]> {
    const { rows } = await this.pool.query<{
      state: string; color: string; last_ok_at: Date | null;
      last_check_at: Date | null; detail_json: Record<string, unknown>;
    }>(
      `SELECT state, color, last_ok_at, last_check_at, detail_json
         FROM service_statuses WHERE target_id = $1`,
      [`integration:${id}`],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      state: row.state,
      color: row.color,
      ok_at: row.last_ok_at?.toISOString() ?? null,
      checked_at: row.last_check_at?.toISOString() ?? null,
      message: typeof row.detail_json.message === "string" ? row.detail_json.message : null,
    };
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
