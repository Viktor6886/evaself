BEGIN;

-- Сначала убрать зависимость view от снимков, затем удалить таблицу.
CREATE OR REPLACE VIEW v_quota_status AS
SELECT
    u.id                     AS user_id,
    u.telegram_id,
    COALESCE(s.plan, 'free') AS plan,
    q.metric,
    q.period,
    CASE WHEN s.status = 'trialing' THEN q.free_value ELSE q.limit_value END AS limit_value,
    COALESCE(c.used, 0)      AS used,
    CASE
        WHEN (CASE WHEN s.status = 'trialing' THEN q.free_value ELSE q.limit_value END) < 0
            THEN NULL
        ELSE GREATEST(
            (CASE WHEN s.status = 'trialing' THEN q.free_value ELSE q.limit_value END)
            - COALESCE(c.used, 0), 0)
    END                      AS remaining
FROM users u
LEFT JOIN LATERAL (
    SELECT plan, status FROM subscriptions
    WHERE user_id = u.id AND status IN ('trialing', 'active', 'past_due')
    ORDER BY created_at DESC LIMIT 1
) s ON true
JOIN quotas q ON q.plan = COALESCE(s.plan, 'free')
LEFT JOIN usage_counters c
       ON c.user_id = u.id
      AND c.metric  = q.metric
      AND c.period  = q.period
      AND c.period_start = CASE q.period
            WHEN 'day'   THEN CURRENT_DATE
            WHEN 'week'  THEN date_trunc('week',  CURRENT_DATE)::date
            WHEN 'month' THEN date_trunc('month', CURRENT_DATE)::date
            ELSE DATE '1970-01-01'
          END;

DROP TABLE IF EXISTS subscription_quota_limits;
ALTER TABLE payment_intents DROP COLUMN IF EXISTS prechecked_at;
DELETE FROM schema_migrations WHERE version = '074_subscription_lifecycle';

COMMIT;
