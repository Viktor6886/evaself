BEGIN;

DROP INDEX IF EXISTS usage_events_metric_created_idx;
DROP INDEX IF EXISTS usage_events_user_created_idx;
DROP INDEX IF EXISTS usage_events_idempotency_uidx;
DROP TABLE IF EXISTS usage_events;

DELETE FROM schema_migrations WHERE version = '083_message_usage_ledger';

COMMIT;
