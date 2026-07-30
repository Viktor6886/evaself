-- =====================================================================
-- LLM Router, часть 3 из 3: телеметрия, расходы, circuit breaker.
--
-- Здесь нет и не должно быть текста переписки. Требование 1.10: в
-- технические логи попадают только обезличенные метаданные и сокращённое
-- описание ошибки. Поэтому таблица хранит счётчики токенов, коды и
-- причины переключения, но ни одного сообщения пользователя.
--
-- Состояние breaker'а лежит в PostgreSQL, а не только в памяти процесса:
-- роутер может быть перезапущен или запущен в нескольких репликах, и
-- открытый breaker не должен закрываться сам собой от рестарта.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Журнал запросов
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_requests (
    id                    bigserial   PRIMARY KEY,
    request_id            uuid        NOT NULL,
    route_code            text        NOT NULL,
    user_id               bigint      REFERENCES users (id) ON DELETE SET NULL,
    agent_id              text,

    -- «Основной» — голова цепочки, «фактический» — кто в итоге ответил.
    primary_provider_id   uuid        REFERENCES llm_providers (id) ON DELETE SET NULL,
    actual_provider_id    uuid        REFERENCES llm_providers (id) ON DELETE SET NULL,
    model                 text,

    started_at            timestamptz NOT NULL DEFAULT now(),
    finished_at           timestamptz,
    latency_ms            integer,
    attempts              smallint    NOT NULL DEFAULT 1,
    switches              smallint    NOT NULL DEFAULT 0,

    succeeded             boolean     NOT NULL DEFAULT false,
    error_code            text,
    -- Причина переключения из фиксированного словаря, не свободный текст.
    switch_reason         text,
    -- Сокращённое описание ошибки провайдера, обрезается на 500 символах.
    error_summary         text,
    http_status           integer,

    tokens_in             integer     NOT NULL DEFAULT 0,
    tokens_out            integer     NOT NULL DEFAULT 0,
    cost_micro            bigint      NOT NULL DEFAULT 0,
    tool_calls            smallint    NOT NULL DEFAULT 0,
    streamed              boolean     NOT NULL DEFAULT false,

    CONSTRAINT llm_requests_error_summary_len CHECK (char_length(error_summary) <= 500),
    CONSTRAINT llm_requests_switch_reason_check CHECK (
        switch_reason IS NULL OR switch_reason IN (
            'rate_limited',        -- HTTP 429
            'server_error',        -- HTTP 5xx
            'connection_failed',   -- соединение или DNS
            'timeout',
            'empty_response',
            'invalid_response',
            'model_error',
            'quota_exhausted',
            'budget_exceeded',
            'json_contract_failed',
            'tool_calls_failed',
            'latency_exceeded',
            'breaker_open',
            'incompatible'
        )
    )
);

-- Один запрос пользователя — одна запись на попытку провайдера; общий
-- request_id связывает их между собой (требование 1.8).
CREATE INDEX IF NOT EXISTS llm_requests_request_id_idx ON llm_requests (request_id);
CREATE INDEX IF NOT EXISTS llm_requests_started_idx ON llm_requests (started_at DESC);
CREATE INDEX IF NOT EXISTS llm_requests_provider_idx
    ON llm_requests (actual_provider_id, started_at DESC);
CREATE INDEX IF NOT EXISTS llm_requests_failures_idx
    ON llm_requests (started_at DESC)
    WHERE NOT succeeded;

-- ---------------------------------------------------------------------
-- Расходы: агрегат по провайдеру и периоду
-- ---------------------------------------------------------------------
-- Считается по датам в UTC. period_start пишется как date, а не как
-- timestamptz из new Date(y, m, 1) — иначе часовой пояс процесса сдвигает
-- границу месяца на сутки назад.
CREATE TABLE IF NOT EXISTS llm_spend_ledger (
    provider_id   uuid        NOT NULL REFERENCES llm_providers (id) ON DELETE CASCADE,
    period        text        NOT NULL,
    period_start  date        NOT NULL,
    tokens_in     bigint      NOT NULL DEFAULT 0,
    tokens_out    bigint      NOT NULL DEFAULT 0,
    requests      bigint      NOT NULL DEFAULT 0,
    cost_micro    bigint      NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, period, period_start),
    CONSTRAINT llm_spend_ledger_period_check CHECK (period IN ('day', 'month'))
);

CREATE INDEX IF NOT EXISTS llm_spend_ledger_period_idx
    ON llm_spend_ledger (period, period_start DESC);

-- ---------------------------------------------------------------------
-- Circuit breaker
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_breaker_state (
    provider_id        uuid        PRIMARY KEY REFERENCES llm_providers (id) ON DELETE CASCADE,
    state              text        NOT NULL DEFAULT 'closed',
    consecutive_errors smallint    NOT NULL DEFAULT 0,
    first_error_at     timestamptz,
    opened_at          timestamptz,
    -- Раньше этого момента тестовый запрос не отправляется.
    probe_after        timestamptz,
    last_error_code    text,
    last_success_at    timestamptz,
    -- Ручная фиксация: администратор отключил автовозврат на провайдера.
    pinned_out         boolean     NOT NULL DEFAULT false,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_breaker_state_check CHECK (state IN ('closed', 'open', 'half_open'))
);

DROP TRIGGER IF EXISTS trg_llm_breaker_state_updated_at ON llm_breaker_state;
CREATE TRIGGER trg_llm_breaker_state_updated_at
    BEFORE UPDATE ON llm_breaker_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Сводка для админ-панели
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_llm_provider_health AS
SELECT p.id,
       p.name,
       p.enabled,
       p.priority,
       p.model,
       COALESCE(b.state, 'closed')          AS breaker_state,
       b.opened_at,
       b.probe_after,
       b.pinned_out,
       b.last_error_code,
       b.last_success_at,
       day.cost_micro                        AS spent_today_micro,
       p.daily_budget_micro,
       month.cost_micro                      AS spent_month_micro,
       p.monthly_budget_micro,
       recent.requests                       AS requests_1h,
       recent.failures                       AS failures_1h,
       recent.p95_latency_ms
  FROM llm_providers p
  LEFT JOIN llm_breaker_state b ON b.provider_id = p.id
  LEFT JOIN llm_spend_ledger day
         ON day.provider_id = p.id
        AND day.period = 'day'
        AND day.period_start = (now() AT TIME ZONE 'UTC')::date
  LEFT JOIN llm_spend_ledger month
         ON month.provider_id = p.id
        AND month.period = 'month'
        AND month.period_start = date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date
  LEFT JOIN LATERAL (
      SELECT count(*)                                          AS requests,
             count(*) FILTER (WHERE NOT succeeded)              AS failures,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
        FROM llm_requests
       WHERE actual_provider_id = p.id
         AND started_at > now() - interval '1 hour'
  ) recent ON true;

INSERT INTO schema_migrations (version) VALUES ('019_llm_router_telemetry')
ON CONFLICT (version) DO NOTHING;

COMMIT;
