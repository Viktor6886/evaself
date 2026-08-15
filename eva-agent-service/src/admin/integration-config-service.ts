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
import { declaredUsedBy, type SecretStore } from "./secret-store.js";
import { INTEGRATION_BY_ID } from "./service-catalog.js";

export type FieldKind = "text" | "url" | "secret" | "select" | "textarea";

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
  options?: Array<{
    value: string;
    title: string;
    /**
     * Что подставить в остальные поля при выборе. Возит сам вариант, а
     * не отдельная таблица в панели: пара «провайдер → его адрес и
     * модель» задана в одном месте и в панель попадает вместе с формой.
     */
     preset?: Record<string, string>;
  }>;
}

interface IntegrationForm {
  fields: readonly IntegrationField[];
  /** Какой контейнер перечитывает эти значения при старте. */
  restartService: string | null;
  note?: string;
}

/**
 * Готовые голоса Gemini TTS.
 *
 * Список взят из репозитория примеров Google (`GoogleCloudPlatform/
 * generative-ai`, notebook `get_started_with_gemini_tts_voices`) —
 * тридцать голосов, одинаковых у `gemini-3.1-flash-tts-preview` и
 * предыдущих TTS-моделей. OpenRouter передаёт значение провайдеру как
 * есть, поэтому имена совпадают с гугловскими побуквенно.
 */
export const GEMINI_TTS_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede",
  "Autonoe", "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome",
  "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda",
  "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager",
  "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;

/**
 * Форматы ответа синтеза. Тот же закрытый список, что у media-service:
 * значение уходит провайдеру как есть, и произвольная строка вернулась
 * бы его четырёхсотой вместо понятной ошибки панели.
 */
export const TTS_RESPONSE_FORMATS = ["mp3", "wav", "pcm", "opus"] as const;

/** Текущая TTS-модель Gemini в каталоге OpenRouter. */
export const TTS_DEFAULT_MODEL = "google/gemini-3.1-flash-tts-preview";

/**
 * Что подставляет выбор провайдера синтеза.
 *
 * Формат ответа входит в набор наравне с адресом и моделью: Gemini TTS
 * через OpenRouter отвечает на mp3 четырёхсотой и принимает pcm —
 * проверено кругом до провайдера, а не выведено из документации. Без
 * этого значения новая установка повторяла бы ту же настройку вслепую.
 */
export const TTS_PROVIDER_PRESETS: Record<
  string,
  { base_url: string; model: string; response_format: string }
> = {
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    model: TTS_DEFAULT_MODEL,
    response_format: "pcm",
  },
  openai: {
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    response_format: "mp3",
  },
};

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
        "У OpenAI подставляет Base URL и модель; остальные варианты оставляют поля как есть", {
          kind: "select",
          options: [
            {
              value: "openai", title: "OpenAI Whisper",
              preset: { base_url: "https://api.openai.com/v1", model: "whisper-1" },
            },
            // У Deepgram набора нет намеренно: его адрес и имя модели не
            // проверены кругом до провайдера, а подставленное наугад
            // значение выглядит как проверенное.
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
    note: "OpenRouter принимает тот же OpenAI-совместимый /audio/speech, поэтому "
      + "смена провайдера — это Base URL, модель и голос, а не отдельный код.",
    fields: [
      setting("provider", "bootstrap.env.media.tts.provider", "Провайдер",
        "Подставляет Base URL, модель и формат ответа; «Свой» оставляет поля как есть", {
          kind: "select",
          options: [
            {
              value: "openrouter", title: "OpenRouter (Gemini TTS)",
              preset: TTS_PROVIDER_PRESETS.openrouter,
            },
            { value: "openai", title: "OpenAI TTS", preset: TTS_PROVIDER_PRESETS.openai },
            { value: "custom", title: "Свой endpoint" },
          ],
        }),
      setting("base_url", "bootstrap.env.media.tts.base.url", "Base URL",
        "Адрес OpenAI-совместимого API синтеза", {
          kind: "url", required: true, placeholder: "https://openrouter.ai/api/v1",
        }),
      secret("api_key", "sec_media_tts_api_key", "API Token",
        "Токен OpenRouter. Показывается только признак «настроен»"),
      setting("model", "bootstrap.env.media.tts.model", "Модель",
        "Идентификатор модели синтеза у провайдера", {
          placeholder: TTS_DEFAULT_MODEL,
        }),
      setting("voice", "bootstrap.env.media.tts.voice", "Голос",
        "Список голосов Gemini TTS; у другого провайдера впишите его собственный идентификатор", {
          kind: "select",
          options: GEMINI_TTS_VOICES.map((name) => ({ value: name, title: name })),
        }),
      setting("voice_prompt", "bootstrap.env.media.tts.voice.prompt", "Voice Prompt",
        "Характер голоса, манера речи, темп и интонация. Уходит провайдеру полем instructions", {
          kind: "textarea",
          placeholder: "Тёплый женский голос, спокойный темп, живая интонация без театральности",
        }),
      setting("response_format", "bootstrap.env.media.tts.response.format", "Формат аудио",
        "В чём провайдер отдаёт звук. Gemini TTS отдаёт PCM 24 кГц и mp3 принимает не всегда; "
        + "наружу Ева всё равно отдаёт голосовое сообщение OGG/Opus", {
          kind: "select",
          options: TTS_RESPONSE_FORMATS.map((value) => ({ value, title: value })),
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
  /** Успели ли значения доехать до сервиса без перезапуска. */
  applied_live?: boolean;
  apply_error?: string | null;
  last_check: {
    state: string;
    color: string;
    ok_at: string | null;
    checked_at: string | null;
    message: string | null;
  } | null;
}

/**
 * Поля панели → поля рантайм-конфига media-service. Без этой таблицы
 * пришлось бы полагаться на совпадение имён, а они намеренно разные:
 * в панели поле называется api_key, в сервисе — тоже, но base_url в
 * панели относится к секции, а в сервисе лежит внутри неё.
 */
const MEDIA_SECTIONS: Record<string, "asr" | "tts"> = { asr: "asr", tts: "tts" };

/**
 * Интеграции речи. Отдельный список не заводится: это те же ключи
 * MEDIA_SECTIONS, и разойтись им нельзя — маршрут записи спрашивает у
 * него, требовать ли подтверждение паролем.
 */
export const MEDIA_INTEGRATIONS: ReadonlySet<string> = new Set(Object.keys(MEDIA_SECTIONS));

export class IntegrationConfigService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly secrets: SecretStore,
    private readonly mediaUrl = process.env.EVA_MEDIA_SERVICE_URL ?? "http://media-service:8090",
  ) {}

  /**
   * Отправляет настройки ASR/TTS прямо в media-service.
   *
   * Это и есть «смена провайдера без правки workflow»: сервис
   * перечитывает значения на следующем же запросе, .env не трогается и
   * контейнер не пересоздаётся. Значения в system_settings всё равно
   * пишутся — они переживут пересоздание тома media-service и попадут в
   * backup.
   */
  /**
   * Общий секрет с media-service.
   *
   * Окружение первично, копия в Secret Store — запасной путь: её
   * создаёт bootstrap, а он выполняется один раз за жизнь установки.
   * Если MEDIA_SERVICE_TOKEN появился в .env позже, записи нет, и
   * обращения к media-service возвращали 401 при том, что переменная
   * лежала в процессе всё это время.
   */
  private async mediaToken(): Promise<string | null> {
    return (process.env.MEDIA_SERVICE_TOKEN ?? "").trim()
      || await this.secrets.get("sec_media_service_token");
  }

  private async pushToMedia(
    section: "asr" | "tts",
    values: Record<string, string>,
  ): Promise<{ applied: boolean; error?: string }> {
    if (Object.keys(values).length === 0) return { applied: false };
    const token = await this.mediaToken();
    if (!token) {
      return { applied: false, error: "MEDIA_SERVICE_TOKEN не задан" };
    }
    try {
      const response = await fetch(`${this.mediaUrl.replace(/\/+$/, "")}/config/media`, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-Media-Key": token },
        body: JSON.stringify({ [section]: values }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { applied: false, error: `media-service вернул HTTP ${response.status}` };
      }
      return { applied: true };
    } catch (error) {
      return {
        applied: false,
        error: error instanceof Error ? error.message : "media-service недоступен",
      };
    }
  }

  /** Запускает настоящую проверку синтеза или распознавания. */
  async test(id: string): Promise<Record<string, unknown>> {
    const section = MEDIA_SECTIONS[id];
    if (!section) throw adminBadRequest("Для этой интеграции нет отдельной проверки");
    const token = await this.mediaToken();
    if (!token) throw adminBadRequest("MEDIA_SERVICE_TOKEN не задан");

    try {
      const response = await fetch(`${this.mediaUrl.replace(/\/+$/, "")}/${section}/test`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Media-Key": token },
        body: "{}",
        // Синтез идёт к внешнему провайдеру, и при отказе media-service
        // перебирает сочетания формата и Voice Prompt — до восьми
        // запросов подряд. С прежней минутой ожидание обрывалось на
        // середине перебора, и вместо подсказки администратор получал
        // «media-service недоступен».
        signal: AbortSignal.timeout(180_000),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        // Вместе с сообщением отдаётся и ответ провайдера: «провайдер
        // вернул 400» без его объяснения администратору бесполезно —
        // менять по такому сообщению нечего.
        const error = body.error as { message?: string; details?: string } | undefined;
        const message = error?.message ?? `media-service вернул HTTP ${response.status}`;
        const details = (error?.details ?? "").trim();
        return { ok: false, message: details ? `${message}: ${details}` : message };
      }
      return { ok: true, ...body };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "media-service недоступен",
      };
    }
  }

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
      // Потребители берутся из каталога Secret Store. `undefined` здесь
      // означал бы отказ: `put` требует массив, и сохранение любой
      // интеграции с секретом падало с «used_by должен быть массивом
      // строк» — уже после коммита обычных настроек, то есть Base URL
      // и модель сохранялись, а токен нет.
      await this.secrets.put(ref, value, declaredUsedBy(ref), actorId);
    }

    const result = await this.get(id);
    const section = MEDIA_SECTIONS[id];
    if (section) {
      // Собираем то же, что сохранили, в терминах media-service.
      const payload: Record<string, string> = {};
      for (const field of form.fields) {
        if (!(field.name in body)) continue;
        const value = String(body[field.name] ?? "").trim();
        if (field.kind === "secret" && !value) continue;
        payload[field.name] = value;
      }
      const push = await this.pushToMedia(section, payload);
      return {
        ...result,
        applied_live: push.applied,
        apply_error: push.error ?? null,
      } as IntegrationConfig;
    }
    return result;
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
