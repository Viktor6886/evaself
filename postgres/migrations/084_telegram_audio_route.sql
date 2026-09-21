-- Separate long uploaded audio from ordinary Telegram voice notes.
-- The route inherits the current voice provider chain once at migration time,
-- then can be tuned independently in the admin panel.

BEGIN;

ALTER TABLE stt_routes DROP CONSTRAINT IF EXISTS stt_routes_use_case_check;
ALTER TABLE stt_routes ADD CONSTRAINT stt_routes_use_case_check
    CHECK (use_case IN ('telegram_voice', 'telegram_audio', 'webapp_voice_message', 'webapp_live'));

INSERT INTO stt_routes
    (use_case, enabled, rotation_enabled, timeout_ms, max_audio_seconds, config_version)
SELECT 'telegram_audio', true, rotation_enabled, GREATEST(timeout_ms, 120000), 7200, 1
  FROM stt_routes
 WHERE use_case = 'telegram_voice'
ON CONFLICT (use_case) DO NOTHING;

INSERT INTO stt_route_providers (use_case, config_id, position, created_by)
SELECT 'telegram_audio', config_id, position, created_by
  FROM stt_route_providers
 WHERE use_case = 'telegram_voice'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('084_telegram_audio_route')
ON CONFLICT (version) DO NOTHING;

COMMIT;
