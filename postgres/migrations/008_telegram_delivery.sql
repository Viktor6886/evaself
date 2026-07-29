-- =====================================================================
-- Надёжная доставка Telegram: durable inbox и transactional outbox
-- =====================================================================

BEGIN;

ALTER TABLE telegram_updates
    ADD COLUMN IF NOT EXISTS payload jsonb,
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS locked_at timestamptz,
    ADD COLUMN IF NOT EXISTS locked_by text,
    ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE telegram_updates
    ALTER COLUMN status SET DEFAULT 'queued';

UPDATE telegram_updates
   SET status = CASE status
       WHEN 'failed' THEN 'retry'
       WHEN 'processing' THEN 'retry'
       ELSE status
   END,
       available_at = now(),
       locked_at = NULL,
       locked_by = NULL
 WHERE status IN ('failed', 'processing');

ALTER TABLE telegram_updates
    DROP CONSTRAINT IF EXISTS telegram_updates_status_check;
ALTER TABLE telegram_updates
    ADD CONSTRAINT telegram_updates_status_check
        CHECK (status IN (
            'queued', 'processing', 'completed', 'ignored', 'retry', 'dead'
        ));

CREATE INDEX IF NOT EXISTS telegram_updates_delivery_idx
    ON telegram_updates (status, available_at, received_at)
    WHERE status IN ('queued', 'processing', 'retry');

CREATE TABLE IF NOT EXISTS telegram_outbox (
    id                    bigserial PRIMARY KEY,
    idempotency_key       text NOT NULL UNIQUE,
    user_id               bigint REFERENCES users (id) ON DELETE SET NULL,
    chat_id               bigint NOT NULL,
    telegram_method       text NOT NULL,
    payload               jsonb NOT NULL,
    status                text NOT NULL DEFAULT 'pending',
    attempts              integer NOT NULL DEFAULT 0,
    available_at          timestamptz NOT NULL DEFAULT now(),
    locked_at             timestamptz,
    locked_by             text,
    telegram_message_ids  bigint[] NOT NULL DEFAULT ARRAY[]::bigint[],
    last_error            text,
    sent_at               timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT telegram_outbox_status_check
        CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'dead'))
);

CREATE INDEX IF NOT EXISTS telegram_outbox_delivery_idx
    ON telegram_outbox (status, available_at, id)
    WHERE status IN ('pending', 'sending', 'retry');
CREATE INDEX IF NOT EXISTS telegram_outbox_user_idx
    ON telegram_outbox (user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_telegram_outbox_updated_at ON telegram_outbox;
CREATE TRIGGER trg_telegram_outbox_updated_at
    BEFORE UPDATE ON telegram_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('008_telegram_delivery')
ON CONFLICT (version) DO NOTHING;

COMMIT;
