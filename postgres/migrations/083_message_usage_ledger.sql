BEGIN;

-- Единый идемпотентный журнал сообщений, расходующих тарифные метрики.
--
-- usage_counters остаётся быстрым агрегатом для квот и панели. Эта таблица
-- отвечает на другой вопрос: какое конкретно сообщение дало единицу расхода.
-- Уникальный idempotency_key не позволяет durable retry, повторному запуску
-- планировщика или двум репликам сервиса списать одно сообщение дважды.
CREATE TABLE IF NOT EXISTS usage_events (
    id              bigserial PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    metric          text        NOT NULL,
    source          text        NOT NULL,
    amount          bigint      NOT NULL,
    unit            text        NOT NULL DEFAULT 'message',
    correlation_id  text,
    idempotency_key text        NOT NULL,
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usage_events_amount_check CHECK (amount <> 0),
    CONSTRAINT usage_events_unit_check CHECK (unit <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_uidx
    ON usage_events (idempotency_key);
CREATE INDEX IF NOT EXISTS usage_events_user_created_idx
    ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_metric_created_idx
    ON usage_events (metric, created_at DESC);

COMMENT ON TABLE usage_events IS
    'Неизменяемый журнал единиц расхода; usage_counters — агрегат для быстрых квот.';
COMMENT ON COLUMN usage_events.source IS
    'Источник расхода: telegram_user, assistant_reply, scheduled_task, heartbeat, proactive и т.п.';
COMMENT ON COLUMN usage_events.idempotency_key IS
    'Стабильный ключ исходного сообщения/слота; повторная обработка не создаёт второй расход.';

INSERT INTO schema_migrations (version)
VALUES ('083_message_usage_ledger')
ON CONFLICT DO NOTHING;

COMMIT;
