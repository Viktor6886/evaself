BEGIN;

-- Откат убирает только сценарий, созданный прямой миграцией: цепочка
-- голосовых и сами конфигурации провайдеров остаются как были. Строки
-- сценария удаляются до возврата проверки — иначе она не встанет.
DELETE FROM stt_route_providers WHERE use_case = 'telegram_audio';
DELETE FROM stt_routes WHERE use_case = 'telegram_audio';

ALTER TABLE stt_routes DROP CONSTRAINT IF EXISTS stt_routes_use_case_check;
ALTER TABLE stt_routes ADD CONSTRAINT stt_routes_use_case_check
    CHECK (use_case IN ('telegram_voice', 'webapp_voice_message', 'webapp_live'));

DELETE FROM schema_migrations WHERE version = '088_telegram_audio_route';

COMMIT;
