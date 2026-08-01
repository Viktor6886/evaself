-- Откат 027: вернуться к паре «основной + резерв».
--
-- Первые две позиции цепочки становятся primary и fallback, остальные
-- теряются: в старой схеме их держать негде. Конфигурации при этом
-- остаются на месте — откат схемы не должен ничего удалять.

BEGIN;

ALTER TABLE stt_routes
    ADD COLUMN IF NOT EXISTS primary_config_id  uuid NULL REFERENCES stt_provider_configs (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS fallback_config_id uuid NULL REFERENCES stt_provider_configs (id) ON DELETE RESTRICT;

UPDATE stt_routes r
   SET primary_config_id = c.config_id
  FROM stt_route_providers c
 WHERE c.use_case = r.use_case AND c.position = 0;

UPDATE stt_routes r
   SET fallback_config_id = c.config_id
  FROM stt_route_providers c
 WHERE c.use_case = r.use_case AND c.position = 1;

ALTER TABLE stt_routes ADD CONSTRAINT stt_routes_distinct_check
    CHECK (fallback_config_id IS NULL OR fallback_config_id IS DISTINCT FROM primary_config_id);

ALTER TABLE stt_routes DROP COLUMN IF EXISTS rotation_enabled;
DROP TABLE IF EXISTS stt_route_providers;

-- Попытки снова умещаются в две. Записи телеметрии с большим номером
-- удаляются: иначе ограничение не наложится.
DELETE FROM stt_usage_events WHERE attempt_index > 2;
ALTER TABLE stt_usage_events DROP CONSTRAINT IF EXISTS stt_usage_attempt_check;
ALTER TABLE stt_usage_events ADD CONSTRAINT stt_usage_attempt_check
    CHECK (attempt_index BETWEEN 1 AND 2);

ALTER TABLE llm_routes DROP COLUMN IF EXISTS rotation_enabled;

UPDATE llm_requests SET switch_reason = NULL WHERE switch_reason = 'rotation_disabled';
ALTER TABLE llm_requests DROP CONSTRAINT IF EXISTS llm_requests_switch_reason_check;
ALTER TABLE llm_requests ADD CONSTRAINT llm_requests_switch_reason_check CHECK (
    switch_reason IS NULL OR switch_reason IN (
        'rate_limited', 'server_error', 'connection_failed', 'timeout',
        'empty_response', 'invalid_response', 'model_error', 'quota_exhausted',
        'budget_exceeded', 'json_contract_failed', 'tool_calls_failed',
        'latency_exceeded', 'breaker_open', 'incompatible'
    )
);

DELETE FROM schema_migrations WHERE version = '027_provider_rotation';

COMMIT;
