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

-- Execute the production locking shape, not just its predicate. The UPDATE
-- proves rows returned by FOR UPDATE SKIP LOCKED can be atomically leased as
-- a bounded batch. Roll back to the savepoint so ordering checks start clean.
SAVEPOINT actual_claim;
CREATE TEMP TABLE actual_claimed (idempotency_key text) ON COMMIT DROP;
WITH candidates AS (
    SELECT t.id
      FROM telegram_outbox t
     WHERE t.attempts < 5
       AND t.status IN ('pending', 'retry')
       AND t.available_at <= now()
       AND NOT EXISTS (
         SELECT 1 FROM telegram_outbox earlier
          WHERE earlier.chat_id = t.chat_id
            AND earlier.status IN ('pending', 'sending', 'retry')
            AND (earlier.priority, earlier.id) < (t.priority, t.id)
       )
     ORDER BY t.priority, t.available_at, t.id
     FOR UPDATE SKIP LOCKED
     LIMIT 2
), leased AS (
    UPDATE telegram_outbox t
       SET status = 'sending', locked_by = 'step06-ci', locked_at = now()
      FROM candidates c
     WHERE t.id = c.id
    RETURNING t.idempotency_key
)
INSERT INTO actual_claimed (idempotency_key)
SELECT idempotency_key FROM leased;

DO $$
DECLARE picked text[];
BEGIN
    SELECT array_agg(idempotency_key ORDER BY idempotency_key)
      INTO picked FROM actual_claimed;
    IF picked <> ARRAY['step06:100:k', 'step06:200:1'] THEN
        RAISE EXCEPTION 'actual SKIP LOCKED claim returned %', picked;
    END IF;
END $$;
ROLLBACK TO SAVEPOINT actual_claim;

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

-- The shared breaker key is provider/model. Two replica-like claims against
-- one ready row yield exactly one half-open probe; another model remains
-- independent for the same provider profile.
DO $$
DECLARE
    provider uuid;
    current_model text;
    first_claim integer;
    second_claim integer;
BEGIN
    INSERT INTO llm_providers
        (name, base_url, model, context_window, api_key_encrypted)
    VALUES
        ('step06-breaker-probe', 'http://example.test/v1', 'model-a', 32768, 'v1:a:b:c')
    RETURNING id, model INTO provider, current_model;

    -- Simulate an old replica. Its provider-only write must be projected to
    -- the current model row for a concurrently running new replica.
    INSERT INTO llm_breaker_state
        (provider_id, state, consecutive_errors, probe_after)
    VALUES (provider, 'open', 3, now() - interval '1 second')
    ON CONFLICT (provider_id) DO UPDATE SET
        state = 'open', pinned_out = false, probe_after = EXCLUDED.probe_after;

    UPDATE llm_breaker_model_state SET state = 'half_open'
     WHERE provider_id = provider AND model = current_model
       AND state = 'open' AND probe_after <= now();
    GET DIAGNOSTICS first_claim = ROW_COUNT;

    UPDATE llm_breaker_model_state SET state = 'half_open'
     WHERE provider_id = provider AND model = current_model
       AND state = 'open' AND probe_after <= now();
    GET DIAGNOSTICS second_claim = ROW_COUNT;

    IF first_claim <> 1 OR second_claim <> 0 THEN
        RAISE EXCEPTION 'half-open claims were %, %', first_claim, second_claim;
    END IF;

    INSERT INTO llm_breaker_model_state (provider_id, model, state)
    VALUES (provider, current_model || ':independent', 'closed');
    IF (SELECT count(*) FROM llm_breaker_model_state WHERE provider_id = provider) < 2 THEN
        RAISE EXCEPTION 'breaker models are not independent';
    END IF;

    UPDATE llm_providers SET model = current_model || ':independent' WHERE id = provider;
    IF (SELECT state FROM llm_breaker_state WHERE provider_id = provider) <> 'closed' THEN
        RAISE EXCEPTION 'old replica projection did not follow provider model change';
    END IF;
    UPDATE llm_providers SET model = current_model WHERE id = provider;

    -- Simulate a new replica recovering the current model. The old projection
    -- must follow so an old replica does not keep rejecting requests.
    UPDATE llm_breaker_model_state SET state = 'closed'
     WHERE provider_id = provider AND model = current_model;
    IF (SELECT state FROM llm_breaker_state WHERE provider_id = provider) <> 'closed' THEN
        RAISE EXCEPTION 'model breaker recovery was not projected to old replicas';
    END IF;
END $$;

ROLLBACK;
