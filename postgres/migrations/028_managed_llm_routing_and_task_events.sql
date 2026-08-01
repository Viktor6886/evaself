-- Managed LLM routing modes, adaptive route roles and durable task history.

BEGIN;

CREATE TABLE IF NOT EXISTS llm_routing_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    mode text NOT NULL DEFAULT 'adaptive'
        CHECK (mode IN ('adaptive', 'single')),
    single_provider_id uuid REFERENCES llm_providers (id) ON DELETE RESTRICT,
    single_failover_enabled boolean NOT NULL DEFAULT false,
    auto_routing_enabled boolean NOT NULL DEFAULT true,
    llm_classifier_enabled boolean NOT NULL DEFAULT true,
    fast_max_score integer NOT NULL DEFAULT 0,
    deep_min_score integer NOT NULL DEFAULT 5,
    classifier_confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.750
        CHECK (classifier_confidence_threshold BETWEEN 0 AND 1),
    classifier_timeout_ms integer NOT NULL DEFAULT 5000
        CHECK (classifier_timeout_ms BETWEEN 500 AND 60000),
    classifier_max_input_chars integer NOT NULL DEFAULT 4000
        CHECK (classifier_max_input_chars BETWEEN 200 AND 20000),
    uncertain_policy text NOT NULL DEFAULT 'upgrade'
        CHECK (uncertain_policy IN ('upgrade', 'chat', 'deterministic')),
    economy_score_shift integer NOT NULL DEFAULT -1,
    quality_score_shift integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    CONSTRAINT llm_routing_single_provider_check
        CHECK (mode <> 'single' OR single_provider_id IS NOT NULL),
    CONSTRAINT llm_routing_threshold_order_check
        CHECK (fast_max_score < deep_min_score)
);

INSERT INTO llm_routing_settings (singleton, single_provider_id)
SELECT true, COALESCE(
    (SELECT rp.provider_id
       FROM llm_route_providers rp
       JOIN llm_providers p ON p.id = rp.provider_id AND p.enabled
      WHERE rp.route_code = 'chat'
      ORDER BY rp.position LIMIT 1),
    (SELECT id FROM llm_providers WHERE enabled AND is_active ORDER BY created_at LIMIT 1),
    (SELECT id FROM llm_providers WHERE enabled ORDER BY priority, created_at LIMIT 1)
)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_selected_single_provider_disable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.enabled AND NOT NEW.enabled AND EXISTS (
        SELECT 1 FROM llm_routing_settings
         WHERE singleton AND mode = 'single' AND single_provider_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'selected single-mode provider cannot be disabled'
            USING ERRCODE = '23514', CONSTRAINT = 'llm_single_provider_enabled';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS llm_single_provider_enabled_trigger ON llm_providers;
CREATE TRIGGER llm_single_provider_enabled_trigger
BEFORE UPDATE OF enabled ON llm_providers
FOR EACH ROW EXECUTE FUNCTION prevent_selected_single_provider_disable();

INSERT INTO llm_routes (
    code, title, description, requires_tools, requires_json, requires_vision,
    requires_streaming, min_context_window, max_quality_tier, allows_sensitive,
    rotation_enabled
) VALUES
    ('fast', 'Экономичная модель', 'Короткие, простые и фоновые операции', false, false, false, false, 4096, 5, true, true),
    ('classifier', 'Классификатор', 'Классификация неоднозначных запросов', false, true, false, false, 4096, 5, true, true),
    ('research', 'Исследование', 'Поиск и сопоставление источников', false, false, false, false, 8192, 5, true, true),
    ('safety', 'Безопасность', 'Кризисные и высокорисковые обращения', false, false, false, false, 8192, 2, true, true),
    ('vision', 'Зрение', 'Анализ изображений', false, false, true, false, 8192, 5, true, true),
    ('single', 'Одна модель', 'Технический маршрут режима одной модели', false, false, false, false, 4096, 5, true, false)
ON CONFLICT (code) DO NOTHING;

-- Seed only empty new chains. Each role inherits from the closest existing
-- route and later mode switches never mutate these independent chains.
INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'fast', source.provider_id, source.position
  FROM llm_route_providers source
 WHERE source.route_code = 'chat'
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'fast')
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'classifier', source.provider_id, source.position
  FROM llm_route_providers source
 WHERE source.route_code = CASE
     WHEN EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'json') THEN 'json'
     ELSE 'chat'
   END
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'classifier')
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT target.code, source.provider_id, source.position
  FROM (VALUES ('research'), ('safety')) AS target(code)
 CROSS JOIN llm_route_providers source
 WHERE source.route_code = CASE
     WHEN EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'deep') THEN 'deep'
     ELSE 'chat'
   END
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = target.code)
ON CONFLICT (route_code, provider_id) DO NOTHING;

INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'vision', compatible.provider_id,
       (row_number() OVER (ORDER BY compatible.source_order, compatible.position) - 1)::smallint
  FROM (
    SELECT DISTINCT ON (source.provider_id)
           source.provider_id, source.position,
           CASE source.route_code WHEN 'deep' THEN 0 ELSE 1 END AS source_order
      FROM llm_route_providers source
      JOIN llm_providers provider ON provider.id = source.provider_id
     WHERE source.route_code IN ('deep', 'chat') AND provider.supports_vision
     ORDER BY source.provider_id,
              CASE source.route_code WHEN 'deep' THEN 0 ELSE 1 END,
              source.position
  ) compatible
 WHERE NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'vision')
 ORDER BY compatible.source_order, compatible.position
 LIMIT 6
ON CONFLICT (route_code, provider_id) DO NOTHING;

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS llm_quality_mode text NOT NULL DEFAULT 'auto'
        CHECK (llm_quality_mode IN ('economy', 'auto', 'quality'));

ALTER TABLE llm_requests
    ADD COLUMN IF NOT EXISTS routing_mode text NOT NULL DEFAULT 'adaptive'
        CHECK (routing_mode IN ('adaptive', 'single')),
    ADD COLUMN IF NOT EXISTS requested_route text,
    ADD COLUMN IF NOT EXISTS effective_route text,
    ADD COLUMN IF NOT EXISTS classification_source text,
    ADD COLUMN IF NOT EXISTS classification_confidence numeric(4,3),
    ADD COLUMN IF NOT EXISTS classification_score integer,
    ADD COLUMN IF NOT EXISTS classification_reason_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS purpose text,
    ADD COLUMN IF NOT EXISTS internal_operation_type text,
    ADD COLUMN IF NOT EXISTS single_failover_used boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS llm_requests_routing_idx
    ON llm_requests (routing_mode, effective_route, started_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    task_id bigint NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN (
        'created', 'updated', 'reminder_generated', 'reminder_sent',
        'delivery_failed', 'user_replied', 'snoozed', 'completed',
        'cancelled', 'reopened'
    )),
    scheduled_at timestamptz,
    generated_at timestamptz,
    sent_at timestamptz,
    generated_text text,
    delivery_status text,
    telegram_chat_id bigint,
    telegram_message_id bigint,
    conversation_id text,
    routing_mode text CHECK (routing_mode IS NULL OR routing_mode IN ('adaptive', 'single')),
    requested_route text,
    effective_route text,
    llm_request_id uuid,
    actual_provider_id uuid REFERENCES llm_providers (id) ON DELETE SET NULL,
    actual_model text,
    error_code text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_user_recent_idx
    ON task_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_events_task_recent_idx
    ON task_events (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_events_telegram_reply_idx
    ON task_events (telegram_chat_id, telegram_message_id)
    WHERE telegram_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_events_delivery_once_idx
    ON task_events (task_id, event_type, scheduled_at)
    WHERE event_type IN ('reminder_generated', 'reminder_sent');

INSERT INTO schema_migrations (version)
VALUES ('028_managed_llm_routing_and_task_events')
ON CONFLICT (version) DO NOTHING;

COMMIT;
