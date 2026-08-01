BEGIN;

DROP INDEX IF EXISTS task_events_delivery_once_idx;
DROP INDEX IF EXISTS task_events_telegram_reply_idx;
DROP INDEX IF EXISTS task_events_task_recent_idx;
DROP INDEX IF EXISTS task_events_user_recent_idx;
DROP TABLE IF EXISTS task_events;

DROP INDEX IF EXISTS llm_requests_routing_idx;
ALTER TABLE llm_requests
    DROP COLUMN IF EXISTS single_failover_used,
    DROP COLUMN IF EXISTS internal_operation_type,
    DROP COLUMN IF EXISTS purpose,
    DROP COLUMN IF EXISTS classification_reason_codes,
    DROP COLUMN IF EXISTS classification_score,
    DROP COLUMN IF EXISTS classification_confidence,
    DROP COLUMN IF EXISTS classification_source,
    DROP COLUMN IF EXISTS effective_route,
    DROP COLUMN IF EXISTS requested_route,
    DROP COLUMN IF EXISTS routing_mode;

ALTER TABLE user_preferences DROP COLUMN IF EXISTS llm_quality_mode;

DELETE FROM llm_routes WHERE code IN ('fast', 'classifier', 'research', 'safety', 'vision', 'single');

DROP TRIGGER IF EXISTS llm_single_provider_enabled_trigger ON llm_providers;
DROP FUNCTION IF EXISTS prevent_selected_single_provider_disable();
DROP TABLE IF EXISTS llm_routing_settings;

DELETE FROM schema_migrations WHERE version = '028_managed_llm_routing_and_task_events';

COMMIT;
