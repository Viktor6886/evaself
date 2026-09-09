/**
 * Весь SQL роутера в одном месте.
 *
 * Провайдеры и маршруты кэшируются на несколько секунд: цепочка меняется
 * редко, а читается на каждый запрос. Состояние breaker'а не кэшируется —
 * оно общее для всех реплик роутера и должно читаться свежим.
 */

import type pg from "pg";

import { SecretBox } from "../llm.js";
import { runInScope, systemScope } from "../tenancy/index.js";
import type {
  LlmRequest,
  LlmResponse,
  ProviderProfile,
  RouteDefinition,
  RoutingSettings,
  SwitchReason,
} from "./types.js";
import { breakerKey } from "./types.js";

export interface BreakerRow {
  provider_id: string;
  model: string;
  state: "closed" | "open" | "half_open";
  consecutive_errors: number;
  first_error_at: Date | null;
  opened_at: Date | null;
  probe_after: Date | null;
  last_error_code: string | null;
  last_success_at: Date | null;
  pinned_out: boolean;
}

export interface AttemptRecord {
  request_id: string;
  route_code: string;
  user_id: string | null;
  agent_id: string | null;
  primary_provider_id: string | null;
  actual_provider_id: string | null;
  model: string | null;
  started_at: Date;
  latency_ms: number;
  attempts: number;
  switches: number;
  succeeded: boolean;
  error_code: string | null;
  switch_reason: SwitchReason | null;
  error_summary: string | null;
  http_status: number | null;
  tokens_in: number;
  /** Часть `tokens_in`, пришедшая из кэша промпта провайдера. */
  cached_tokens_in: number;
  tokens_out: number;
  cost_micro: number;
  tool_calls: number;
  streamed: boolean;
  routing_mode: "adaptive" | "single";
  requested_route: string;
  effective_route: string;
  classification_source: string | null;
  classification_confidence: number | null;
  classification_score: number | null;
  classification_reason_codes: string[];
  purpose: string | null;
  internal_operation_type: string | null;
  single_failover_used: boolean;
}

const CACHE_TTL_MS = 5_000;

export class RouterStore {
  private readonly secrets: SecretBox;
  private providerCache: { at: number; rows: ProviderProfile[] } | null = null;
  private routeCache: { at: number; rows: Map<string, RouteDefinition> } | null = null;
  private chainCache: { at: number; rows: Map<string, string[]> } | null = null;
  private settingsCache: { at: number; row: RoutingSettings } | null = null;
  private settingsListener: pg.PoolClient | null = null;
  private settingsListenerPromise: Promise<void> | null = null;

  constructor(private readonly pool: pg.Pool, encryptionKey: string) {
    this.secrets = new SecretBox(encryptionKey);
  }

  invalidate(): void {
    this.providerCache = null;
    this.routeCache = null;
    this.chainCache = null;
    this.settingsCache = null;
  }

  async close(): Promise<void> {
    const listener = this.settingsListener;
    this.settingsListener = null;
    if (!listener) return;
    await listener.query("UNLISTEN llm_routing_settings_changed").catch(() => undefined);
    listener.release();
  }

  // -----------------------------------------------------------------
  // конфигурация
  // -----------------------------------------------------------------
  async providers(): Promise<ProviderProfile[]> {
    if (this.providerCache && Date.now() - this.providerCache.at < CACHE_TTL_MS) {
      return this.providerCache.rows;
    }
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT id, name, protocol, base_url, model, api_key_encrypted, api_keys_encrypted,
              connect_timeout_ms, request_timeout_ms, max_retries, max_concurrency,
              max_rpm, max_tpm, context_window, max_output_tokens, max_latency_ms,
              supports_tools, supports_json, supports_vision, supports_streaming,
              quality_tier, sensitive_data_allowed,
              price_in_micro, price_out_micro, price_cached_in_micro,
              daily_budget_micro, monthly_budget_micro,
              generation_defaults, additional_parameters
         FROM llm_providers
        WHERE enabled
        ORDER BY priority, lower(name)`,
    );
    const parsed = rows.map((row) => this.toProfile(row));
    this.providerCache = { at: Date.now(), rows: parsed };
    return parsed;
  }

  /**
   * Пул ключей провайдера.
   *
   * Битый или неразбираемый ключ не должен ронять весь провайдер: он
   * просто выпадает из пула, а рабочие остаются. Первым идёт основной —
   * тот же, что в api_key_encrypted, — чтобы поведение без пула не
   * отличалось от прежнего ни одним запросом.
   */
  private decryptPool(raw: unknown, primaryEncrypted: string): string[] {
    const keys: string[] = [];
    const add = (encrypted: string): void => {
      let value: string;
      try {
        value = this.secrets.decrypt(encrypted);
      } catch {
        return;
      }
      if (value && !keys.includes(value)) keys.push(value);
    };
    add(primaryEncrypted);
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry === "string" && entry.trim()) add(entry);
    }
    return keys;
  }

  private toProfile(row: Record<string, unknown>): ProviderProfile {
    const number = (key: string, fallback: number): number => {
      const value = Number(row[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    const nullable = (key: string): number | null => {
      if (row[key] === null || row[key] === undefined) return null;
      const value = Number(row[key]);
      return Number.isFinite(value) ? value : null;
    };
    const additionalParameters = (row.additional_parameters as Record<string, unknown>) ?? {};
    const configuredMaxOutput = Number(additionalParameters.max_output_tokens);
    return {
      id: String(row.id),
      name: String(row.name),
      protocol: row.protocol as ProviderProfile["protocol"],
      base_url: String(row.base_url),
      model: String(row.model),
      // Расшифровка происходит здесь и только здесь; дальше ключ живёт в
      // памяти процесса и не попадает ни в журнал, ни в ответ.
      api_key: this.secrets.decrypt(String(row.api_key_encrypted)),
      // Пул ключей. Пустой массив — пул не заводили, и ключ ровно один,
      // прежний: так выглядят все строки до миграции 069.
      api_keys: this.decryptPool(row.api_keys_encrypted, String(row.api_key_encrypted)),
      connect_timeout_ms: number("connect_timeout_ms", 10_000),
      request_timeout_ms: number("request_timeout_ms", 180_000),
      max_retries: number("max_retries", 2),
      max_concurrency: number("max_concurrency", 8),
      max_rpm: nullable("max_rpm"),
      max_tpm: nullable("max_tpm"),
      context_window: number("context_window", 8192),
      max_output_tokens: Number.isFinite(configuredMaxOutput) && configuredMaxOutput > 0
        ? Math.floor(configuredMaxOutput)
        : number("max_output_tokens", 4096),
      max_latency_ms: nullable("max_latency_ms"),
      supports_tools: row.supports_tools === true,
      supports_json: row.supports_json === true,
      supports_vision: row.supports_vision === true,
      supports_streaming: row.supports_streaming === true,
      quality_tier: number("quality_tier", 3),
      sensitive_data_allowed: row.sensitive_data_allowed === true,
      price_in_micro: number("price_in_micro", 0),
      price_out_micro: number("price_out_micro", 0),
      price_cached_in_micro: nullable("price_cached_in_micro"),
      daily_budget_micro: nullable("daily_budget_micro"),
      monthly_budget_micro: nullable("monthly_budget_micro"),
      generation_defaults: (row.generation_defaults as Record<string, unknown>) ?? {},
      additional_parameters: additionalParameters,
    };
  }

  async routes(): Promise<Map<string, RouteDefinition>> {
    if (this.routeCache && Date.now() - this.routeCache.at < CACHE_TTL_MS) {
      return this.routeCache.rows;
    }
    const { rows } = await this.pool.query<RouteDefinition>(
      `SELECT code, title, requires_tools, requires_json, requires_vision,
              requires_streaming, min_context_window, max_quality_tier, allows_sensitive,
              rotation_enabled
         FROM llm_routes`,
    );
    const map = new Map(rows.map((row) => [row.code, row]));
    this.routeCache = { at: Date.now(), rows: map };
    return map;
  }

  /** route_code -> provider_id[] в порядке позиций. */
  async chains(): Promise<Map<string, string[]>> {
    if (this.chainCache && Date.now() - this.chainCache.at < CACHE_TTL_MS) {
      return this.chainCache.rows;
    }
    const { rows } = await this.pool.query<{ route_code: string; provider_id: string }>(
      `SELECT route_code, provider_id
         FROM llm_route_providers
        ORDER BY route_code, position`,
    );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.route_code) ?? [];
      list.push(row.provider_id);
      map.set(row.route_code, list);
    }
    this.chainCache = { at: Date.now(), rows: map };
    return map;
  }

  async routingSettings(): Promise<RoutingSettings> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < CACHE_TTL_MS) {
      return this.settingsCache.row;
    }
    await this.ensureSettingsListener().catch(() => undefined);
    let rows: RoutingSettings[];
    try {
      ({ rows } = await this.pool.query<RoutingSettings>(
        `SELECT mode, single_provider_id, single_failover_enabled
           FROM llm_routing_settings WHERE singleton`,
      ));
    } catch (error) {
      // A transient PostgreSQL failure must not change the model selection
      // mid-conversation. The last validated snapshot remains authoritative.
      if (this.settingsCache) return this.settingsCache.row;
      throw error;
    }
    const raw = rows[0];
    const row: RoutingSettings = raw ?? {
      mode: "adaptive", single_provider_id: null, single_failover_enabled: false,
    };
    this.settingsCache = { at: Date.now(), row };
    return row;
  }

  private async ensureSettingsListener(): Promise<void> {
    if (this.settingsListener) return;
    if (this.settingsListenerPromise) return await this.settingsListenerPromise;
    this.settingsListenerPromise = (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("LISTEN llm_routing_settings_changed");
        client.on("notification", (message) => {
          if (message.channel === "llm_routing_settings_changed") this.invalidate();
        });
        client.on("error", () => {
          if (this.settingsListener === client) this.settingsListener = null;
        });
        this.settingsListener = client;
      } catch (error) {
        client.release(true);
        throw error;
      }
    })().finally(() => { this.settingsListenerPromise = null; });
    return await this.settingsListenerPromise;
  }

  // -----------------------------------------------------------------
  // circuit breaker
  // -----------------------------------------------------------------
  async breakers(): Promise<Map<string, BreakerRow>> {
    const { rows } = await this.pool.query<BreakerRow>(
      `SELECT provider_id, model, state, consecutive_errors, first_error_at, opened_at,
              probe_after, last_error_code, last_success_at, pinned_out
         FROM llm_breaker_model_state`,
    );
    return new Map(rows.map((row) => [breakerKey(row.provider_id, row.model), row]));
  }

  /**
   * Записывает ошибку и, если порог превышен, открывает breaker.
   * Счётчик сбрасывается, когда предыдущая ошибка была давно: три ошибки за
   * неделю — это не отказ провайдера.
   */
  async recordFailure(
    providerId: string,
    model: string,
    errorCode: string,
    threshold: number,
    windowMs: number,
    cooldownMs: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_breaker_model_state
           (provider_id, model, state, consecutive_errors, first_error_at, last_error_code)
       VALUES ($1, $2, 'closed', 1, now(), $3)
       ON CONFLICT (provider_id, model) DO UPDATE SET
           consecutive_errors = CASE
               WHEN llm_breaker_model_state.first_error_at IS NULL
                 OR llm_breaker_model_state.first_error_at < now() - ($4 || ' milliseconds')::interval
               THEN 1
               ELSE llm_breaker_model_state.consecutive_errors + 1
           END,
           first_error_at = CASE
               WHEN llm_breaker_model_state.first_error_at IS NULL
                 OR llm_breaker_model_state.first_error_at < now() - ($4 || ' milliseconds')::interval
               THEN now()
               ELSE llm_breaker_model_state.first_error_at
           END,
           last_error_code = $3`,
      [providerId, model, errorCode.slice(0, 120), windowMs],
    );

    await this.pool.query(
      `UPDATE llm_breaker_model_state
          SET state = 'open',
              opened_at = now(),
              probe_after = now() + ($3 || ' milliseconds')::interval
        WHERE provider_id = $1 AND model = $2
          AND state <> 'open'
          AND consecutive_errors >= $4`,
      [providerId, model, cooldownMs, threshold],
    );
  }

  /** Успех закрывает breaker и обнуляет счётчик. */
  async recordSuccess(providerId: string, model: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_breaker_model_state
           (provider_id, model, state, consecutive_errors, last_success_at)
       VALUES ($1, $2, 'closed', 0, now())
       ON CONFLICT (provider_id, model) DO UPDATE SET
           state = CASE WHEN llm_breaker_model_state.pinned_out THEN llm_breaker_model_state.state ELSE 'closed' END,
           consecutive_errors = 0,
           first_error_at = NULL,
           opened_at = NULL,
           probe_after = NULL,
           last_success_at = now()`,
      [providerId, model],
    );
  }

  /**
   * Переводит открытый breaker в half_open, если время выдержки вышло.
   * UPDATE ... RETURNING делает переход атомарным: две реплики роутера не
   * отправят два пробных запроса одновременно.
   */
  /**
   * Захватывает право на пробный запрос — на срок, а не навсегда.
   *
   * Прежде состояние `half_open` ставилось без срока. Пока проба идёт,
   * это верно: второй запрос к упавшему провайдеру не нужен. Но если
   * процесс перезапустился, контейнер пересоздали или запрос оборвался
   * между `claimProbe` и записью исхода, `half_open` оставался в таблице
   * навсегда, и провайдер исключался из каждого хода с формулировкой
   * «circuit breaker уже выполняет единственный пробный запрос».
   * Выполнять его к тому моменту было некому. Вернуть провайдера могла
   * только кнопка в панели, а сам он не восстанавливался никогда.
   *
   * Теперь захват продлевает `probe_after`: пока срок не вышел, чужая
   * проба считается идущей, после — брошенной, и её место можно занять.
   */
  async claimProbe(providerId: string, model: string, leaseMs: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE llm_breaker_model_state
          SET state = 'half_open',
              probe_after = now() + make_interval(secs => $3)
        WHERE provider_id = $1 AND model = $2
          -- half_open с истёкшим сроком — брошенная проба, а не идущая.
          AND state IN ('open', 'half_open')
          AND NOT pinned_out
          AND probe_after IS NOT NULL
          AND probe_after <= now()`,
      [providerId, model, Math.max(1, Math.ceil(leaseMs / 1000))],
    );
    return (rowCount ?? 0) > 0;
  }

  async resetBreaker(providerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE llm_breaker_model_state
          SET state = 'closed', consecutive_errors = 0, first_error_at = NULL,
              opened_at = NULL, probe_after = NULL
        WHERE provider_id = $1`,
      [providerId],
    );
    await this.pool.query(
      `INSERT INTO llm_breaker_model_state (provider_id, model, state, consecutive_errors)
       SELECT id, model, 'closed', 0 FROM llm_providers WHERE id = $1
       ON CONFLICT (provider_id, model) DO UPDATE SET
           state = 'closed', consecutive_errors = 0, first_error_at = NULL,
           opened_at = NULL, probe_after = NULL`,
      [providerId],
    );
  }

  async setPinnedOut(providerId: string, pinned: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE llm_breaker_model_state SET pinned_out = $2 WHERE provider_id = $1`,
      [providerId, pinned],
    );
    await this.pool.query(
      `INSERT INTO llm_breaker_model_state (provider_id, model, pinned_out)
       SELECT id, model, $2 FROM llm_providers WHERE id = $1
       ON CONFLICT (provider_id, model) DO UPDATE SET pinned_out = $2`,
      [providerId, pinned],
    );
  }

  // -----------------------------------------------------------------
  // расходы
  // -----------------------------------------------------------------
  /** Потрачено за сутки и за месяц, в микроединицах валюты. */
  async spend(providerId: string): Promise<{ day: number; month: number }> {
    const { rows } = await this.pool.query<{ period: string; cost_micro: string }>(
      `SELECT period, cost_micro
         FROM llm_spend_ledger
        WHERE provider_id = $1
          AND ((period = 'day'   AND period_start = (now() AT TIME ZONE 'UTC')::date)
            OR (period = 'month' AND period_start = date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date))`,
      [providerId],
    );
    let day = 0;
    let month = 0;
    for (const row of rows) {
      if (row.period === "day") day = Number(row.cost_micro);
      if (row.period === "month") month = Number(row.cost_micro);
    }
    return { day, month };
  }

  async addSpend(
    providerId: string,
    usage: {
      tokens_in: number;
      tokens_out: number;
      cost_micro: number;
      cached_tokens_in?: number;
    },
  ): Promise<void> {
    // Границы периодов считаются в UTC на стороне PostgreSQL, а не через
    // new Date(y, m, 1) в процессе: часовой пояс контейнера иначе сдвигает
    // начало месяца на сутки назад.
    await this.pool.query(
      `INSERT INTO llm_spend_ledger
           (provider_id, period, period_start, tokens_in, tokens_out, requests,
            cost_micro, cached_tokens_in)
       VALUES
           ($1, 'day',   (now() AT TIME ZONE 'UTC')::date, $2, $3, 1, $4, $5),
           ($1, 'month', date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date, $2, $3, 1, $4, $5)
       ON CONFLICT (provider_id, period, period_start) DO UPDATE SET
           tokens_in  = llm_spend_ledger.tokens_in  + EXCLUDED.tokens_in,
           tokens_out = llm_spend_ledger.tokens_out + EXCLUDED.tokens_out,
           requests   = llm_spend_ledger.requests   + 1,
           cost_micro = llm_spend_ledger.cost_micro + EXCLUDED.cost_micro,
           cached_tokens_in = llm_spend_ledger.cached_tokens_in + EXCLUDED.cached_tokens_in,
           updated_at = now()`,
      [
        providerId, usage.tokens_in, usage.tokens_out, usage.cost_micro,
        usage.cached_tokens_in ?? 0,
      ],
    );
  }

  // -----------------------------------------------------------------
  // журнал
  // -----------------------------------------------------------------
  /**
   * Телеметрия хода. `user_id` здесь — отметка принадлежности, а не
   * ключ доступа: роутер никогда не читает по нему чужие записи, а
   * запись идёт как объявленная системная работа сервиса.
   */
  /**
   * Наблюдатель метаданных генерации.
   *
   * Ставится снаружи и вызывается ПОСЛЕ записи в `llm_requests`:
   * телеметрия не имеет права ни задержать запись, ни отменить её.
   * Внутрь уходят только числа и идентификаторы модели — ни промпта, ни
   * ответа роутер наблюдателю не показывает.
   */
  setObserver(observer: (record: AttemptRecord) => void): void {
    this.observer = observer;
  }

  private observer: ((record: AttemptRecord) => void) | null = null;

  async recordAttempt(record: AttemptRecord): Promise<void> {
    await runInScope(systemScope("llm-router.telemetry"), async () => {
    await this.pool.query(
      `INSERT INTO llm_requests
           (request_id, route_code, user_id, agent_id, primary_provider_id,
            actual_provider_id, model, started_at, finished_at, latency_ms,
            attempts, switches, succeeded, error_code, switch_reason,
            error_summary, http_status, tokens_in, tokens_out, cost_micro,
            tool_calls, streamed, routing_mode, requested_route, effective_route,
            classification_source, classification_confidence, classification_score,
            classification_reason_codes, purpose, internal_operation_type,
            single_failover_used, cached_tokens_in)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [
        record.request_id,
        record.route_code,
        record.user_id,
        record.agent_id,
        record.primary_provider_id,
        record.actual_provider_id,
        record.model,
        record.started_at,
        record.latency_ms,
        record.attempts,
        record.switches,
        record.succeeded,
        record.error_code,
        record.switch_reason,
        record.error_summary?.slice(0, 500) ?? null,
        record.http_status,
        record.tokens_in,
        record.tokens_out,
        record.cost_micro,
        record.tool_calls,
        record.streamed,
        record.routing_mode,
        record.requested_route,
        record.effective_route,
        record.classification_source,
        record.classification_confidence,
        record.classification_score,
        record.classification_reason_codes,
        record.purpose,
        record.internal_operation_type,
        record.single_failover_used,
        record.cached_tokens_in,
      ],
    );
    });
    // Наблюдатель зовётся после записи и в try: телеметрия не имеет
    // права отменить уже зафиксированный факт обращения к модели.
    try {
      this.observer?.(record);
    } catch {
      // Молча: отказ наблюдателя — это потеря телеметрии, не более.
    }
  }
}

/**
 * Стоимость ответа в микроединицах валюты провайдера.
 *
 * Кэшированный вход считается отдельной ставкой: у провайдеров он стоит
 * от четверти до десятой доли обычного, и без этого разделения тёплый
 * ход выглядел в журнале так же дорого, как холодный. Ставка не
 * задана — весь вход идёт по обычной цене: завысить оценку безопаснее,
 * чем показать экономию, которой не было.
 */
export function costOf(provider: ProviderProfile, response: LlmResponse): number {
  const cached = Math.min(
    Math.max(response.usage.cached_tokens_in ?? 0, 0),
    response.usage.tokens_in,
  );
  const cachedRate = provider.price_cached_in_micro ?? provider.price_in_micro;
  const input = ((response.usage.tokens_in - cached) * provider.price_in_micro
    + cached * cachedRate) / 1_000_000;
  const output = (response.usage.tokens_out * provider.price_out_micro) / 1_000_000;
  return Math.round(input + output);
}

/** Пользователь в журнале — числовой id, а не Telegram-профиль. */
export function userIdOf(request: LlmRequest): string | null {
  const raw = request.metadata.user_id;
  return raw && /^\d+$/.test(raw) ? raw : null;
}
