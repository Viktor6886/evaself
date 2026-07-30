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
] as const;

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
}

export class LlmRouterAdminService {
  constructor(private readonly pool: pg.Pool) {}

  // -----------------------------------------------------------------
  // состояние
  // -----------------------------------------------------------------
  /** Всё, что нужно вкладке «Искусственный интеллект», одним запросом. */
  async state(): Promise<Record<string, unknown>> {
    const [health, routes, chains, recent] = await Promise.all([
      this.pool.query<RouterHealthRow>(
        "SELECT * FROM v_llm_provider_health ORDER BY priority, lower(name)",
      ),
      this.pool.query(
        `SELECT code, title, description, requires_tools, requires_json,
                requires_vision, requires_streaming, min_context_window,
                max_quality_tier, allows_sensitive
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
        `SELECT r.request_id, r.route_code, r.started_at, r.switch_reason,
                r.error_summary, r.http_status, r.attempts, p.name AS provider
           FROM llm_requests r
           LEFT JOIN llm_providers p ON p.id = r.actual_provider_id
          WHERE NOT r.succeeded
          ORDER BY r.started_at DESC
          LIMIT 25`,
      ),
    ]);

    const byRoute = new Map<string, unknown[]>();
    for (const row of chains.rows as Array<Record<string, unknown>>) {
      const code = String(row.route_code);
      const list = byRoute.get(code) ?? [];
      list.push(row);
      byRoute.set(code, list);
    }

    return {
      providers: health.rows,
      routes: (routes.rows as Array<Record<string, unknown>>).map((route) => ({
        ...route,
        chain: byRoute.get(String(route.code)) ?? [],
      })),
      recent_failures: recent.rows,
    };
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
