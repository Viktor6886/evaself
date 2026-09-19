-- Точный учёт автоматически отправляемых сообщений.
--
-- Входящие сообщения уже имеют идемпотентный флаг usage_charged в
-- telegram_updates. Для исходящей durable delivery такого маркера не было:
-- task/reminder мог иметь user_id и устойчивый idempotency_key, но после
-- успешной доставки никак не связывался с usage_counters.
--
-- Метаданные тарификации лежат на самой строке outbox: это канонический
-- факт доставки и уже существующий ключ идемпотентности. Нового журнала
-- сообщений и копии переписки не создаётся.

BEGIN;

ALTER TABLE telegram_outbox
    ADD COLUMN IF NOT EXISTS usage_metric text,
    ADD COLUMN IF NOT EXISTS usage_amount bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS usage_charged boolean NOT NULL DEFAULT false;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_usage_amount_check;
ALTER TABLE telegram_outbox
    ADD CONSTRAINT telegram_outbox_usage_amount_check CHECK (
        (usage_metric IS NULL AND usage_amount = 0)
        OR (usage_metric IS NOT NULL AND usage_amount > 0)
    );

COMMENT ON COLUMN telegram_outbox.usage_metric IS
    'Тарифная метрика, которую списать один раз после успешной доставки; NULL — служебное сообщение.';
COMMENT ON COLUMN telegram_outbox.usage_amount IS
    'Количество единиц usage_metric за эту логическую доставку.';
COMMENT ON COLUMN telegram_outbox.usage_charged IS
    'Идемпотентный маркер переноса доставленного сообщения в usage_counters.';

INSERT INTO schema_migrations (version)
VALUES ('083_message_usage_accounting')
ON CONFLICT DO NOTHING;

COMMIT;
