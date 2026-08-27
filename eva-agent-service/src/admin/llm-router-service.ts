/**
 * Админ-слой над LLM Router.
 *
 * Роутер сам по себе конфигурируется таблицами; здесь — единственный
 * разрешённый способ их править. Никакого произвольного SQL из UI: каждый
 * метод принимает разобранное тело и валидирует его до записи.
 *
 * Секреты через этот сервис не проходят: API key провайдера редактируется
 * существующим /api/admin/v1/providers, а сюда попадают только цепочки,
 * лимиты, бюджеты и состояние breaker'а.
 */

import type pg from "pg";

import { adminBadRequest, AdminApiError } from "./errors.js";
import { sanitizeParameters } from "./provider-safe.js";

/** Поля llm_providers, которые роутер использует и админ может менять. */
const NUMERIC_FIELDS = [
  "priority",
  "connect_timeout_ms",
  "request_timeout_ms",
  "max_retries",
  "max_concurrency",
  "max_output_tokens",
  "quality_tier",
  "price_in_micro",
  "price_out_micro",
] as const;

/** Те же, но допускающие NULL — «ограничения нет». */
const NULLABLE_NUMERIC_FIELDS = [
  "max_rpm",
  "max_tpm",
  "max_latency_ms",
  "daily_budget_micro",
  "monthly_budget_micro",
] as const;

const BOOLEAN_FIELDS = [
  "enabled",
  "supports_tools",
  "supports_json",
  "supports_vision",
  "supports_streaming",
  "sensitive_data_allowed",
] as const;

const ROUTE_BOOLEAN_FIELDS = [
  "requires_tools",
  "requires_json",
  "requires_vision",
  "requires_streaming",
  "allows_sensitive",
  // Выключенная ротация оставляет в работе только голову цепочки. Для
  // маршрута chat, которым пользуется Letta, это значит: резервная
  // модель не подменит основную незаметно — разница в стиле ответа
  // заметна, и мириться с ней должен владелец, а не роутер.
  "rotation_enabled",
] as const;

/**
 * Сколько токенов занимает постоянная часть промпта Евы.
 *
 * Значение не выдумано: движок Letta называет его сам, когда отказывается
 * выполнять ход в слишком тесном окне. Держится здесь как порог
 * предупреждения — не как обещание точного размера.
 */
export const EVA_PROMPT_TOKENS = 41_000;

export interface RouterHealthRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  model: string;
  breaker_state: string;
  opened_at: Date | null;
  probe_after: Date | null;
  pinned_out: boolean;
  last_error_code: string | null;
  last_success_at: Date | null;
  spent_today_micro: string | null;
  daily_budget_micro: string | null;
  spent_month_micro: string | null;
  monthly_budget_micro: string | null;
  requests_1h: string | null;
  failures_1h: string | null;
  p95_latency_ms: number | null;
  protocol: string;
  context_window: number;
  supports_tools: boolean;
  supports_json: boolean;
  supports_vision: boolean;
  supports_streaming: boolean;
  sensitive_data_allowed: boolean;
}

export class LlmRouterAdminService {
  constructor(private readonly pool: pg.Pool) {}

  // -----------------------------------------------------------------
  // состояние
  // -----------------------------------------------------------------
  /**
   * Всё, что нужно вкладке «Искусственный интеллект», одним запросом.
   *
   * Провайдер приходит одной записью, а не тремя.
   *
   * Раньше один и тот же провайдер существовал в трёх видах: конфигурация
   * из `/providers`, состояние из `v_llm_provider_health` и место в
   * цепочках из `routes[].chain`. Все три читают одну таблицу
   * `llm_providers`, но склеивал их браузер: карточка показывала итог
   * проверки модели, отдельный список ниже — состояние breaker'а, а
   * маршруты приходилось вычислять пересканированием всех цепочек на
   * каждого провайдера. Три представления расходились в трактовке и жили
   * в разных концах длинной страницы.
   *
   * Здесь они сводятся один раз и на сервере: у клиента остаётся один
   * массив, в котором про провайдера известно всё.
   */
  async state(): Promise<Record<string, unknown>> {
    const [providers, routes, chains, recent, settings] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT health.*,
                provider.protocol, provider.base_url, provider.context_window,
                provider.quality_tier, provider.sensitive_data_allowed,
                provider.supports_tools, provider.supports_json,
                provider.supports_vision, provider.supports_streaming,
                provider.max_output_tokens, provider.max_retries,
                provider.max_concurrency, provider.max_rpm, provider.max_tpm,
                provider.price_in_micro, provider.price_out_micro,
                provider.additional_parameters,
                provider.is_active,
                -- Только факт: сам ключ write-only и наружу не выходит.
                (provider.api_key_encrypted IS NOT NULL
                 AND btrim(provider.api_key_encrypted) <> '') AS api_key_configured,
                provider.last_checked_at, provider.last_check_ok,
                provider.last_check_status, provider.last_check_message,
                provider.created_at, provider.updated_at
           FROM v_llm_provider_health health
           JOIN llm_providers provider ON provider.id = health.id
          ORDER BY health.priority, lower(health.name)`,
      ),
      this.pool.query(
        `SELECT code, title, description, requires_tools, requires_json,
                requires_vision, requires_streaming, min_context_window,
                max_quality_tier, allows_sensitive, rotation_enabled
           FROM llm_routes ORDER BY code`,
      ),
      this.pool.query(
        `SELECT rp.route_code, rp.position, rp.provider_id, p.name, p.model,
                p.enabled, p.protocol, p.quality_tier,
                p.supports_tools, p.supports_json, p.context_window
           FROM llm_route_providers rp
           JOIN llm_providers p ON p.id = rp.provider_id
          ORDER BY rp.route_code, rp.position`,
      ),
      // Последние отказы — то, что администратор хочет видеть первым.
      // Текста переписки в этой таблице нет по построению.
      this.pool.query(
        `
          -- tenant: system — телеметрия роутера в административной панели, доступ ограничен RBAC на маршруте
          SELECT r.request_id, r.route_code, r.started_at, r.switch_reason,
                r.error_summary, r.http_status, r.attempts, p.name AS provider
           FROM llm_requests r
           LEFT JOIN llm_providers p ON p.id = r.actual_provider_id
          WHERE NOT r.succeeded
          ORDER BY r.started_at DESC
          LIMIT 25`,
      ),
      this.routingSettings(),
    ]);

    const byRoute = new Map<string, Array<Record<string, unknown>>>();
    const byProvider = new Map<string, Array<{ code: string; title: string; position: number }>>();
    const routeTitles = new Map(
      (routes.rows as Array<Record<string, unknown>>)
        .map((route) => [String(route.code), String(route.title ?? route.code)]),
    );
    for (const row of chains.rows as Array<Record<string, unknown>>) {
      const code = String(row.route_code);
      const list = byRoute.get(code) ?? [];
      list.push(row);
      byRoute.set(code, list);

      // Членство в маршрутах считается здесь, один раз на цепочку.
      // Клиент раньше пересканировал все цепочки на каждого провайдера и
      // трактовал позиции по-своему в двух разных функциях.
      const id = String(row.provider_id);
      const memberships = byProvider.get(id) ?? [];
      memberships.push({
        code,
        title: routeTitles.get(code) ?? code,
        position: Number(row.position ?? 0),
      });
      byProvider.set(id, memberships);
    }

    const singleId = settings.mode === "single" && settings.single_provider_id
      ? String(settings.single_provider_id)
      : null;

    return {
      providers: providers.rows.map((row) => {
        const id = String(row.id);
        const memberships = (byProvider.get(id) ?? [])
          .sort((left, right) => left.position - right.position);
        return {
          ...row,
          additional_parameters: sanitizeParameters(row.additional_parameters),
          routes: memberships,
          single_selected: singleId === id,
          status: providerStatus(row),
        };
      }),
      routes: (routes.rows as Array<Record<string, unknown>>).map((route) => ({
        ...route,
        chain: byRoute.get(String(route.code)) ?? [],
      })),
      recent_failures: recent.rows,
      routing_settings: settings,
    };
  }

  async routingSettings(): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query(
      `SELECT mode, single_provider_id, single_failover_enabled,
              updated_at, updated_by
         FROM llm_routing_settings WHERE singleton`,
    );
    return (rows[0] ?? {}) as Record<string, unknown>;
  }

  async updateRoutingSettings(
    body: Record<string, unknown>,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    // Порогов и параметров классификатора здесь нет: маршрут выбирается
    // детерминированно, настраивать в нём нечего.
    const allowed = new Set([
      "mode", "single_provider_id", "single_failover_enabled",
    ]);
    const unknown = Object.keys(body).find((key) => !allowed.has(key));
    if (unknown) throw adminBadRequest(`Неизвестное поле ${unknown}`);
    return await this.transaction(async (client) => {
      const currentResult = await client.query<Record<string, unknown>>(
        "SELECT * FROM llm_routing_settings WHERE singleton FOR UPDATE",
      );
      const next = { ...currentResult.rows[0], ...body };
      const mode = String(next.mode ?? "adaptive");
      if (!['adaptive', 'single'].includes(mode)) throw adminBadRequest("mode: adaptive или single");
      const providerId = next.single_provider_id == null || next.single_provider_id === ""
        ? null : String(next.single_provider_id);
      const warnings: string[] = [];
      if (mode === "single") {
        if (!providerId) throw adminBadRequest("Для режима одной модели выберите provider");
        const provider = await client.query<{
          enabled: boolean; supports_tools: boolean; supports_json: boolean;
          supports_streaming: boolean; supports_vision: boolean;
          sensitive_data_allowed: boolean; context_window: number;
        }>(
          `SELECT enabled, supports_tools, supports_json, supports_streaming,
                  supports_vision, sensitive_data_allowed, context_window
             FROM llm_providers WHERE id = $1`,
          [providerId],
        );
        const row = provider.rows[0];
        if (!row || !row.enabled) throw adminBadRequest("Выбранный provider не существует или выключен");
        if (!row.supports_tools || !row.supports_json || !row.sensitive_data_allowed) {
          throw adminBadRequest("Одна модель должна поддерживать tools, JSON и чувствительные данные");
        }
        if (!row.supports_vision) warnings.push("Выбранная модель не поддерживает изображения");
        if (!row.supports_streaming) warnings.push("Выбранная модель не поддерживает streaming");
        if (Number(row.context_window) < 8192) warnings.push("Контекст модели меньше рекомендуемых 8192 токенов");
        // Постоянная часть промпта Евы — системный текст, персона,
        // терапевтическая рамка, описания навыков и определения
        // инструментов — измерена движком примерно в 41 000 токенов.
        // Окно меньше этого не «тесное», а недостаточное: движок
        // обрезает промпт с конца, и первыми уходят память и персона.
        // Снаружи это выглядит не поломкой, а тем, что Ева стала хуже
        // помнить, — поэтому сказать об этом нужно прямо.
        if (Number(row.context_window) < EVA_PROMPT_TOKENS) {
          warnings.push(
            `Контекст модели ${row.context_window} токенов меньше, чем занимает `
            + `постоянная часть промпта Евы (около ${EVA_PROMPT_TOKENS}). `
            + "Память и персона будут обрезаны до того, как модель их увидит.",
          );
        }
      }
      const { rows } = await client.query(
        `UPDATE llm_routing_settings SET
           mode=$1, single_provider_id=$2, single_failover_enabled=$3,
           updated_at=now(), updated_by=$4
         WHERE singleton RETURNING *`,
        [mode, providerId, next.single_failover_enabled === true, actorId],
      );
      await client.query("SELECT pg_notify('llm_routing_settings_changed', '')");
      return { ...rows[0], warnings } as Record<string, unknown>;
    });
  }

  /** Потребление и стоимость по дням — для графика и бюджетов. */
  async usage(days: number): Promise<Record<string, unknown>> {
    const window = Math.min(Math.max(1, Math.floor(days)), 90);
    const { rows } = await this.pool.query(
      `SELECT l.period_start, p.name AS provider, l.requests,
              l.tokens_in, l.tokens_out, l.cost_micro
         FROM llm_spend_ledger l
         JOIN llm_providers p ON p.id = l.provider_id
        WHERE l.period = 'day'
          AND l.period_start > (now() AT TIME ZONE 'UTC')::date - $1::integer
        ORDER BY l.period_start DESC, p.name`,
      [window],
    );
    return { days: window, rows };
  }

  // -----------------------------------------------------------------
  // провайдеры: только то, что относится к маршрутизации
  // -----------------------------------------------------------------
  async updateProvider(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (
      body.enabled === false || body.supports_tools === false ||
      body.supports_json === false || body.sensitive_data_allowed === false
    ) {
      const selected = await this.pool.query(
        `SELECT 1 FROM llm_routing_settings
          WHERE singleton AND mode = 'single' AND single_provider_id = $1`,
        [id],
      );
      if (selected.rowCount) throw adminBadRequest(
        "Сначала выберите другую модель или включите адаптивный режим: выбранной модели нужны enabled, tools, JSON и sensitive data",
      );
    }
    const sets: string[] = [];
    const values: unknown[] = [id];

    for (const field of NUMERIC_FIELDS) {
      if (!(field in body)) continue;
      const value = Number(body[field]);
      if (!Number.isFinite(value)) throw adminBadRequest(`${field}: ожидается число`);
      values.push(Math.floor(value));
      sets.push(`${field} = $${values.length}`);
    }
    for (const field of NULLABLE_NUMERIC_FIELDS) {
      if (!(field in body)) continue;
      const raw = body[field];
      if (raw === null || raw === "") {
        values.push(null);
      } else {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          throw adminBadRequest(`${field}: ожидается неотрицательное число или пусто`);
        }
        values.push(Math.floor(value));
      }
      sets.push(`${field} = $${values.length}`);
    }
    for (const field of BOOLEAN_FIELDS) {
      if (!(field in body)) continue;
      values.push(body[field] === true);
      sets.push(`${field} = $${values.length}`);
    }
    if ("generation_defaults" in body) {
      const raw = body.generation_defaults;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw adminBadRequest("generation_defaults: ожидается объект JSON");
      }
      values.push(JSON.stringify(raw));
      sets.push(`generation_defaults = $${values.length}::jsonb`);
    }

    if (sets.length === 0) throw adminBadRequest("нет полей для изменения");

    try {
      const { rows } = await this.pool.query(
        `UPDATE llm_providers SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $1
        RETURNING id, name, enabled, priority, protocol, model, context_window,
                  connect_timeout_ms, request_timeout_ms, max_retries, max_concurrency,
                  max_rpm, max_tpm, max_output_tokens, max_latency_ms,
                  supports_tools, supports_json, supports_vision, supports_streaming,
                  quality_tier, sensitive_data_allowed, price_in_micro, price_out_micro,
                  currency, daily_budget_micro, monthly_budget_micro, generation_defaults`,
        values,
      );
      const row = rows[0];
      if (!row) throw new AdminApiError("provider_not_found", "Провайдер не найден", 404);
      return row as Record<string, unknown>;
    } catch (error) {
      // CHECK-ограничения схемы — это и есть валидация диапазонов; не
      // дублируем их в коде, а переводим отказ в понятное сообщение.
      throw asBadRequest(error, "не удалось сохранить провайдера");
    }
  }

  // -----------------------------------------------------------------
  // маршруты и цепочки
  // -----------------------------------------------------------------
  async updateRoute(code: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sets: string[] = [];
    const values: unknown[] = [code];

    for (const field of ROUTE_BOOLEAN_FIELDS) {
      if (!(field in body)) continue;
      values.push(body[field] === true);
      sets.push(`${field} = $${values.length}`);
    }
    for (const field of ["min_context_window", "max_quality_tier"] as const) {
      if (!(field in body)) continue;
      const value = Number(body[field]);
      if (!Number.isFinite(value)) throw adminBadRequest(`${field}: ожидается число`);
      values.push(Math.floor(value));
      sets.push(`${field} = $${values.length}`);
    }
    if (sets.length === 0) throw adminBadRequest("нет полей для изменения");

    try {
      const { rows } = await this.pool.query(
        `UPDATE llm_routes SET ${sets.join(", ")} WHERE code = $1 RETURNING *`,
        values,
      );
      const row = rows[0];
      if (!row) throw new AdminApiError("route_not_found", "Маршрут не найден", 404);
      return row as Record<string, unknown>;
    } catch (error) {
      throw asBadRequest(error, "не удалось сохранить маршрут");
    }
  }

  /**
   * Заменяет цепочку маршрута целиком: первый элемент — основной, дальше
   * до пяти резервов. Порядок задаётся списком, а не отдельными позициями,
   * поэтому «поменять местами» не требует двух запросов и не может
   * оставить дыру в нумерации.
   */
  async setChain(code: string, providerIds: unknown): Promise<Record<string, unknown>> {
    if (!Array.isArray(providerIds)) {
      throw adminBadRequest("providers: ожидается массив идентификаторов");
    }
    if (providerIds.length === 0) {
      throw adminBadRequest("в цепочке должен быть хотя бы основной провайдер");
    }
    if (providerIds.length > 6) {
      throw adminBadRequest("не более пяти резервов (шесть позиций всего)");
    }
    const ids = providerIds.map((id) => {
      if (typeof id !== "string" || !id.trim()) throw adminBadRequest("некорректный id провайдера");
      return id;
    });
    if (new Set(ids).size !== ids.length) {
      throw adminBadRequest("провайдер не может занимать две позиции одной цепочки");
    }

    return await this.transaction(async (client) => {
      const route = await client.query("SELECT code FROM llm_routes WHERE code = $1", [code]);
      if (route.rowCount === 0) {
        throw new AdminApiError("route_not_found", "Маршрут не найден", 404);
      }
      const known = await client.query<{ id: string }>(
        "SELECT id FROM llm_providers WHERE id = ANY($1::uuid[])",
        [ids],
      );
      if (known.rowCount !== ids.length) {
        throw adminBadRequest("в списке есть несуществующий провайдер");
      }

      await client.query("DELETE FROM llm_route_providers WHERE route_code = $1", [code]);
      for (const [position, providerId] of ids.entries()) {
        await client.query(
          `INSERT INTO llm_route_providers (route_code, provider_id, position)
           VALUES ($1, $2, $3)`,
          [code, providerId, position],
        );
      }
      return { route_code: code, providers: ids };
    });
  }

  // -----------------------------------------------------------------
  // circuit breaker
  // -----------------------------------------------------------------
  async resetBreaker(providerId: string): Promise<Record<string, unknown>> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO llm_breaker_state (provider_id, state, consecutive_errors)
       VALUES ($1, 'closed', 0)
       ON CONFLICT (provider_id) DO UPDATE SET
           state = 'closed', consecutive_errors = 0, first_error_at = NULL,
           opened_at = NULL, probe_after = NULL`,
      [providerId],
    );
    if (rowCount === 0) throw new AdminApiError("provider_not_found", "Провайдер не найден", 404);
    return { provider_id: providerId, state: "closed" };
  }

  /**
   * Ручное снятие провайдера с автовозврата. Пока pinned_out включён,
   * роутер не вернётся на него сам даже после успешной проверки — это
   * то самое «временное отключение автовозврата» из требований.
   */
  async setPinnedOut(providerId: string, pinned: boolean): Promise<Record<string, unknown>> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO llm_breaker_state (provider_id, pinned_out)
       VALUES ($1, $2)
       ON CONFLICT (provider_id) DO UPDATE SET pinned_out = $2`,
      [providerId, pinned],
    );
    if (rowCount === 0) throw new AdminApiError("provider_not_found", "Провайдер не найден", 404);
    return { provider_id: providerId, pinned_out: pinned };
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Нарушение CHECK — это ошибка ввода администратора, а не 500. */
function asBadRequest(error: unknown, fallback: string): AdminApiError {
  if (error instanceof AdminApiError) return error;
  const code = (error as { code?: string }).code;
  if (code === "23514" || code === "23505" || code === "22P02" || code === "23503") {
    const detail = (error as { constraint?: string }).constraint ?? "";
    return adminBadRequest(detail ? `${fallback}: нарушено ограничение ${detail}` : fallback);
  }
  throw error;
}

/**
 * Итоговое состояние провайдера одной фразой.
 *
 * Считается на сервере, а не в браузере, потому что причин две и они из
 * разных миров. Проверка возможностей спрашивает модель напрямую: умеет
 * ли она инструменты, поток, изображения, строгий JSON. Circuit breaker
 * знает, что происходило с ней в работе. Панель показывала их двумя
 * разными списками в разных концах страницы, и провайдер мог
 * одновременно быть «работает» в одном и «закрыт после ошибок» в другом.
 *
 * Порядок причин — от «ничего не поедет, пока не почините» к «работает».
 * Он важнее самих ярлыков: первая подходящая причина и есть та, с
 * которой оператору надо разбираться.
 *
 * `detail` разделяет два источника явно, чтобы подробности карточки
 * могли показать «Проверка модели» и «Router» отдельно и не выдавать
 * одно за другое.
 */
export function providerStatus(row: Record<string, unknown>): {
  code: string;
  label: string;
  color: "green" | "yellow" | "red" | "gray";
  detail: { check: string | null; router: string | null };
} {
  const check = typeof row.last_check_status === "string" ? row.last_check_status : null;
  const legacyFailed = check === null && row.last_check_ok === false;
  const breaker = String(row.breaker_state ?? "closed");
  const detail = {
    check: check ?? (row.last_check_ok === true ? "ok" : legacyFailed ? "config_error" : null),
    router: row.pinned_out === true ? "pinned_out" : breaker,
  };
  const state = (
    code: string,
    label: string,
    color: "green" | "yellow" | "red" | "gray",
  ) => ({ code, label, color, detail });

  if (check === "config_error" || legacyFailed) {
    return state("config_error", "ошибка конфигурации", "red");
  }
  if (row.enabled === false) return state("disabled", "выключен вручную", "gray");
  if (row.pinned_out === true) return state("pinned_out", "снят с автовозврата", "gray");
  if (breaker === "open") return state("breaker_open", "временно исключён", "red");
  if (breaker === "half_open") return state("breaker_probe", "пробный запрос", "yellow");
  if (check === "unavailable") return state("unavailable", "временно недоступен", "yellow");
  if (check === "limited") return state("limited", "работает с ограничениями", "yellow");
  if (check === "ok" || row.last_check_ok === true) return state("ok", "работает", "green");
  return state("unchecked", "не проверялся", "gray");
}
