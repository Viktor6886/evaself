/**
 * Админ-слой над реестром STT-провайдеров.
 *
 * Разделение обязанностей с media-service такое:
 *
 *   media-service (Python) — адаптеры, матрица возможностей, схемы форм,
 *   валидация параметров и сам вызов провайдера. Там же, где адаптеры,
 *   потому что две копии правды разъезжаются: адаптер выучил параметр, а
 *   панель о нём не знает.
 *
 *   admin-api (здесь) — CRUD конфигураций, RBAC, sudo, аудит, Secret
 *   Store, маршруты и телеметрия. Всё это уже существует в репозитории,
 *   и второй такой механизм задача прямо запрещает.
 *
 * Схемы провайдеров этот сервис проксирует из media-service, а не
 * описывает сам. Валидацию параметров — тоже: перед сохранением
 * конфигурация уходит на /stt/test?validate_only, и если адаптер её не
 * принял, запись не происходит.
 *
 * Секрет наружу не возвращается никогда — ни целиком, ни частично. В
 * ответе только признак «настроен», дата и отпечаток.
 */

import { createHash, randomBytes } from "node:crypto";

import type pg from "pg";

import {
  adminBadRequest,
  adminConflict,
  adminNotFound,
  AdminApiError,
} from "./errors.js";
import type { SecretStore } from "./secret-store.js";

export const STT_USE_CASES = ["telegram_voice", "webapp_voice_message", "webapp_live"] as const;
export type SttUseCase = (typeof STT_USE_CASES)[number];

export const STT_PROVIDERS = [
  "deepgram", "google_ai_studio", "openai", "google", "openrouter",
] as const;

/** Ключи, которые нельзя записать в public_config ни при каких условиях. */
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "api_key", "apikey", "secret", "secret_key", "secretkey",
  "private_key", "privatekey", "authorization", "access_token", "accesstoken",
  "refresh_token", "refreshtoken", "credentials", "service_account",
  "serviceaccount", "client_secret", "clientsecret",
]);

/** Максимум для загружаемого service account JSON. */
const MAX_CREDENTIALS_BYTES = 16 * 1024;

/**
 * Идентификаторы ключей приходят из media-service, то есть снаружи.
 * Строка, не похожая на uuid, не должна доезжать до запроса: приведение
 * к uuid отвалится, и вместе с ним — вся запись телеметрии.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SttConfigRow {
  id: string;
  name: string;
  provider: string;
  mode: string;
  base_url: string;
  model: string;
  public_config: Record<string, unknown>;
  secret_ref: string | null;
  status: string;
  config_version: number;
  last_tested_at: Date | null;
  last_test_ok: boolean | null;
  last_latency_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MediaSttClient {
  providerSchemas(): Promise<{ providers: unknown[] }>;
  validate(config: ResolvedForMedia): Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
  test(config: ResolvedForMedia, audioBase64?: string): Promise<Record<string, unknown>>;
  transcribe(useCase: string, audioBase64: string): Promise<Record<string, unknown>>;
  applySnapshot(snapshot: unknown): Promise<{ applied: boolean; errors?: string[] }>;
}

export interface ResolvedForMedia {
  id?: string;
  name: string;
  provider: string;
  mode: string;
  base_url: string;
  model: string;
  params: Record<string, unknown>;
  secret: string;
  /**
   * Все ключи провайдера в порядке перебора. media-service берёт
   * следующий, когда предыдущий отвергнут или упёрся в лимит.
   *
   * Поле необязательное: снимок должен применяться и той версией
   * media-service, которая знает только про одиночный secret.
   */
  keys?: Array<{ id: string; label: string; secret: string }>;
  timeout_ms?: number;
}

/**
 * HTTP-клиент media-service. Отдельный класс, чтобы тесты подставляли
 * свой и не поднимали настоящий сервис.
 */
export class HttpMediaSttClient implements MediaSttClient {
  constructor(
    private readonly secrets: SecretStore,
    private readonly baseUrl = process.env.EVA_MEDIA_SERVICE_URL ?? "http://media-service:8090",
  ) {}

  /**
   * Токен берётся из окружения, а копия в Secret Store — запасной путь.
   *
   * Панель отвечала HTTP 401 при работающих голосовых сообщениях, и
   * причин этому было две, обе про одно и то же значение.
   *
   * Первая: admin-api — отдельный контейнер, и MEDIA_SERVICE_TOKEN ему
   * не передавали вовсе. Распознавание же идёт через
   * eva-agent-service, которому переменную дают, — отсюда и расхождение
   * «голос работает, панель нет». Исправлено в compose.yaml.
   *
   * Вторая: единственным источником была копия в Secret Store, которую
   * кладёт bootstrap, а он выполняется один раз за жизнь установки.
   * Появился токен в .env позже — записи нет, заголовок не
   * отправляется, media-service справедливо отвечает 401.
   *
   * Порядок «окружение, потом хранилище» выбран так, чтобы правка .env
   * применялась перезапуском контейнера, а не требовала лезть в Secret
   * Store.
   */
  private async headers(): Promise<Record<string, string>> {
    const token = (process.env.MEDIA_SERVICE_TOKEN ?? "").trim()
      || await this.secrets.get("sec_media_service_token");
    return {
      "content-type": "application/json",
      ...(token ? { "x-media-key": token } : {}),
    };
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: init.method,
        headers: await this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new AdminApiError(
        "media_unavailable",
        `media-service недоступен: ${error instanceof Error ? error.message : "неизвестно"}`,
        503,
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const detail = (body.error as { message?: string } | undefined)?.message;
      throw new AdminApiError(
        "media_error",
        detail ?? `media-service вернул HTTP ${response.status}`,
        response.status >= 500 ? 502 : 400,
      );
    }
    return body;
  }

  async providerSchemas(): Promise<{ providers: unknown[] }> {
    const body = await this.call("/stt/provider-schemas", { method: "GET", timeoutMs: 15_000 });
    return { providers: Array.isArray(body.providers) ? body.providers : [] };
  }

  async validate(config: ResolvedForMedia) {
    const body = await this.call("/stt/test", {
      method: "POST",
      body: { config, validate_only: true },
      timeoutMs: 15_000,
    });
    const error = body.error as { message?: string } | undefined;
    return {
      ok: body.success === true,
      errors: error?.message ? [error.message] : [],
      warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
    };
  }

  async test(config: ResolvedForMedia, audioBase64?: string) {
    return await this.call("/stt/test", {
      method: "POST",
      body: { config, ...(audioBase64 ? { audio_base64: audioBase64 } : {}) },
      timeoutMs: 180_000,
    });
  }

  /**
   * Распознавание по сценарию — тем же путём, каким идёт Telegram.
   *
   * Отличается от test() принципиально: тот обращается к провайдеру
   * напрямую и про маршруты ничего не знает, поэтому его успех ничего
   * не говорит о том, заработают ли голосовые. Здесь же проверяется всё
   * разом — назначен ли провайдер сценарию, доехал ли снимок, работают
   * ли ключи.
   */
  async transcribe(useCase: string, audioBase64: string) {
    // media-service принимает аудио загрузкой, а не в JSON: там оно
    // может быть большим, и гонять его через base64 в теле запроса
    // между сервисами незачем.
    const bytes = Buffer.from(audioBase64, "base64");
    const form = new FormData();
    form.append("use_case", useCase);
    form.append("file", new Blob([bytes]), "probe.webm");

    const token = (process.env.MEDIA_SERVICE_TOKEN ?? "").trim()
      || await this.secrets.get("sec_media_service_token");
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl.replace(/\/+$/, "")}/stt/transcribe/upload`,
        {
          method: "POST",
          // content-type не задаём: его вместе с boundary проставит
          // fetch, а заданный руками ломает разбор multipart.
          headers: token ? { "x-media-key": token } : {},
          body: form,
          signal: AbortSignal.timeout(180_000),
        },
      );
    } catch (error) {
      throw new AdminApiError(
        "media_unavailable",
        `media-service недоступен: ${error instanceof Error ? error.message : "неизвестно"}`,
        503,
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const detail = body.error as { code?: string; message?: string } | undefined;
      // Ошибка сценария — это результат проверки, а не сбой запроса:
      // администратор пришёл сюда именно за причиной.
      return {
        success: false,
        error: {
          code: detail?.code ?? `http_${response.status}`,
          message: detail?.message ?? `media-service вернул HTTP ${response.status}`,
        },
      };
    }
    return { success: true, ...body };
  }

  async applySnapshot(snapshot: unknown) {
    const body = await this.call("/stt/runtime", { method: "PUT", body: snapshot });
    return {
      applied: body.applied === true,
      errors: Array.isArray(body.errors) ? (body.errors as string[]) : [],
    };
  }
}

export class SttAdminService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly secrets: SecretStore,
    private readonly media: MediaSttClient,
    /** Необязателен: тесты поднимают сервис без логгера. */
    private readonly logger?: { warn(message: string, meta?: unknown): void },
  ) {}

  // -------------------------------------------------------------------
  // схемы провайдеров
  // -------------------------------------------------------------------
  /**
   * Проксируется из media-service: источник истины там, где адаптеры.
   *
   * Ответ кэшируется, и при недоступности media-service отдаётся
   * последний известный. Без этого раздел панели превращается в
   * мёртвую страницу от одного перезапуска контейнера — а
   * конфигурации, ключи и маршруты лежат в PostgreSQL и доступны
   * независимо от того, отвечает media-service или нет.
   */
  private schemaCache: { providers: unknown[]; at: number } | null = null;

  async providerSchemas(): Promise<{ providers: unknown[]; stale?: boolean }> {
    try {
      const fresh = await this.media.providerSchemas();
      if (fresh.providers.length > 0) {
        this.schemaCache = { providers: fresh.providers, at: Date.now() };
      }
      return fresh;
    } catch (error) {
      if (this.schemaCache) {
        return { providers: this.schemaCache.providers, stale: true };
      }
      throw error;
    }
  }

  /**
   * Включение и выключение конфигурации.
   *
   * Выключенная остаётся на своём месте в маршруте, но распознавать ей
   * больше не поручают: снимать её с маршрута ради временной паузы —
   * значит потом собирать маршрут заново.
   */
  async setEnabled(id: string, enabled: boolean) {
    const row = await this.row(id);
    if (row.archived_at) throw adminBadRequest("Архивная конфигурация уже не работает");
    if (enabled && !row.secret_ref) throw adminBadRequest("Сначала задайте ключ");

    await this.pool.query(
      `UPDATE stt_provider_configs
          SET status = CASE WHEN $2 THEN 'draft' ELSE 'disabled' END,
              config_version = config_version + 1
        WHERE id = $1`,
      [id, enabled],
    );
    await this.pushSnapshot();
    return await this.get(id);
  }

  // -------------------------------------------------------------------
  // чтение
  // -------------------------------------------------------------------
  async list(includeArchived = false): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query<SttConfigRow & { used_by: string[] }>(
      `SELECT c.*,
              COALESCE(
                ARRAY(
                  SELECT rp.use_case FROM stt_route_providers rp
                   WHERE rp.config_id = c.id
                   ORDER BY rp.use_case
                ), '{}'
              ) AS used_by
         FROM stt_provider_configs c
        WHERE ($1::boolean OR c.archived_at IS NULL)
        ORDER BY c.archived_at NULLS FIRST, lower(c.name)`,
      [includeArchived],
    );
    return await Promise.all(rows.map((row) => this.present(row, row.used_by)));
  }

  async get(id: string): Promise<Record<string, unknown>> {
    const row = await this.row(id);
    const { rows } = await this.pool.query<{ use_case: string }>(
      `SELECT use_case FROM stt_route_providers
        WHERE config_id = $1
        ORDER BY use_case`,
      [id],
    );
    return await this.present(row, rows.map((item) => item.use_case));
  }

  private async row(id: string): Promise<SttConfigRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminBadRequest("Некорректный идентификатор");
    const { rows } = await this.pool.query<SttConfigRow>(
      "SELECT * FROM stt_provider_configs WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) throw adminNotFound("Конфигурация распознавания не найдена");
    return row;
  }

  /**
   * Представление для панели. Секрет здесь не появляется — только
   * признак «настроен», дата и отпечаток.
   *
   * Отпечаток считается от ссылки, а не от значения: хеш самого ключа
   * позволил бы подтвердить догадку о нём перебором, а различать две
   * конфигурации помогает и ссылка.
   */
  private async present(
    row: SttConfigRow,
    usedBy: string[] = [],
  ): Promise<Record<string, unknown>> {
    let secret: Record<string, unknown> = { configured: false };
    if (row.secret_ref) {
      const { rows } = await this.pool.query<{ last_rotated_at: Date }>(
        "SELECT last_rotated_at FROM secret_records WHERE secret_ref = $1 AND status = 'active'",
        [row.secret_ref],
      );
      secret = {
        configured: rows.length > 0,
        updated_at: rows[0]?.last_rotated_at ?? null,
        fingerprint: `sha256:${createHash("sha256").update(row.secret_ref).digest("hex").slice(0, 12)}`,
      };
    }

    // Сводка по ключам нужна карточке в списке: «3 ключа, 1 исчерпан»
    // читается с одного взгляда, а за подробностями пользователь идёт
    // в диалог ключей.
    const { rows: counts } = await this.pool.query<{
      total: number; usable: number; exhausted: number; invalid: number;
    }>(
      `SELECT count(*)::int                                                   AS total,
              count(*) FILTER (WHERE enabled AND status = 'active')::int      AS usable,
              count(*) FILTER (WHERE status = 'exhausted')::int               AS exhausted,
              count(*) FILTER (WHERE status = 'invalid')::int                 AS invalid
         FROM stt_provider_keys WHERE config_id = $1`,
      [row.id],
    );

    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      mode: row.mode,
      base_url: row.base_url,
      model: row.model,
      public_config: row.public_config ?? {},
      status: row.status,
      config_version: row.config_version,
      archived: row.archived_at !== null,
      used_by: usedBy,
      last_test: {
        at: row.last_tested_at,
        ok: row.last_test_ok,
        latency_ms: row.last_latency_ms,
        error_code: row.last_error_code,
        error_message: row.last_error_message,
      },
      secret,
      keys: counts[0] ?? { total: 0, usable: 0, exhausted: 0, invalid: 0 },
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // -------------------------------------------------------------------
  // запись
  // -------------------------------------------------------------------
  async create(body: Record<string, unknown>, actorId: string | null) {
    const draft = this.parse(body, null);
    // Ключ приходит write-only полем и в public_config не попадает
    // никогда — за этим следит ещё и ограничение в схеме.
    const secretValue = this.extractSecret(body, draft.provider);

    await this.assertAdapterAccepts(draft, secretValue ?? "");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<SttConfigRow>(
        `INSERT INTO stt_provider_configs
           (name, provider, mode, base_url, model, public_config, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          draft.name, draft.provider, draft.mode, draft.base_url, draft.model,
          JSON.stringify(draft.public_config), actorId,
        ],
      );
      const created = rows[0]!;

      if (secretValue) {
        const secretRef = await this.storeSecret(created.id, secretValue, actorId);
        await client.query(
          "UPDATE stt_provider_configs SET secret_ref = $2 WHERE id = $1",
          [created.id, secretRef],
        );
        await this.listPrimaryKey(client, created.id, secretRef, actorId);
        created.secret_ref = secretRef;
      }
      await client.query("COMMIT");
      return await this.present(created);
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }
  }

  async update(id: string, body: Record<string, unknown>, actorId: string | null) {
    const current = await this.row(id);
    if (current.archived_at) {
      throw adminBadRequest("Архивная конфигурация не редактируется — восстановите её");
    }

    // Оптимистическая блокировка: панель присылает версию, которую
    // показывала. Расхождение означает, что кто-то успел раньше.
    const expected = body.config_version;
    if (expected !== undefined && Number(expected) !== current.config_version) {
      throw adminConflict(
        `Конфигурация изменена другим администратором (версия ${current.config_version})`,
        { current_version: current.config_version },
      );
    }

    const draft = this.parse(body, current);
    const secretValue = this.extractSecret(body, draft.provider);

    // Пустое поле ключа при редактировании означает «оставить прежний»,
    // а не «стереть»: иначе каждое сохранение формы требовало бы заново
    // вводить ключ.
    const effectiveSecret = secretValue
      ?? (current.secret_ref ? await this.secrets.get(current.secret_ref) : null)
      ?? "";
    await this.assertAdapterAccepts(draft, effectiveSecret);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Снимок ДО изменения — то, к чему возвращает откат. Секрет в
      // снимок не попадает, только ссылка.
      await client.query(
        `INSERT INTO stt_config_versions (config_id, config_version, snapshot_json, created_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (config_id, config_version) DO NOTHING`,
        [id, current.config_version, JSON.stringify(this.snapshotOf(current)), actorId],
      );

      const { rows } = await client.query<SttConfigRow>(
        `UPDATE stt_provider_configs
            SET name = $2, mode = $3, base_url = $4, model = $5,
                public_config = $6::jsonb,
                config_version = config_version + 1,
                -- Правка параметров обесценивает прошлую проверку:
                -- «здоровой» конфигурация станет снова только после
                -- успешного теста.
                status = CASE WHEN status = 'healthy' THEN 'draft' ELSE status END,
                last_test_ok = NULL
          WHERE id = $1
         RETURNING *`,
        [
          id, draft.name, draft.mode, draft.base_url, draft.model,
          JSON.stringify(draft.public_config),
        ],
      );
      const updated = rows[0]!;

      if (secretValue) {
        const secretRef = await this.storeSecret(id, secretValue, actorId);
        await client.query(
          "UPDATE stt_provider_configs SET secret_ref = $2 WHERE id = $1",
          [id, secretRef],
        );
        await this.listPrimaryKey(client, id, secretRef, actorId);
        updated.secret_ref = secretRef;
      }
      await client.query("COMMIT");
      return await this.present(updated);
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------
  // Ключи провайдера
  // -------------------------------------------------------------------
  /**
   * Список ключей конфигурации. Значений здесь нет и быть не может —
   * только подписи, порядок, состояние и счётчики.
   */
  async listKeys(configId: string): Promise<Record<string, unknown>[]> {
    await this.row(configId);
    const { rows } = await this.pool.query(
      `SELECT k.id, k.label, k.position, k.enabled, k.status, k.cooldown_until,
              k.last_used_at, k.last_error_at, k.last_error_code,
              k.success_count, k.failure_count, k.created_at,
              s.last_rotated_at
         FROM stt_provider_keys k
         LEFT JOIN secret_records s ON s.secret_ref = k.secret_ref
        WHERE k.config_id = $1
        ORDER BY k.position, k.created_at`,
      [configId],
    );
    return rows;
  }

  /**
   * Расшифрованные ключи конфигурации в порядке перебора — то, что
   * уходит в снимок media-service.
   *
   * Выключенные пропускаются, помеченные exhausted — нет: срок
   * остывания отсчитывает media-service, он же вернёт ключ в оборот,
   * когда суточный лимит сбросится. Повторять этот отсчёт здесь значило
   * бы завести вторые часы, которые разойдутся с первыми.
   *
   * Ключ, чья запись в Secret Store исчезла, молча выпадает из списка:
   * пустое значение превратилось бы в запрос с пустым Authorization и
   * потратило бы попытку впустую.
   */
  private async resolveKeys(
    row: SttConfigRow,
  ): Promise<Array<{ id: string; label: string; secret: string }>> {
    const { rows } = await this.pool.query<{
      id: string; label: string; secret_ref: string; enabled: boolean;
    }>(
      `SELECT id, label, secret_ref, enabled
         FROM stt_provider_keys
        WHERE config_id = $1
        ORDER BY position, created_at`,
      [row.id],
    );

    const out: Array<{ id: string; label: string; secret: string }> = [];
    for (const key of rows) {
      if (!key.enabled) continue;
      const secret = await this.secrets.get(key.secret_ref);
      if (!secret) continue;
      out.push({ id: key.id, label: key.label, secret });
    }

    // Конфигурация, чей ключ ещё не попал в список — например, заведённая
    // старой версией панели, — иначе осталась бы без ключа вовсе.
    // Проверка идёт по всем строкам, включая выключенные: выключенный
    // администратором ключ не должен возвращаться через эту дверь.
    const listed = new Set(rows.map((key) => key.secret_ref));
    if (row.secret_ref && !listed.has(row.secret_ref)) {
      const legacy = await this.secrets.get(row.secret_ref);
      if (legacy) out.unshift({ id: `${row.id}:0`, label: "Основной", secret: legacy });
    }
    return out;
  }

  /**
   * Добавление ключа.
   *
   * Каждый ключ — отдельная запись в Secret Store. Хранить их списком в
   * одной записи нельзя: ротация одного ключа перезаписывала бы
   * остальные, а отозвать один из пяти стало бы невозможно.
   */
  async addKey(configId: string, body: Record<string, unknown>, actorId: string | null) {
    const config = await this.row(configId);
    if (config.archived_at) throw adminBadRequest("Архивной конфигурации ключи не нужны");

    const value = this.extractSecret(body, config.provider);
    if (!value) throw adminBadRequest("Не передано значение ключа");

    // Тот же ключ дважды — не резерв, а два одинаковых запроса и два
    // одинаковых отказа подряд. Уникальный индекс этого не ловит:
    // ссылки у записей разные, совпадают значения. Выключенные тоже
    // считаются: их включают обратно, и дубль всплыл бы тогда.
    const { rows: present } = await this.pool.query<{ label: string; secret_ref: string }>(
      "SELECT label, secret_ref FROM stt_provider_keys WHERE config_id = $1",
      [configId],
    );
    if (config.secret_ref) present.push({ label: "Основной", secret_ref: config.secret_ref });
    for (const key of present) {
      if (await this.secrets.get(key.secret_ref) === value) {
        throw adminBadRequest(`Такой ключ уже добавлен под названием «${key.label}»`);
      }
    }

    const { rows: existing } = await this.pool.query<{ n: number; next: number }>(
      `SELECT count(*)::int AS n, COALESCE(max(position), -1) + 10 AS next
         FROM stt_provider_keys WHERE config_id = $1`,
      [configId],
    );
    const count = existing[0]?.n ?? 0;
    if (count >= 20) throw adminBadRequest("Больше двадцати ключей на провайдера — это уже не резерв");

    const label = String(body.label ?? "").trim() || `Ключ ${count + 1}`;
    // Ссылка уникальна на ключ, а не на конфигурацию: иначе второй ключ
    // затёр бы первый.
    const secretRef = `sec_stt_${configId.replace(/-/g, "").slice(0, 12)}`
      + `_${randomBytes(4).toString("hex")}`;
    await this.secrets.put(secretRef, value, ["media-service"], actorId);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO stt_provider_keys (config_id, label, secret_ref, position, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [configId, label, secretRef, existing[0]?.next ?? 0, actorId],
      );
      // Первый ключ становится и ключом самой конфигурации: так она
      // считается настроенной, и старый однокючевой путь продолжает
      // работать.
      if (!config.secret_ref) {
        await client.query(
          "UPDATE stt_provider_configs SET secret_ref = $2 WHERE id = $1",
          [configId, secretRef],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }

    await this.pushSnapshot();
    return { keys: await this.listKeys(configId) };
  }

  /** Включение, выключение и переименование ключа. */
  async updateKey(configId: string, keyId: string, body: Record<string, unknown>) {
    await this.row(configId);
    const label = body.label === undefined ? null : String(body.label).trim();
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;

    try {
      const { rowCount } = await this.pool.query(
        `UPDATE stt_provider_keys
            SET label = COALESCE($3, label),
                enabled = COALESCE($4, enabled),
                -- Ручное включение снимает и автоматическую пометку:
                -- администратор мог заменить ключ у провайдера.
                status = CASE WHEN $4 IS TRUE THEN 'active' ELSE status END,
                cooldown_until = CASE WHEN $4 IS TRUE THEN NULL ELSE cooldown_until END
          WHERE id = $2 AND config_id = $1`,
        [configId, keyId, label || null, enabled],
      );
      if (!rowCount) throw adminNotFound("Ключ не найден");
    } catch (error) {
      throw this.friendly(error);
    }
    await this.pushSnapshot();
    return { keys: await this.listKeys(configId) };
  }

  /**
   * Удаление ключа.
   *
   * Запись в Secret Store тоже снимается: осиротевший секрет нельзя ни
   * использовать, ни найти, а в списке секретов он мозолит глаза.
   * Последний ключ удалить нельзя, если конфигурация активна: это
   * молча выключило бы распознавание.
   */
  async removeKey(configId: string, keyId: string) {
    const config = await this.row(configId);
    const { rows } = await this.pool.query<{ secret_ref: string; total: number }>(
      `SELECT k.secret_ref,
              (SELECT count(*)::int FROM stt_provider_keys WHERE config_id = $1) AS total
         FROM stt_provider_keys k
        WHERE k.id = $2 AND k.config_id = $1`,
      [configId, keyId],
    );
    const row = rows[0];
    if (!row) throw adminNotFound("Ключ не найден");

    const usedByRoute = await this.pool.query(
      `SELECT 1 FROM stt_route_providers WHERE config_id = $1`,
      [configId],
    );
    if (row.total <= 1 && (usedByRoute.rowCount ?? 0) > 0) {
      throw adminBadRequest(
        "Это последний ключ работающей конфигурации. Добавьте другой "
        + "или снимите её с маршрута.",
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM stt_provider_keys WHERE id = $1 AND config_id = $2",
        [keyId, configId]);
      if (config.secret_ref === row.secret_ref) {
        // Указатель конфигурации переезжает на следующий живой ключ.
        const { rows: next } = await client.query<{ secret_ref: string }>(
          `SELECT secret_ref FROM stt_provider_keys
            WHERE config_id = $1 ORDER BY position, created_at LIMIT 1`,
          [configId],
        );
        await client.query(
          "UPDATE stt_provider_configs SET secret_ref = $2 WHERE id = $1",
          [configId, next[0]?.secret_ref ?? null],
        );
      }
      await client.query("DELETE FROM secret_records WHERE secret_ref = $1", [row.secret_ref]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }

    await this.pushSnapshot();
    return { keys: await this.listKeys(configId) };
  }

  /** Отдельная write-only операция замены ключа. */
  async replaceSecret(id: string, body: Record<string, unknown>, actorId: string | null) {
    const current = await this.row(id);
    const value = this.extractSecret(body, current.provider);
    if (!value) throw adminBadRequest("Не передано новое значение ключа");

    const secretRef = await this.storeSecret(id, value, actorId);
    await this.pool.query(
      `UPDATE stt_provider_configs
          SET secret_ref = $2,
              config_version = config_version + 1,
              status = CASE WHEN status = 'unhealthy' THEN 'draft' ELSE status END,
              last_error_code = NULL, last_error_message = NULL
        WHERE id = $1`,
      [id, secretRef],
    );
    await this.listPrimaryKey(this.pool, id, secretRef, actorId);
    await this.pushSnapshot();
    return await this.get(id);
  }

  /**
   * Заводит ключ самой конфигурации в общем списке.
   *
   * Ключ можно задать двумя дверями — полем в редакторе и кнопкой
   * «Добавить ключ», — а список перебора должен быть один. Ссылка на
   * секрет конфигурации детерминирована (см. storeSecret), поэтому
   * повторный вызов ничего не дублирует: ON CONFLICT DO NOTHING
   * срабатывает и по ссылке, и по подписи.
   */
  private async listPrimaryKey(
    client: pg.PoolClient | pg.Pool,
    configId: string,
    secretRef: string,
    actorId: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO stt_provider_keys (config_id, label, secret_ref, position, created_by)
       VALUES ($1, 'Основной', $2, 0, $3)
       ON CONFLICT DO NOTHING`,
      [configId, secretRef, actorId],
    );
  }

  /**
   * Итог одной попытки конкретного ключа.
   *
   * Отсюда берётся то, что панель показывает про ключ: работает,
   * упёрся в лимит или отвергнут. Право решать при этом остаётся за
   * media-service — здесь только отражение его решения, потому что
   * ключ выбирает он.
   *
   * Ключ конфигурации, ещё не попавший в список, имеет
   * псевдоидентификатор «uuid:0». Строки под него нет, и запрос с ним
   * упал бы на приведении к uuid.
   */
  private async markKeyTested(
    keyId: string,
    ok: boolean,
    errorCode: string | null,
  ): Promise<void> {
    if (!UUID_RE.test(keyId)) return;
    // Лимит снимается сам — сутки у Deepgram и Google AI Studio,
    // минута у OpenAI, — поэтому ключ выключается на время, а не
    // насовсем. Отвергнутый ключ ждёт человека: сам он не починится.
    const cooldownMinutes = errorCode === "stt_rate_limited" ? 15 : null;
    const status = ok
      ? "active"
      : errorCode === "stt_rate_limited" ? "exhausted"
        : errorCode === "stt_auth_failed" ? "invalid"
          : null; // сеть или таймаут — ключ ни при чём
    await this.pool.query(
      `UPDATE stt_provider_keys
          SET status         = COALESCE($2, status),
              cooldown_until = CASE WHEN $3::int IS NULL THEN NULL
                                    ELSE now() + ($3 || ' minutes')::interval END,
              last_used_at   = now(),
              last_error_at  = CASE WHEN $4 THEN last_error_at ELSE now() END,
              last_error_code = CASE WHEN $4 THEN NULL ELSE $5 END,
              success_count  = success_count + CASE WHEN $4 THEN 1 ELSE 0 END,
              failure_count  = failure_count + CASE WHEN $4 THEN 0 ELSE 1 END
        WHERE id = $1`,
      [keyId, status, cooldownMinutes, ok, errorCode],
    );
  }

  // -------------------------------------------------------------------
  /**
   * Проверка конфигурации: прогоняются ВСЕ ключи, а не только первый.
   *
   * Иначе смысл списка теряется. Администратор вписал пять ключей,
   * проверка сказала «работает» — и через неделю, когда первый упрётся
   * в лимит, выясняется, что во втором опечатка. Проверять надо то, на
   * что рассчитываешь, а рассчитываешь на весь список.
   *
   * Конфигурация считается рабочей, если работает хотя бы один ключ:
   * ровно так же на неё смотрит маршрутизация.
   */
  async test(id: string, audioBase64?: string) {
    const row = await this.row(id);
    const keys = await this.resolveKeys(row);
    if (keys.length === 0) {
      return {
        success: false,
        error: { code: "stt_secret_missing", message: "У конфигурации нет ни одного ключа" },
        keys: [],
      };
    }

    const perKey: Array<Record<string, unknown>> = [];
    let best: Record<string, unknown> | null = null;
    for (const key of keys) {
      // Сорвавшийся вызов — это результат проверки этого ключа, а не
      // повод бросить остальные: администратор просил проверить все.
      let outcome: Record<string, unknown>;
      try {
        outcome = await this.media.test(
          {
            id: row.id,
            name: row.name,
            provider: row.provider,
            mode: row.mode,
            base_url: row.base_url,
            model: row.model,
            params: row.public_config ?? {},
            secret: key.secret,
          },
          audioBase64,
        );
      } catch (error) {
        outcome = {
          success: false,
          error: {
            code: "stt_provider_unavailable",
            message: error instanceof Error ? error.message : "media-service недоступен",
          },
        };
      }
      const keyOk = outcome.success === true;
      const keyError = outcome.error as { code?: string; message?: string } | undefined;
      perKey.push({
        id: key.id,
        label: key.label,
        success: keyOk,
        latency_ms: outcome.latency_ms ?? null,
        error_code: keyOk ? null : (keyError?.code ?? "stt_transcription_failed"),
        error_message: keyOk ? null : keyError?.message ?? null,
      });
      await this.markKeyTested(key.id, keyOk, keyOk ? null : keyError?.code ?? null);
      // Первый успех задаёт вердикт всей конфигурации, но перебор не
      // прерывает: администратор просил проверить ключи, все.
      if (best === null || (keyOk && best.success !== true)) best = outcome;
    }

    const result = { ...(best ?? {}), keys: perKey } as Record<string, unknown>;
    const ok = result.success === true;
    const error = result.error as { code?: string; message?: string } | undefined;
    await this.pool.query(
      `UPDATE stt_provider_configs
          SET last_tested_at = now(), last_test_ok = $2, last_latency_ms = $3,
              last_error_code = $4, last_error_message = $5,
              -- Успешный тест не активирует конфигурацию: активация —
              -- отдельное решение администратора под sudo.
              status = CASE
                         WHEN $2 THEN CASE WHEN status = 'draft' THEN 'draft' ELSE status END
                         ELSE 'unhealthy'
                       END
        WHERE id = $1`,
      [
        id, ok,
        typeof result.latency_ms === "number" ? result.latency_ms : null,
        ok ? null : (error?.code ?? "stt_transcription_failed"),
        ok ? null : (error?.message ?? "").slice(0, 500),
      ],
    );
    return result;
  }

  /**
   * Проверка сценария целиком — тем же путём, каким идёт Telegram.
   *
   * Именно этой проверки не хватало, когда «ключ введён, тест зелёный, а
   * голосовые не работают»: тест конфигурации обращается к провайдеру
   * напрямую и не проверяет ни назначение на сценарий, ни доставку
   * снимка. Здесь проверяется вся дорога.
   */
  async testRoute(useCase: string, audioBase64?: string): Promise<Record<string, unknown>> {
    this.assertUseCase(useCase);
    const routes = await this.routes();
    const route = routes.find((item) => item.use_case === useCase);
    const chain = (route?.chain as Array<{ name: string }> ?? []);

    // Две причины, которые видно, не спрашивая media-service. Сказать о
    // них сразу полезнее, чем получить тот же вывод через таймаут.
    if (!route?.enabled) {
      return {
        success: false,
        stage: "route",
        error: { code: "stt_route_disabled", message: "Сценарий выключен" },
      };
    }
    if (!chain.length) {
      return {
        success: false,
        stage: "route",
        error: {
          code: "stt_route_not_configured",
          message: "Для сценария не назначен ни один провайдер — нажмите «Активировать» "
            + "на нужной конфигурации",
        },
      };
    }
    if (!audioBase64) {
      return {
        success: false,
        stage: "audio",
        error: {
          code: "stt_audio_invalid",
          message: "Запишите голос: сценарий проверяется настоящим аудио, "
            + "встроенного сигнала для него нет",
        },
      };
    }

    const outcome = await this.media.transcribe(useCase, audioBase64);
    return { ...outcome, chain: chain.map((link) => link.name), snapshot: this.pushStatus() };
  }

  /**
   * Активация: конфигурация встаёт в цепочку сценария.
   *
   * «primary» — во главу, «fallback» — в хвост. Уже стоящая в цепочке
   * конфигурация переезжает, а не задваивается.
   *
   * Требование «активация допускается только после успешного теста»
   * выполняется буквально — сначала прогоняется проверка, и при её
   * провале цепочка не меняется.
   */
  async activate(id: string, useCase: string, slot: "primary" | "fallback", actorId: string | null) {
    const row = await this.row(id);
    if (row.archived_at) throw adminBadRequest("Архивную конфигурацию нельзя активировать");
    if (!row.secret_ref) throw adminBadRequest("У конфигурации не задан ключ");
    this.assertUseCase(useCase);

    const probe = await this.test(id);
    if (probe.success !== true) {
      const error = probe.error as { message?: string } | undefined;
      throw adminBadRequest(
        `Активация отменена: проверка не прошла — ${error?.message ?? "провайдер не ответил"}`,
      );
    }

    const { rows: current } = await this.pool.query<{ config_id: string }>(
      "SELECT config_id FROM stt_route_providers WHERE use_case = $1 ORDER BY position",
      [useCase],
    );
    const chain = current.map((link) => link.config_id).filter((link) => link !== id);
    if (slot === "primary") chain.unshift(id);
    else chain.push(id);

    if (chain.length > SttAdminService.MAX_CHAIN) {
      throw adminBadRequest(
        `В цепочке уже ${SttAdminService.MAX_CHAIN} провайдеров — сначала уберите лишнего`,
      );
    }

    await this.writeChain(useCase, chain, actorId);
    await this.pool.query(
      "UPDATE stt_provider_configs SET status = 'healthy' WHERE id = $1",
      [id],
    );
    await this.pushSnapshot();
    return await this.routes();
  }

  /**
   * Перезапись цепочки целиком.
   *
   * Удалить и вставить заново, а не двигать по одной: позиции
   * сдвигаются группой, и промежуточное состояние нарушило бы
   * уникальность (use_case, position).
   */
  private async writeChain(
    useCase: string, chain: string[], actorId: string | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM stt_route_providers WHERE use_case = $1", [useCase]);
      for (const [position, configId] of chain.entries()) {
        await client.query(
          `INSERT INTO stt_route_providers (use_case, config_id, position, created_by)
           VALUES ($1, $2, $3, $4)`,
          [useCase, configId, position, actorId],
        );
      }
      await client.query(
        `UPDATE stt_routes
            SET config_version = config_version + 1, updated_by = $2
          WHERE use_case = $1`,
        [useCase, actorId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }
  }

  /**
   * Откат к предыдущей версии конфигурации.
   *
   * Возвращаются параметры, но не ключ: ключ живёт в Secret Store и
   * версионируется отдельно — вернуть «прежний ключ» после ротации
   * невозможно и не нужно.
   */
  async rollback(id: string, actorId: string | null) {
    const current = await this.row(id);
    const { rows } = await this.pool.query<{ config_version: number; snapshot_json: Record<string, unknown> }>(
      `SELECT config_version, snapshot_json FROM stt_config_versions
        WHERE config_id = $1 AND config_version < $2
        ORDER BY config_version DESC LIMIT 1`,
      [id, current.config_version],
    );
    const previous = rows[0];
    if (!previous) throw adminNotFound("Предыдущей версии этой конфигурации нет");

    const snapshot = previous.snapshot_json;
    await this.pool.query(
      `INSERT INTO stt_config_versions (config_id, config_version, snapshot_json, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (config_id, config_version) DO NOTHING`,
      [id, current.config_version, JSON.stringify(this.snapshotOf(current)), actorId],
    );
    await this.pool.query(
      `UPDATE stt_provider_configs
          SET name = $2, mode = $3, base_url = $4, model = $5, public_config = $6::jsonb,
              config_version = config_version + 1, status = 'draft', last_test_ok = NULL
        WHERE id = $1`,
      [
        id,
        String(snapshot.name ?? current.name),
        String(snapshot.mode ?? current.mode),
        String(snapshot.base_url ?? current.base_url),
        String(snapshot.model ?? current.model),
        JSON.stringify(snapshot.public_config ?? {}),
      ],
    );
    await this.pushSnapshot();
    return await this.get(id);
  }

  /**
   * Архивирование вместо удаления.
   *
   * Физического DELETE нет вовсе: конфигурация связана с телеметрией, и
   * удаление стёрло бы историю расходов. Занятую маршрутом
   * конфигурацию архивировать нельзя — сначала снимите её с маршрута.
   */
  async archive(id: string) {
    const row = await this.row(id);
    if (row.archived_at) return await this.get(id);

    const { rows } = await this.pool.query<{ use_case: string; slot: string }>(
      `SELECT use_case,
              CASE WHEN position = 0 THEN 'основной'
                   ELSE 'резерв ' || position END AS slot
         FROM stt_route_providers
        WHERE config_id = $1`,
      [id],
    );
    if (rows.length > 0) {
      const where = rows.map((item) => `${item.use_case} (${item.slot})`).join(", ");
      throw adminBadRequest(
        `Конфигурация используется маршрутами: ${where}. Сначала назначьте другую.`,
      );
    }

    await this.pool.query(
      `UPDATE stt_provider_configs
          SET archived_at = now(), status = 'archived', config_version = config_version + 1
        WHERE id = $1`,
      [id],
    );
    return await this.get(id);
  }

  async restore(id: string) {
    const row = await this.row(id);
    if (!row.archived_at) return await this.get(id);
    try {
      await this.pool.query(
        `UPDATE stt_provider_configs
            SET archived_at = NULL, status = 'draft', config_version = config_version + 1
          WHERE id = $1`,
        [id],
      );
    } catch (error) {
      throw this.friendly(error);
    }
    return await this.get(id);
  }

  // -------------------------------------------------------------------
  // маршруты
  // -------------------------------------------------------------------
  /** Предел длины цепочки. Взят у LLM Router, чтобы правило было одно. */
  static readonly MAX_CHAIN = 6;

  async routes(): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `SELECT r.use_case, r.enabled, r.rotation_enabled, r.timeout_ms,
              r.max_audio_seconds, r.config_version, r.updated_at,
              COALESCE(
                (SELECT jsonb_agg(link ORDER BY link->>'position')
                   FROM (
                     SELECT jsonb_build_object(
                              'position',  rp.position,
                              'config_id', rp.config_id,
                              'name',      c.name,
                              'provider',  c.provider,
                              'model',     c.model,
                              'status',    c.status,
                              'archived',  c.archived_at IS NOT NULL
                            ) AS link
                       FROM stt_route_providers rp
                       JOIN stt_provider_configs c ON c.id = rp.config_id
                      WHERE rp.use_case = r.use_case
                   ) AS links),
                '[]'::jsonb
              ) AS chain
         FROM stt_routes r
        ORDER BY r.use_case`,
    );
    return rows;
  }

  /**
   * Настройки сценария: цепочка, ротация, таймауты.
   *
   * Цепочка приходит целиком списком идентификаторов, а не частями:
   * «поставить вторым» и «убрать третьего» — это про позиции, и
   * пересчитывать их на сервере по частичным правкам значит спорить с
   * панелью о том, как выглядит результат.
   */
  async updateRoute(useCase: string, body: Record<string, unknown>, actorId: string | null) {
    this.assertUseCase(useCase);

    let chain: string[] | null = null;
    if (body.chain !== undefined) {
      if (!Array.isArray(body.chain)) throw adminBadRequest("chain должен быть списком");
      chain = body.chain.map((item, index) =>
        this.optionalUuid(item, `chain[${index}]`) ?? "");
      if (chain.some((id) => !id)) throw adminBadRequest("В цепочке пустая позиция");
      if (chain.length > SttAdminService.MAX_CHAIN) {
        throw adminBadRequest(
          `Не больше ${SttAdminService.MAX_CHAIN} провайдеров в цепочке: дальше это `
          + "уже не отказоустойчивость, а способ незаметно потратить деньги",
        );
      }
      if (new Set(chain).size !== chain.length) {
        throw adminBadRequest(
          "Один провайдер дважды в цепочке — это не резерв, а второй такой же "
          + "отказ за вторые деньги",
        );
      }
      for (const id of chain) {
        const row = await this.row(id);
        if (row.archived_at) {
          throw adminBadRequest(`Архивная конфигурация «${row.name}» не может быть в цепочке`);
        }
        if (!row.secret_ref) throw adminBadRequest(`У конфигурации «${row.name}» не задан ключ`);
      }
    }

    const timeout = this.optionalInt(body.timeout_ms, "timeout_ms", 5_000, 600_000);
    const maxAudio = this.optionalInt(body.max_audio_seconds, "max_audio_seconds", 1, 7_200);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE stt_routes
            SET enabled = COALESCE($2, enabled),
                rotation_enabled = COALESCE($3, rotation_enabled),
                timeout_ms = COALESCE($4, timeout_ms),
                max_audio_seconds = COALESCE($5, max_audio_seconds),
                config_version = config_version + 1,
                updated_by = $6
          WHERE use_case = $1`,
        [
          useCase,
          typeof body.enabled === "boolean" ? body.enabled : null,
          typeof body.rotation_enabled === "boolean" ? body.rotation_enabled : null,
          timeout, maxAudio, actorId,
        ],
      );
      if (!rowCount) throw adminNotFound("Сценарий не найден");

      if (chain !== null) {
        // Удалить и записать заново, а не сверять по одной: позиции
        // сдвигаются целиком, и промежуточное состояние нарушило бы
        // уникальность (use_case, position).
        await client.query("DELETE FROM stt_route_providers WHERE use_case = $1", [useCase]);
        for (const [position, configId] of chain.entries()) {
          await client.query(
            `INSERT INTO stt_route_providers (use_case, config_id, position, created_by)
             VALUES ($1, $2, $3, $4)`,
            [useCase, configId, position, actorId],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }

    // Немедленная инвалидизация: следующий же запрос распознавания
    // пойдёт по новому маршруту, перезапуск контейнеров не нужен.
    await this.pushSnapshot();
    return await this.routes();
  }

  // -------------------------------------------------------------------
  // снимок для media-service
  // -------------------------------------------------------------------
  /**
   * Собирает конфигурации вместе с расшифрованными ключами и отправляет
   * их в media-service.
   *
   * Почему push, а не доступ media-service к базе: у него нет ни
   * подключения к PostgreSQL, ни мастер-ключа Secret Store, и давать их
   * сервису, который принимает файлы извне, — расширять поверхность
   * атаки ради удобства. Тот же приём уже используется для настроек
   * ASR/TTS через PUT /config/media.
   */
  async pushSnapshot(): Promise<{ applied: boolean; errors: string[] }> {
    const { rows } = await this.pool.query<SttConfigRow>(
      `SELECT DISTINCT c.*
         FROM stt_provider_configs c
         JOIN stt_route_providers rp ON rp.config_id = c.id
        WHERE c.archived_at IS NULL`,
    );

    const configs: ResolvedForMedia[] = [];
    for (const row of rows) {
      const keys = await this.resolveKeys(row);
      // Без единого ключа конфигурация нерабочая: отправлять её в
      // снимок значит получить отказ на первом же аудио.
      if (keys.length === 0) continue;
      configs.push({
        id: row.id,
        name: row.name,
        provider: row.provider,
        mode: row.mode,
        base_url: row.base_url,
        model: row.model,
        params: row.public_config ?? {},
        // Первый ключ дублируется в secret: так снимок понимает и та
        // версия media-service, которая про список ещё не знает.
        secret: keys[0]!.secret,
        keys,
      });
    }

    const known = new Set(configs.map((item) => item.id));
    const routeRows = await this.routes();
    const routes = routeRows
      .map((route) => ({
        use_case: route.use_case,
        // Ссылки на конфигурации без ключей выбрасываются, а не
        // обнуляют маршрут: снимок с висящей ссылкой media-service
        // отвергнет целиком, и один недонастроенный резерв положил бы
        // распознавание вместе с рабочим основным.
        chain: (route.chain as Array<{ config_id: string }> ?? [])
          .map((link) => link.config_id)
          .filter((id) => known.has(id)),
        enabled: route.enabled,
        rotation_enabled: route.rotation_enabled,
        timeout_ms: route.timeout_ms,
        max_audio_seconds: route.max_audio_seconds,
        config_version: route.config_version,
      }));

    // Версия снимка — сумма версий маршрутов: монотонно растёт при
    // любом изменении и не требует отдельного счётчика.
    const version = routeRows.reduce((sum, route) => sum + Number(route.config_version ?? 0), 0);
    try {
      const result = await this.media.applySnapshot({ version, configs, routes });
      this.lastPushError = result.applied ? null : (result.errors ?? []).join("; ");
      return { applied: result.applied, errors: result.errors ?? [] };
    } catch (error) {
      // Недоступный media-service не должен превращать уже сделанную
      // правку в ошибку.
      //
      // Раньше исключение отсюда поднималось наружу через removeKey,
      // addKey, activate и updateRoute — то есть через каждую мутацию
      // раздела. Ключ при этом удалялся: транзакция уже была
      // зафиксирована. Но запрос возвращал ошибку, панель не обновляла
      // список, и со стороны это выглядело как «ключ не удаляется».
      // Одна недоступная зависимость ломала весь раздел.
      //
      // Правка в базе — свершившийся факт. Разослать снимок — отдельное
      // дело, которое можно повторить: это делает следующая успешная
      // мутация, перезапуск admin-api или фоновая попытка ниже.
      const message = error instanceof Error ? error.message : "media-service недоступен";
      this.lastPushError = message;
      this.logger?.warn("Снимок STT не доставлен в media-service", { detail: message });
      return { applied: false, errors: [message] };
    }
  }

  /**
   * Последняя причина, по которой снимок не доехал.
   *
   * Панель показывает это отдельной строкой: «сохранено, но пока не
   * применено» — честнее, чем молчание, и полезнее, чем красная ошибка
   * поверх успешного действия.
   */
  private lastPushError: string | null = null;

  pushStatus(): { delivered: boolean; error: string | null } {
    return { delivered: this.lastPushError === null, error: this.lastPushError };
  }

  // -------------------------------------------------------------------
  // телеметрия
  // -------------------------------------------------------------------
  async usage(days: number): Promise<Record<string, unknown>> {
    const bounded = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const { rows: allTime } = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE attempt_index = 1) AS requests,
         COALESCE(sum(audio_seconds) FILTER (WHERE attempt_index = 1), 0) AS audio_seconds
       FROM stt_usage_events`,
    );
    const { rows: totals } = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE attempt_index = 1)                    AS requests,
         count(*)                                                     AS attempts,
         count(*) FILTER (WHERE is_fallback)                          AS fallbacks,
         count(*) FILTER (WHERE outcome = 'success')                  AS successes,
         count(*) FILTER (WHERE outcome = 'failure')                  AS failures,
         COALESCE(sum(audio_seconds) FILTER (WHERE attempt_index = 1), 0) AS audio_seconds,
         COALESCE(sum(estimated_cost_minor), 0)                       AS cost_minor,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)      AS p50_latency_ms,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)     AS p95_latency_ms
       FROM stt_usage_events
       WHERE at > now() - ($1 || ' days')::interval`,
      [bounded],
    );
    const { rows: last24 } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE attempt_index = 1) AS requests,
              count(*) FILTER (WHERE outcome = 'failure') AS failures
         FROM stt_usage_events WHERE at > now() - interval '24 hours'`,
    );
    const { rows: byProvider } = await this.pool.query(
      `SELECT provider, model,
              count(*) FILTER (WHERE attempt_index = 1) AS requests,
              count(*) FILTER (WHERE outcome = 'success') AS successes,
              COALESCE(sum(audio_seconds), 0) AS audio_seconds,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
         FROM stt_usage_events
        WHERE at > now() - ($1 || ' days')::interval
        GROUP BY provider, model
        ORDER BY requests DESC`,
      [bounded],
    );
    const { rows: errors } = await this.pool.query(
      `SELECT at, use_case, provider, model, error_code, is_fallback
         FROM stt_usage_events
        WHERE outcome = 'failure'
        ORDER BY at DESC LIMIT 20`,
    );
    return {
      period_days: bounded,
      all_time: allTime[0] ?? {},
      totals: totals[0] ?? {},
      last_24h: last24[0] ?? {},
      by_provider: byProvider,
      recent_errors: errors,
    };
  }

  /**
   * Запись телеметрии по итогам распознавания.
   *
   * Вызывается eva-agent-service после ответа media-service: у
   * media-service нет доступа к базе, а считать расход должен тот, кто
   * видит и попытки, и пользователя.
   */
  async recordUsage(input: {
    useCase: string;
    attempts: Array<{
      config_id?: string | null;
      provider: string;
      model: string;
      ok: boolean;
      latency_ms: number;
      is_fallback?: boolean;
      error_code?: string | null;
      key_id?: string | null;
      key_label?: string | null;
      keys_tried?: number;
      key_failures?: Array<{ key_id?: string | null; error_code?: string | null }>;
    }>;
    audioSeconds: number;
    idempotencyKey?: string | null;
  }): Promise<void> {
    if (!input.attempts.length) return;
    for (const [index, attempt] of input.attempts.entries()) {
      await this.pool.query(
        `INSERT INTO stt_usage_events
           (use_case, config_id, provider, model, outcome, attempt_index, is_fallback,
            audio_seconds, latency_ms, error_code, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.useCase,
          attempt.config_id ?? null,
          attempt.provider,
          attempt.model,
          attempt.ok ? "success" : "failure",
          Math.min(index + 1, SttAdminService.MAX_CHAIN),
          attempt.is_fallback ?? false,
          // Секунды пишутся только на первой попытке: одно голосовое
          // сообщение — одна длительность, сколько бы провайдеров её ни
          // обрабатывало.
          index === 0 ? input.audioSeconds : 0,
          attempt.latency_ms,
          attempt.error_code ?? null,
          input.idempotencyKey ?? null,
        ],
      );

      // Ключи, отвергнутые по дороге, помечаются каждый своей причиной,
      // а тот, которым попытка закончилась, — её итогом. Без этого
      // панель показывала бы «активен» ключу, который media-service
      // молча обходит уже неделю.
      for (const failure of attempt.key_failures ?? []) {
        if (failure.key_id) {
          await this.markKeyTested(failure.key_id, false, failure.error_code ?? null);
        }
      }
      if (attempt.key_id) {
        await this.markKeyTested(attempt.key_id, attempt.ok, attempt.error_code ?? null);
      }
    }
  }

  /**
   * Перенос действующих настроек MEDIA_ASR_* в реестр.
   *
   * Требование 12: обновление через `make update` не должно ломать
   * голосовые сообщения. До этого релиза распознавание настраивалось
   * переменными окружения; после — реестром, но установка, где реестр
   * ещё пуст, обязана продолжить работать.
   *
   * Импорт идемпотентен и делает ровно одну вещь: если конфигураций нет
   * вовсе, создаёт migrated-default из окружения и назначает её
   * основной для telegram_voice. Уже созданные конфигурации не
   * трогаются никогда — иначе перезапуск сервиса откатывал бы правки
   * администратора.
   *
   * Переменные не удаляются в этом же релизе: media-service продолжает
   * распознавать по ним, если маршрут не настроен. Срок удаления —
   * в docs/stt.md.
   */
  async importLegacyEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ imported: boolean; reason: string }> {
    const { rows } = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stt_provider_configs",
    );
    if ((rows[0]?.n ?? 0) > 0) {
      return { imported: false, reason: "реестр уже заполнен" };
    }

    const baseUrl = (env.MEDIA_ASR_BASE_URL ?? "").trim().replace(/\/+$/, "");
    const apiKey = (env.MEDIA_ASR_API_KEY ?? "").trim();
    const model = (env.MEDIA_ASR_MODEL ?? "whisper-1").trim();
    const language = (env.MEDIA_ASR_LANGUAGE ?? "").trim();
    if (!baseUrl || !apiKey) {
      return { imported: false, reason: "MEDIA_ASR_* не настроены" };
    }

    // Старый путь был жёстко OpenAI-совместимым, поэтому провайдер
    // определяется по адресу: openrouter.ai — это OpenRouter, всё
    // остальное совместимо с OpenAI.
    const provider = /(^|\.)openrouter\.ai$/i.test(new URL(baseUrl).hostname)
      ? "openrouter"
      : "openai";

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query<{ id: string }>(
        `INSERT INTO stt_provider_configs
           (name, provider, mode, base_url, model, public_config, status)
         VALUES ('migrated-default', $1, 'batch', $2, $3, $4::jsonb, 'draft')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [provider, baseUrl, model, JSON.stringify(language ? { language } : {})],
      );
      const id = created.rows[0]?.id;
      if (!id) {
        await client.query("ROLLBACK");
        return { imported: false, reason: "конфигурация уже существует" };
      }

      const secretRef = await this.storeSecret(id, apiKey, null);
      await client.query(
        "UPDATE stt_provider_configs SET secret_ref = $2 WHERE id = $1",
        [id, secretRef],
      );
      // Во главу цепочки — но только если она пуста: перенос из
      // окружения не должен подвинуть провайдера, назначенного руками.
      await client.query(
        `INSERT INTO stt_route_providers (use_case, config_id, position)
         SELECT 'telegram_voice', $1, 0
          WHERE NOT EXISTS (
                SELECT 1 FROM stt_route_providers WHERE use_case = 'telegram_voice')`,
        [id],
      );
      await client.query(
        `UPDATE stt_routes SET config_version = config_version + 1
          WHERE use_case = 'telegram_voice'`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.friendly(error);
    } finally {
      client.release();
    }

    await this.pushSnapshot();
    return { imported: true, reason: `перенесена конфигурация ${provider}` };
  }

  async health(): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS count
         FROM stt_provider_configs WHERE archived_at IS NULL GROUP BY status`,
    );
    const routes = await this.routes();
    return {
      configs_by_status: Object.fromEntries(rows.map((row) => [row.status, row.count])),
      routes_configured: routes.filter(
        (route) => (route.chain as unknown[] ?? []).length > 0).length,
      routes_total: routes.length,
      routes,
      // Доехал ли снимок до media-service. Правки в базе применяются
      // независимо от этого, а вот распознавание пойдёт по новым
      // настройкам только после доставки — и администратор должен
      // видеть разницу, а не гадать.
      snapshot: this.pushStatus(),
    };
  }

  // -------------------------------------------------------------------
  // разбор и проверка входа
  // -------------------------------------------------------------------
  private parse(body: Record<string, unknown>, current: SttConfigRow | null) {
    const name = String(body.name ?? current?.name ?? "").trim();
    if (name.length < 1 || name.length > 120) {
      throw adminBadRequest("Название должно быть от 1 до 120 символов");
    }

    const provider = String(body.provider ?? current?.provider ?? "").trim();
    if (!STT_PROVIDERS.includes(provider as (typeof STT_PROVIDERS)[number])) {
      throw adminBadRequest(`Неизвестный провайдер «${provider}»`);
    }
    // Смена провайдера у существующей конфигурации сделала бы её
    // параметры бессмысленными: у Deepgram и Google нет ни одного
    // общего поля.
    if (current && provider !== current.provider) {
      throw adminBadRequest("Провайдера существующей конфигурации менять нельзя — создайте новую");
    }

    const mode = String(body.mode ?? current?.mode ?? "batch").trim();
    if (mode !== "batch" && mode !== "streaming") {
      throw adminBadRequest("Режим должен быть batch или streaming");
    }

    const model = String(body.model ?? current?.model ?? "").trim();
    if (!model || model.length > 200) throw adminBadRequest("Не задана модель");

    const baseUrl = String(body.base_url ?? current?.base_url ?? "").trim();
    this.assertBaseUrl(baseUrl, body.allow_private_endpoint === true);

    const raw = body.public_config ?? current?.public_config ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw adminBadRequest("public_config должен быть объектом");
    }
    const publicConfig = raw as Record<string, unknown>;
    for (const key of Object.keys(publicConfig)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) {
        throw adminBadRequest(
          `Поле «${key}» не может храниться в открытых параметрах — используйте Secret Store`,
        );
      }
    }

    return { name, provider, mode, base_url: baseUrl, model, public_config: publicConfig };
  }

  /**
   * Первая линия защиты от SSRF. Вторая, по фактическому IP после
   * резолва и редиректов, живёт в media-service — только он реально
   * открывает соединение.
   */
  private assertBaseUrl(value: string, allowPrivate: boolean): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw adminBadRequest("Base URL не разбирается как адрес");
    }
    if (url.protocol !== "https:" && url.protocol !== "wss:") {
      throw adminBadRequest("Разрешены только https:// и wss://");
    }
    if (url.username || url.password) {
      throw adminBadRequest("Учётные данные в адресе не допускаются");
    }
    const host = url.hostname.toLowerCase();
    const isLoopback =
      host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);
    if (isLoopback) {
      throw adminBadRequest("Адрес указывает на сам сервис — это не внешний провайдер");
    }
    const isPrivate =
      /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || host.endsWith(".local") || host.endsWith(".internal");
    if (isPrivate && !allowPrivate) {
      throw adminBadRequest(
        "Адрес ведёт во внутреннюю сеть. Для self-hosted endpoint включите " +
        "отдельное разрешение — операция требует подтверждения паролем",
      );
    }
  }

  /**
   * Достаёт секрет из write-only поля.
   *
   * Для Google это загруженный service account JSON: он проверяется,
   * из него берутся безопасные метаданные, а целиком он уходит в Secret
   * Store. Путь к файлу не сохраняется нигде.
   */
  private extractSecret(body: Record<string, unknown>, provider: string): string | null {
    if (provider === "google") {
      const raw = body.credentials_json;
      if (raw === undefined || raw === null || raw === "") return null;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIALS_BYTES) {
        throw adminBadRequest("Файл учётных данных слишком велик — ожидается service account JSON");
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw adminBadRequest("Файл не разбирается как JSON");
      }
      for (const field of ["type", "project_id", "private_key", "client_email", "token_uri"]) {
        if (!parsed[field]) {
          throw adminBadRequest(`В service account JSON нет обязательного поля «${field}»`);
        }
      }
      if (parsed.type !== "service_account") {
        throw adminBadRequest("Ожидается ключ сервисного аккаунта (type: service_account)");
      }
      return JSON.stringify(parsed);
    }

    const value = body.api_key;
    if (value === undefined || value === null || value === "") return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > 4096) throw adminBadRequest("Ключ подозрительно длинный");
    return text;
  }

  private async storeSecret(configId: string, value: string, actorId: string | null): Promise<string> {
    // Конвенция sec_stt_<hex>: ограничение Secret Store — ^sec_[a-z0-9_]+$,
    // дефисы UUID туда не проходят.
    const suffix = configId.replace(/-/g, "").slice(0, 16) || randomBytes(8).toString("hex");
    const secretRef = `sec_stt_${suffix}`;
    await this.secrets.put(secretRef, value, ["media-service"], actorId);
    return secretRef;
  }

  /**
   * Спрашивает адаптер, принимает ли он такие параметры.
   *
   * Валидация живёт в media-service — там, где адаптеры. Дублировать её
   * здесь значило бы завести вторую копию правды, которая разъедется с
   * первой при первом же новом параметре.
   */
  private async assertAdapterAccepts(
    draft: { name: string; provider: string; mode: string; base_url: string; model: string; public_config: Record<string, unknown> },
    secret: string,
  ): Promise<void> {
    const verdict = await this.media.validate({
      name: draft.name,
      provider: draft.provider,
      mode: draft.mode,
      base_url: draft.base_url,
      model: draft.model,
      params: draft.public_config,
      secret,
    });
    if (!verdict.ok) {
      throw adminBadRequest(
        verdict.errors.join("; ") || "Адаптер отклонил параметры конфигурации",
      );
    }
  }

  private assertUseCase(useCase: string): void {
    if (!STT_USE_CASES.includes(useCase as SttUseCase)) {
      throw adminBadRequest(`Неизвестный сценарий «${useCase}»`);
    }
  }

  private optionalUuid(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value);
    if (!/^[0-9a-f-]{36}$/i.test(text)) throw adminBadRequest(`Некорректный ${field}`);
    return text;
  }

  private optionalInt(value: unknown, field: string, min: number, max: number): number | null {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw adminBadRequest(`${field} должен быть числом от ${min} до ${max}`);
    }
    return Math.trunc(number);
  }

  private snapshotOf(row: SttConfigRow): Record<string, unknown> {
    return {
      name: row.name,
      provider: row.provider,
      mode: row.mode,
      base_url: row.base_url,
      model: row.model,
      public_config: row.public_config ?? {},
      // Только ссылка. Значение остаётся в Secret Store, и снимок
      // конфигурации не должен позволять его восстановить.
      secret_ref: row.secret_ref,
      status: row.status,
    };
  }

  /** Ограничения базы → понятные сообщения вместо текста PostgreSQL. */
  private friendly(error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("stt_configs_name_uidx")) {
      return adminBadRequest("Конфигурация с таким названием уже есть");
    }
    if (message.includes("stt_route_providers_position_uidx")) {
      return adminBadRequest("Две конфигурации не могут занимать одну позицию в цепочке");
    }
    if (message.includes("stt_route_providers_pkey")) {
      return adminBadRequest("Один провайдер дважды в цепочке — это не резерв");
    }
    if (message.includes("stt_route_providers_position_check")) {
      return adminBadRequest(
        `Не больше ${SttAdminService.MAX_CHAIN} провайдеров в цепочке`);
    }
    if (message.includes("stt_configs_public_config_clean")) {
      return adminBadRequest("В открытых параметрах обнаружено секретное поле");
    }
    if (message.includes("stt_configs_base_url_check")) {
      return adminBadRequest("Base URL должен начинаться с https://");
    }
    if (message.includes("stt_route_providers_config_id_fkey")) {
      return adminBadRequest("Конфигурация используется маршрутом");
    }
    return error;
  }
}
