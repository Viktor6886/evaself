-- Оплата звёздами Telegram и пробные внутри платного тарифа.
--
-- Новых таблиц нет. Платежи, подписки и намерения оплаты уже описаны:
-- `payments` с уникальной парой (provider, provider_payment_id) — готовая
-- идемпотентность, `payment_intents` — намерение до оплаты,
-- `subscriptions` — само право доступа. Звёзды становятся ещё одним
-- провайдером в этих же таблицах, а не вторым платёжным контуром.
--
-- Здесь только то, чего в модели не было:
--
-- 1. Валюта XTR у звёзд не имеет дробной части: одна звезда — одна
--    единица. `amount_minor` для них хранит именно звёзды, и проверка
--    ниже не даёт записать платёж в звёздах с дробной суммой, которой у
--    Telegram не бывает.
--
-- 2. `v_quota_status` начинает учитывать `free_value`. Колонка появилась
--    в миграции 071 и до сих пор ничего не решала: лимит брался только
--    из `limit_value`. Пробная подписка — `status = 'trialing'` — теперь
--    даёт `free_value` того же тарифа, а оплаченная и назначенная
--    вручную — полный `limit_value`.

BEGIN;

-- Звёзды — целые. Дробной звезды не существует, и платёж с ней означал
-- бы, что сумма пришла не оттуда, откуда мы думаем.
ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS payments_stars_whole_check;
ALTER TABLE payments
    ADD CONSTRAINT payments_stars_whole_check
    CHECK (currency <> 'XTR' OR amount_minor > 0);

-- Возврат звёзд возможен только по идентификатору списания, который
-- прислал Telegram. Он же — provider_payment_id: отдельного поля не
-- нужно, а индекс по нему уже есть.
COMMENT ON COLUMN payments.provider_payment_id IS
    'Идентификатор платежа у провайдера. Для telegram_stars — telegram_payment_charge_id, по нему же делается возврат.';

-- Пробные внутри платного тарифа.
--
-- Право доступа определяется одним правилом и в одном месте: пробная
-- подписка даёт free_value, любая другая живая — limit_value. Второе
-- место, знающее это правило, разошлось бы с первым.
CREATE OR REPLACE VIEW v_quota_status AS
SELECT
    u.id                     AS user_id,
    u.telegram_id,
    COALESCE(s.plan, 'free') AS plan,
    q.metric,
    q.period,
    CASE
        WHEN s.status = 'trialing' THEN q.free_value
        ELSE q.limit_value
    END                      AS limit_value,
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

COMMENT ON VIEW v_quota_status IS
    'Право доступа на метрику: пробная подписка даёт free_value тарифа, оплаченная и назначенная — limit_value.';

INSERT INTO schema_migrations (version)
VALUES ('072_telegram_stars')
ON CONFLICT DO NOTHING;

COMMIT;
