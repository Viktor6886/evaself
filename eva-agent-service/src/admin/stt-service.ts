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

export const STT_PROVIDERS = ["deepgram", "openai", "google", "openrouter"] as const;

/** Ключи, которые нельзя записать в public_config ни при каких условиях. */
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "api_key", "apikey", "secret", "secret_key", "secretkey",
  "private_key", "privatekey", "authorization", "access_token", "accesstoken",
  "refresh_token", "refreshtoken", "credentials", "service_account",
  "serviceaccount", "client_secret", "clientsecret",
]);

/** Максимум для загружаемого service account JSON. */
const MAX_CREDENTIALS_BYTES = 16 * 1024;

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

  private async headers(): Promise<Record<string, string>> {
    const token = await this.secrets.get("sec_media_service_token");
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
  ) {}

  // -------------------------------------------------------------------
  // схемы провайдеров
  // -------------------------------------------------------------------
  /** Проксируется из media-service: источник истины там, где адаптеры. */
  async providerSchemas(): Promise<{ providers: unknown[] }> {
    return await this.media.providerSchemas();
  }

  // -------------------------------------------------------------------
  // чтение
  // -------------------------------------------------------------------
  async list(includeArchived = false): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query<SttConfigRow & { used_by: string[] }>(
      `SELECT c.*,
              COALESCE(
                ARRAY(
                  SELECT r.use_case FROM stt_routes r
                   WHERE r.primary_config_id = c.id OR r.fallback_config_id = c.id
                   ORDER BY r.use_case
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
      `SELECT use_case FROM stt_routes
        WHERE primary_config_id = $1 OR fallback_config_id = $1
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
    return await this.get(id);
  }

  // -------------------------------------------------------------------
  async test(id: string, audioBase64?: string) {
    const row = await this.row(id);
    const secret = row.secret_ref ? await this.secrets.get(row.secret_ref) : null;
    const result = await this.media.test(
      {
        id: row.id,
        name: row.name,
        provider: row.provider,
        mode: row.mode,
        base_url: row.base_url,
        model: row.model,
        params: row.public_config ?? {},
        secret: secret ?? "",
      },
      audioBase64,
    );

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
   * Активация: конфигурация становится рабочей для сценария.
   *
   * Требование «активация допускается только после успешного теста»
   * выполняется буквально — сначала прогоняется проверка, и при её
   * провале маршрут не меняется.
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

    const column = slot === "primary" ? "primary_config_id" : "fallback_config_id";
    const other = slot === "primary" ? "fallback_config_id" : "primary_config_id";
    try {
      await this.pool.query(
        `UPDATE stt_routes
            SET ${column} = $2,
                ${other} = CASE WHEN ${other} = $2 THEN NULL ELSE ${other} END,
                config_version = config_version + 1,
                updated_by = $3
          WHERE use_case = $1`,
        [useCase, id, actorId],
      );
      await this.pool.query(
        "UPDATE stt_provider_configs SET status = 'healthy' WHERE id = $1",
        [id],
      );
    } catch (error) {
      throw this.friendly(error);
    }
    await this.pushSnapshot();
    return await this.routes();
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
              CASE WHEN primary_config_id = $1 THEN 'основной' ELSE 'резервный' END AS slot
         FROM stt_routes
        WHERE primary_config_id = $1 OR fallback_config_id = $1`,
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
  async routes(): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `SELECT r.use_case, r.enabled, r.timeout_ms, r.max_audio_seconds, r.config_version,
              r.primary_config_id, p.name AS primary_name, p.provider AS primary_provider,
              r.fallback_config_id, f.name AS fallback_name, f.provider AS fallback_provider,
              r.updated_at
         FROM stt_routes r
         LEFT JOIN stt_provider_configs p ON p.id = r.primary_config_id
         LEFT JOIN stt_provider_configs f ON f.id = r.fallback_config_id
        ORDER BY r.use_case`,
    );
    return rows;
  }

  async updateRoute(useCase: string, body: Record<string, unknown>, actorId: string | null) {
    this.assertUseCase(useCase);
    const primary = this.optionalUuid(body.primary_config_id, "primary_config_id");
    const fallback = this.optionalUuid(body.fallback_config_id, "fallback_config_id");

    if (primary && fallback && primary === fallback) {
      throw adminBadRequest(
        "Основной и резервный провайдер не могут совпадать: при отказе вторая " +
        "попытка ушла бы туда же и стоила бы вторых денег",
      );
    }
    for (const [id, role] of [[primary, "основной"], [fallback, "резервный"]] as const) {
      if (!id) continue;
      const row = await this.row(id);
      if (row.archived_at) throw adminBadRequest(`Архивная конфигурация не может быть ${role}`);
      if (!row.secret_ref) throw adminBadRequest(`У конфигурации «${row.name}» не задан ключ`);
    }

    const timeout = this.optionalInt(body.timeout_ms, "timeout_ms", 5_000, 600_000);
    const maxAudio = this.optionalInt(body.max_audio_seconds, "max_audio_seconds", 1, 7_200);

    try {
      const { rowCount } = await this.pool.query(
        `UPDATE stt_routes
            SET primary_config_id = $2,
                fallback_config_id = $3,
                enabled = COALESCE($4, enabled),
                timeout_ms = COALESCE($5, timeout_ms),
                max_audio_seconds = COALESCE($6, max_audio_seconds),
                config_version = config_version + 1,
                updated_by = $7
          WHERE use_case = $1`,
        [
          useCase, primary, fallback,
          typeof body.enabled === "boolean" ? body.enabled : null,
          timeout, maxAudio, actorId,
        ],
      );
      if (!rowCount) throw adminNotFound("Сценарий не найден");
    } catch (error) {
      throw this.friendly(error);
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
         JOIN stt_routes r
           ON r.primary_config_id = c.id OR r.fallback_config_id = c.id
        WHERE c.archived_at IS NULL`,
    );

    const configs: ResolvedForMedia[] = [];
    for (const row of rows) {
      const secret = row.secret_ref ? await this.secrets.get(row.secret_ref) : null;
      if (!secret) continue; // без ключа конфигурация нерабочая
      configs.push({
        id: row.id,
        name: row.name,
        provider: row.provider,
        mode: row.mode,
        base_url: row.base_url,
        model: row.model,
        params: row.public_config ?? {},
        secret,
      });
    }

    const known = new Set(configs.map((item) => item.id));
    const routeRows = await this.routes();
    const routes = routeRows
      .map((route) => ({
        use_case: route.use_case,
        // Ссылку на конфигурацию без ключа не отправляем: снимок с
        // висящей ссылкой media-service отвергнет целиком.
        primary_config_id: known.has(route.primary_config_id as string)
          ? route.primary_config_id : null,
        fallback_config_id: known.has(route.fallback_config_id as string)
          ? route.fallback_config_id : null,
        enabled: route.enabled,
        timeout_ms: route.timeout_ms,
        max_audio_seconds: route.max_audio_seconds,
        config_version: route.config_version,
      }));

    // Версия снимка — сумма версий маршрутов: монотонно растёт при
    // любом изменении и не требует отдельного счётчика.
    const version = routeRows.reduce((sum, route) => sum + Number(route.config_version ?? 0), 0);
    const result = await this.media.applySnapshot({ version, configs, routes });
    return { applied: result.applied, errors: result.errors ?? [] };
  }

  // -------------------------------------------------------------------
  // телеметрия
  // -------------------------------------------------------------------
  async usage(days: number): Promise<Record<string, unknown>> {
    const bounded = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
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
          Math.min(index + 1, 2),
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
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS count
         FROM stt_provider_configs WHERE archived_at IS NULL GROUP BY status`,
    );
    const routes = await this.routes();
    return {
      configs_by_status: Object.fromEntries(rows.map((row) => [row.status, row.count])),
      routes_configured: routes.filter((route) => route.primary_config_id).length,
      routes_total: routes.length,
      routes,
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
    if (message.includes("stt_routes_distinct_check")) {
      return adminBadRequest("Основной и резервный провайдер не могут совпадать");
    }
    if (message.includes("stt_configs_public_config_clean")) {
      return adminBadRequest("В открытых параметрах обнаружено секретное поле");
    }
    if (message.includes("stt_configs_base_url_check")) {
      return adminBadRequest("Base URL должен начинаться с https://");
    }
    if (message.includes("stt_routes_primary_config_id_fkey")
      || message.includes("stt_routes_fallback_config_id_fkey")) {
      return adminBadRequest("Конфигурация используется маршрутом");
    }
    return error;
  }
}
