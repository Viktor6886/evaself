-- Откат 025: убрать пресеты и вернуть прежний список провайдеров.
--
-- Удаляются только нетронутые пресеты: если в конфигурацию вписали ключ
-- или назначили её на маршрут, она принадлежит администратору, а не
-- миграции, и сносить её нельзя.

BEGIN;

DELETE FROM stt_provider_configs
 WHERE name IN ('Deepgram', 'Google AI Studio', 'OpenAI')
   AND status = 'draft'
   AND secret_ref IS NULL
   AND id NOT IN (
       SELECT primary_config_id FROM stt_routes WHERE primary_config_id IS NOT NULL
       UNION
       SELECT fallback_config_id FROM stt_routes WHERE fallback_config_id IS NOT NULL
   );

-- Вернуть ограничение можно только если конфигураций google_ai_studio
-- не осталось: иначе откат сломал бы существующие строки.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM stt_provider_configs WHERE provider = 'google_ai_studio') THEN
        ALTER TABLE stt_provider_configs DROP CONSTRAINT IF EXISTS stt_configs_provider_check;
        ALTER TABLE stt_provider_configs ADD CONSTRAINT stt_configs_provider_check
            CHECK (provider IN ('deepgram', 'openai', 'google', 'openrouter'));
    END IF;
END $$;

DELETE FROM schema_migrations WHERE version = '025_stt_presets';

COMMIT;
