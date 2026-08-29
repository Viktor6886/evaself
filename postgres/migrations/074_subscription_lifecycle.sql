-- Безопасный жизненный цикл подписки: один checkout, смешанные квоты
-- при повышении тарифа и read-only снимок фактического права доступа.

BEGIN;

-- После pre-checkout новый счёт нельзя подменить другим, пока Telegram
-- завершает списание. Старые установки получают NULL и остаются совместимы.
ALTER TABLE payment_intents
    ADD COLUMN IF NOT EXISTS prechecked_at timestamptz;

-- Уникальный индекс на pending intent здесь намеренно не ставится:
-- миграция применяется раньше контейнера, а прежняя версия ещё могла
-- создавать несколько счетов. Новая версия сериализует invoice и
-- pre-checkout блокировкой строки users и закрывает лишние intents внутри
-- той же транзакции, поэтому rolling deploy остаётся совместимым.

-- Один активный subscription остаётся источником права доступа, но его
-- лимиты могут быть средневзвешенной смесью старого и нового тарифа.
-- Отдельные строки нужны по каждой метрике: JSON скрыл бы типы и не дал
-- схеме проверить отрицательные значения и уникальность.
CREATE TABLE IF NOT EXISTS subscription_quota_limits (
    subscription_id bigint NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
    user_id          bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    metric           text   NOT NULL,
    period           text   NOT NULL,
    limit_value      bigint NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subscription_id, metric, period),
    CONSTRAINT subscription_quota_limits_period_check
        CHECK (period IN ('day', 'week', 'month', 'total')),
    CONSTRAINT subscription_quota_limits_value_check CHECK (limit_value >= -1)
);

CREATE INDEX IF NOT EXISTS subscription_quota_limits_user_idx
    ON subscription_quota_limits (user_id, subscription_id);

COMMENT ON TABLE subscription_quota_limits IS
    'Снимок средневзвешенных квот конкретной оплаченной подписки при смене тарифа.';

-- Квота активной подписки сначала берётся из её снимка, а при обычной
-- покупке — из тарифа. Пробная подписка по-прежнему использует free_value.
CREATE OR REPLACE VIEW v_quota_status AS
SELECT
    u.id                     AS user_id,
    u.telegram_id,
    COALESCE(s.plan, 'free') AS plan,
    q.metric,
    q.period,
    CASE
        WHEN s.status = 'trialing' THEN q.free_value
        ELSE COALESCE(sq.limit_value, q.limit_value)
    END                      AS limit_value,
    COALESCE(c.used, 0)      AS used,
    CASE
        WHEN (CASE
                WHEN s.status = 'trialing' THEN q.free_value
                ELSE COALESCE(sq.limit_value, q.limit_value)
              END) < 0
            THEN NULL
        ELSE GREATEST(
            (CASE
               WHEN s.status = 'trialing' THEN q.free_value
               ELSE COALESCE(sq.limit_value, q.limit_value)
             END) - COALESCE(c.used, 0),
            0
        )
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
          END;

COMMENT ON VIEW v_quota_status IS
    'Право доступа: пробная квота, тарифная квота либо средневзвешенный снимок оплаченного апгрейда.';

INSERT INTO schema_migrations (version)
VALUES ('074_subscription_lifecycle')
ON CONFLICT DO NOTHING;

COMMIT;
