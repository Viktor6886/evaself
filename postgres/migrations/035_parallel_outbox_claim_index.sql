-- This index can scan an existing outbox, so it is deliberately outside a
-- transaction and built concurrently.

CREATE INDEX CONCURRENTLY IF NOT EXISTS telegram_outbox_priority_claim_idx
    ON telegram_outbox (priority, available_at, id)
    WHERE status IN ('pending', 'sending', 'retry');

INSERT INTO schema_migrations (version)
VALUES ('035_parallel_outbox_claim_index')
ON CONFLICT (version) DO NOTHING;
