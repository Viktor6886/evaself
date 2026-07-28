-- =====================================================================
-- Evaself — default plans, quotas and the reporting views NocoDB shows
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Default quota matrix.
-- limit_value = -1 means "unlimited".
-- Metrics are the names eva-agent-service / n8n increment in usage_counters.
-- ---------------------------------------------------------------------
INSERT INTO quotas (plan, metric, period, limit_value, description) VALUES
    ('free',    'messages',      'day',   30,   'Messages to Eva per day'),
    ('free',    'voice_minutes', 'day',   5,    'Minutes of voice transcription per day'),
    ('free',    'web_search',    'day',   10,   'Web searches per day'),
    ('free',    'tests',         'month', 2,    'Self-discovery tests per month'),
    ('plus',    'messages',      'day',   200,  'Messages to Eva per day'),
    ('plus',    'voice_minutes', 'day',   60,   'Minutes of voice transcription per day'),
    ('plus',    'web_search',    'day',   100,  'Web searches per day'),
    ('plus',    'tests',         'month', 20,   'Self-discovery tests per month'),
    ('pro',     'messages',      'day',   -1,   'Unlimited messages'),
    ('pro',     'voice_minutes', 'day',   300,  'Minutes of voice transcription per day'),
    ('pro',     'web_search',    'day',   -1,   'Unlimited web searches'),
    ('pro',     'tests',         'month', -1,   'Unlimited tests')
ON CONFLICT (plan, metric, period) DO NOTHING;

-- ---------------------------------------------------------------------
-- v_user_overview — the table an operator actually wants to look at.
-- ---------------------------------------------------------------------
-- Migration 003 добавляет в представление столбцы conversation/runtime.
-- При повторном последовательном прогоне сначала восстанавливаем форму 002,
-- после чего 003 снова безопасно расширит её. CREATE OR REPLACE не умеет
-- удалять или переставлять уже существующие столбцы представления.
DROP VIEW IF EXISTS v_user_overview;
CREATE VIEW v_user_overview AS
SELECT
    u.id,
    u.telegram_id,
    u.username,
    u.first_name,
    u.state,
    u.is_blocked,
    u.language_code,
    u.timezone,
    COALESCE(s.plan, 'free')            AS plan,
    COALESCE(s.status, 'none')          AS subscription_status,
    s.current_period_end,
    a.agent_id                          AS letta_agent_id,
    a.message_count,
    a.last_message_at,
    u.created_at,
    u.last_seen_at
FROM users u
LEFT JOIN LATERAL (
    SELECT * FROM subscriptions
    WHERE user_id = u.id AND status IN ('trialing', 'active', 'past_due')
    ORDER BY created_at DESC LIMIT 1
) s ON true
LEFT JOIN LATERAL (
    SELECT * FROM agent_links
    WHERE user_id = u.id AND kind = 'eva' AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
) a ON true;

-- ---------------------------------------------------------------------
-- v_quota_status — today's consumption against the user's plan.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- v_revenue_monthly — succeeded payments grouped by month.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_revenue_monthly AS
SELECT
    date_trunc('month', COALESCE(paid_at, created_at))::date AS month,
    currency,
    count(*)                       AS payments,
    sum(amount_minor)              AS amount_minor,
    round(sum(amount_minor) / 100.0, 2) AS amount
FROM payments
WHERE status = 'succeeded'
GROUP BY 1, 2
ORDER BY 1 DESC;

-- ---------------------------------------------------------------------
-- v_crisis_open — unhandled safety events, newest first.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_crisis_open AS
SELECT
    e.id, e.created_at, e.severity, e.detected_by,
    u.telegram_id, u.username, e.trigger_text, e.notes
FROM crisis_events e
JOIN users u ON u.id = e.user_id
WHERE e.handled = false
ORDER BY
    CASE e.severity
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'medium'   THEN 2 ELSE 3
    END,
    e.created_at DESC;

INSERT INTO schema_migrations (version) VALUES ('002_seed_and_views')
ON CONFLICT (version) DO NOTHING;

COMMIT;
