BEGIN;

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
            WHEN 'day'   THEN CURRENT_DATE
            WHEN 'week'  THEN date_trunc('week',  CURRENT_DATE)::date
            WHEN 'month' THEN date_trunc('month', CURRENT_DATE)::date
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
    'Право доступа: пробная, тарифная или смешанная квота; безлимит нового тарифа начинается после сохранённых старых дней.';

DELETE FROM schema_migrations WHERE version = '075_quota_periods_utc';

COMMIT;
