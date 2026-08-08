-- Real PostgreSQL check: priority can overtake the queue, while messages
-- within one chat remain ordered across worker replicas.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO telegram_outbox (idempotency_key, chat_id, telegram_method, payload, priority)
VALUES
    ('step06:100:1', 100, 'sendMessage',    '{}'::jsonb, 20),
    ('step06:100:2', 100, 'sendMessage',    '{}'::jsonb, 20),
    ('step06:100:3', 100, 'sendMessage',    '{}'::jsonb, 20),
    ('step06:100:s', 100, 'sendChatAction', '{}'::jsonb, 50),
    ('step06:100:k', 100, 'sendMessage',    '{}'::jsonb, 10),
    ('step06:200:1', 200, 'sendMessage',    '{}'::jsonb, 20)
ON CONFLICT (idempotency_key) DO UPDATE SET
    status = 'pending', attempts = 0, available_at = now(),
    locked_at = NULL, locked_by = NULL, priority = EXCLUDED.priority;

CREATE TEMP VIEW claimable AS
SELECT t.id, t.chat_id, t.priority, t.idempotency_key
  FROM telegram_outbox t
 WHERE t.attempts < 5
   AND t.status IN ('pending', 'retry')
   AND t.available_at <= now()
   AND NOT (t.chat_id = ANY(ARRAY[]::bigint[]))
   AND NOT EXISTS (
     SELECT 1 FROM telegram_outbox earlier
      WHERE earlier.chat_id = t.chat_id
        AND earlier.status IN ('pending', 'sending', 'retry')
        AND (earlier.priority, earlier.id) < (t.priority, t.id)
   )
 ORDER BY t.priority, t.available_at, t.id;

DO $$
DECLARE picked text[];
BEGIN
    SELECT array_agg(idempotency_key ORDER BY priority, id) INTO picked FROM claimable;
    IF picked <> ARRAY['step06:100:k', 'step06:200:1'] THEN
        RAISE EXCEPTION 'priority/per-chat claim returned %', picked;
    END IF;
END $$;

UPDATE telegram_outbox SET status = 'sent' WHERE idempotency_key = 'step06:100:k';

DO $$
DECLARE next_key text;
BEGIN
    SELECT idempotency_key INTO next_key FROM claimable WHERE chat_id = 100;
    IF next_key <> 'step06:100:1' THEN
        RAISE EXCEPTION 'order within chat was violated: %', next_key;
    END IF;
END $$;

UPDATE telegram_outbox SET status = 'sending' WHERE idempotency_key = 'step06:100:1';

DO $$
DECLARE blocked bigint;
BEGIN
    SELECT count(*) INTO blocked FROM claimable WHERE chat_id = 100;
    IF blocked <> 0 THEN
        RAISE EXCEPTION 'second chat message was claimable before the first completed';
    END IF;
END $$;

UPDATE telegram_outbox SET status = 'sent'
 WHERE idempotency_key IN ('step06:100:1', 'step06:100:2', 'step06:100:3');

DO $$
DECLARE last_key text;
BEGIN
    SELECT idempotency_key INTO last_key FROM claimable WHERE chat_id = 100;
    IF last_key <> 'step06:100:s' THEN
        RAISE EXCEPTION 'service status was not last: %', last_key;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'telegram_outbox_priority_idx' AND i.indisvalid
    ) THEN
        RAISE EXCEPTION 'telegram_outbox_priority_idx is absent or invalid';
    END IF;
END $$;

ROLLBACK;
