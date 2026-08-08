\set ON_ERROR_STOP on

BEGIN;

INSERT INTO telegram_outbox
    (idempotency_key, chat_id, telegram_method, payload, priority)
VALUES
    ('ci-outbox-service', 1, 'sendMessage', '{}'::jsonb, 40),
    ('ci-outbox-reminder', 2, 'sendMessage', '{}'::jsonb, 30),
    ('ci-outbox-payment', 3, 'sendMessage', '{}'::jsonb, 20),
    ('ci-outbox-answer', 4, 'sendMessage', '{}'::jsonb, 10),
    ('ci-outbox-crisis', 5, 'sendMessage', '{}'::jsonb, 0)
ON CONFLICT (idempotency_key) DO UPDATE SET
    status = 'pending', attempts = 0, available_at = now(),
    locked_at = NULL, locked_by = NULL, priority = EXCLUDED.priority;

CREATE TEMP TABLE claimed(priority smallint);
WITH candidates AS (
    SELECT id
      FROM telegram_outbox
     WHERE attempts < 8
       AND status IN ('pending', 'retry')
       AND available_at <= now()
     ORDER BY priority, available_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 3
), updated AS (
    UPDATE telegram_outbox o
       SET status = 'sending', attempts = attempts + 1,
           locked_at = now(), locked_by = 'ci-worker'
      FROM candidates c
     WHERE o.id = c.id
 RETURNING o.priority
)
INSERT INTO claimed SELECT priority FROM updated;

DO $$
DECLARE actual smallint[];
BEGIN
    SELECT array_agg(priority ORDER BY priority) INTO actual FROM claimed;
    IF actual <> ARRAY[0, 10, 20]::smallint[] THEN
        RAISE EXCEPTION 'priority claim returned %, expected {0,10,20}', actual;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'telegram_outbox_priority_claim_idx' AND i.indisvalid
    ) THEN
        RAISE EXCEPTION 'telegram_outbox_priority_claim_idx is absent or invalid';
    END IF;
END $$;

ROLLBACK;
