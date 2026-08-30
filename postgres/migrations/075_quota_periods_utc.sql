BEGIN;

-- Сервис Евы может работать в пользовательском TZ, а PostgreSQL — в UTC.
-- Начало каждого периода должно определяться одинаково с записью расхода:
-- прежний CURRENT_DATE и локальный JS-конструктор месяца расходились на
-- границе месяца и прятали месячный расход от этого представления.
-- Триггер ставится до переноса: пока updater ещё не пересоздал старый
-- eva-agent-service, его поздняя запись тоже нормализуется и не потеряется.
CREATE OR REPLACE FUNCTION normalize_usage_counter_period_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.period = 'month'
       AND NEW.period_start <> date_trunc('month', NEW.period_start)::date THEN
        NEW.period_start := date_trunc(
            'month', NEW.period_start + INTERVAL '1 day'
        )::date;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_usage_counter_period_start_trigger
    ON usage_counters;
CREATE TRIGGER normalize_usage_counter_period_start_trigger
BEFORE INSERT OR UPDATE OF period, period_start ON usage_counters
FOR EACH ROW EXECUTE FUNCTION normalize_usage_counter_period_start();

COMMENT ON FUNCTION normalize_usage_counter_period_start() IS
    'Защищает границы месячных квот при обновлении со старого writer в локальном TZ.';

-- Уже накопленные строки вида 2026-07-31 → август сначала переносим и
-- складываем с корректной строкой, если после hotfix она уже появилась.
WITH misplaced AS (
    DELETE FROM usage_counters
     WHERE period = 'month'
       AND period_start <> date_trunc('month', period_start)::date
    RETURNING user_id, metric, used, period_start, updated_at
)
INSERT INTO usage_counters (user_id, metric, period, period_start, used, updated_at)
SELECT user_id,
       metric,
       'month',
       date_trunc('month', period_start + INTERVAL '1 day')::date,
       SUM(used),
       MAX(updated_at)
  FROM misplaced
 GROUP BY user_id, metric, date_trunc('month', period_start + INTERVAL '1 day')::date
ON CONFLICT (user_id, metric, period, period_start) DO UPDATE
      SET used = usage_counters.used + EXCLUDED.used,
          updated_at = GREATEST(usage_counters.updated_at, EXCLUDED.updated_at);

CREATE OR REPLACE VIEW v_quota_status AS
SELECT
    u.id                     AS user_id,
    u.telegram_id,
    COALESCE(s.plan, 'free') AS plan,
    q.metric,
    q.period,
    effective.limit_value,
    COALESCE(c.used, 0)      AS used,
    CASE
        WHEN effective.limit_value < 0
            THEN NULL
        ELSE GREATEST(effective.limit_value - COALESCE(c.used, 0), 0)
    END                      AS remaining
FROM users u
LEFT JOIN LATERAL (
    SELECT id, plan, status FROM subscriptions
    WHERE user_id = u.id AND status IN ('trialing', 'active', 'past_due')
      AND (current_period_end IS NULL OR current_period_end > now())
    ORDER BY created_at DESC LIMIT 1
) s ON true
JOIN quotas q ON q.plan = COALESCE(s.plan, 'free')
LEFT JOIN subscription_quota_limits sq
       ON sq.subscription_id = s.id
      AND sq.user_id = u.id
      AND sq.metric = q.metric
      AND sq.period = q.period
LEFT JOIN usage_counters c
       ON c.user_id = u.id
      AND c.metric  = q.metric
      AND c.period  = q.period
      AND c.period_start = CASE q.period
            WHEN 'day'   THEN (now() AT TIME ZONE 'UTC')::date
            WHEN 'week'  THEN date_trunc('week',  (now() AT TIME ZONE 'UTC')::date)::date
            WHEN 'month' THEN date_trunc('month', (now() AT TIME ZONE 'UTC')::date)::date
            ELSE DATE '1970-01-01'
          END
CROSS JOIN LATERAL (
    SELECT CASE
        WHEN s.status = 'trialing' THEN q.free_value
        WHEN sq.unlimited_from IS NOT NULL AND sq.unlimited_from <= now() THEN -1
        ELSE COALESCE(sq.limit_value, q.limit_value)
    END AS limit_value
) effective;

COMMENT ON VIEW v_quota_status IS
    'Право доступа и расход квот; сутки, неделя и месяц считаются по единой границе UTC.';

INSERT INTO schema_migrations (version)
VALUES ('075_quota_periods_utc')
ON CONFLICT DO NOTHING;

COMMIT;
