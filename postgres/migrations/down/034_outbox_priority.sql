-- =====================================================================
-- Откат 034.
--
-- Колонки не удаляются: `DROP COLUMN` уничтожает значения, а правило
-- «down-миграция не уничтожает исходные строки» распространяется и на
-- столбцы. Снимаются только индексы и ограничение — после отката
-- очередь снова разбирается в порядке поступления, как до 034.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS telegram_outbox_priority_idx;
DROP INDEX IF EXISTS telegram_outbox_chat_pending_idx;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_priority_check;

-- Stop the view from referencing the model column before reverting the key.
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
       day.cost_micro                       AS spent_today_micro,
       p.daily_budget_micro,
       month.cost_micro                     AS spent_month_micro,
       p.monthly_budget_micro,
       recent.requests                      AS requests_1h,
       recent.failures                      AS failures_1h,
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
      SELECT count(*) AS requests,
             count(*) FILTER (WHERE NOT succeeded) AS failures,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
        FROM llm_requests
       WHERE actual_provider_id = p.id
         AND started_at > now() - interval '1 hour'
  ) recent ON true;

-- A profile has one current model. Keep that operational row when reverting
-- to the pre-034 provider-only key; stale model breaker rows can be rebuilt.
DELETE FROM llm_breaker_state b
 WHERE NOT EXISTS (
     SELECT 1 FROM llm_providers p
      WHERE p.id = b.provider_id AND p.model = b.model
 );

ALTER TABLE llm_breaker_state DROP CONSTRAINT llm_breaker_state_pkey;
ALTER TABLE llm_breaker_state ADD PRIMARY KEY (provider_id);
ALTER TABLE llm_breaker_state DROP COLUMN model;

COMMENT ON COLUMN telegram_outbox.priority IS
    'Не используется: миграция 034 откачена. Столбец сохранён, чтобы не потерять значения.';

DELETE FROM schema_migrations WHERE version = '034_outbox_priority';

COMMIT;
