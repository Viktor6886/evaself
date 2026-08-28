-- Откат 072: представление возвращается к прежнему виду, проверка снимается.
--
-- Строки не уничтожаются: платежи в звёздах остаются на месте, просто
-- перестают отличаться от прочих проверкой валюты, а `free_value`
-- снова ничего не решает — колонка при этом сохраняется.

BEGIN;

ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS payments_stars_whole_check;

CREATE OR REPLACE VIEW v_quota_status AS
SELECT
    u.id                     AS user_id,
    u.telegram_id,
    COALESCE(s.plan, 'free') AS plan,
    q.metric,
    q.period,
    q.limit_value,
    COALESCE(c.used, 0)      AS used,
    CASE
        WHEN q.limit_value < 0 THEN NULL
        ELSE GREATEST(q.limit_value - COALESCE(c.used, 0), 0)
    END                      AS remaining
FROM users u
LEFT JOIN LATERAL (
    SELECT plan FROM subscriptions
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

DELETE FROM schema_migrations WHERE version = '072_telegram_stars';

COMMIT;
