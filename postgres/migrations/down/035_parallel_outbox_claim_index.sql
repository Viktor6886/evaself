DROP INDEX CONCURRENTLY IF EXISTS telegram_outbox_priority_claim_idx;

DELETE FROM schema_migrations WHERE version = '035_parallel_outbox_claim_index';
