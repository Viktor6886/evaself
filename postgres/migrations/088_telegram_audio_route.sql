-- =====================================================================
-- 088 — отдельный сценарий распознавания для аудиофайлов Telegram
--
-- Голосовое — реплика человека на минуту-другую; аудиофайл — запись
-- встречи или лекции на час. Одна настройка на обоих заставляла
-- выбирать между коротким сроком для голосовых и пределом в два часа
-- для файлов. Новый сценарий `telegram_audio` получает свой срок и
-- предел длительности, а цепочку провайдеров — копией цепочки
-- голосовых: после обновления аудиофайлы распознаются тем же, чем и
-- раньше, пока администратор не назначит им другое.
--
-- Старый код сценарий не использует: агент выбирает его только при
-- включённом EVA_AUDIO_FILE_TRANSCRIPTS в новой версии. Прежний
-- media-service неизвестный сценарий в снимке отклоняет вместе со
-- снимком и продолжает работать на прежнем — до обновления контейнера.
-- =====================================================================

BEGIN;

ALTER TABLE stt_routes DROP CONSTRAINT IF EXISTS stt_routes_use_case_check;
ALTER TABLE stt_routes ADD CONSTRAINT stt_routes_use_case_check
    CHECK (use_case IN ('telegram_voice', 'telegram_audio', 'webapp_voice_message', 'webapp_live'));

-- Срок — не меньше двух минут: длинная запись распознаётся частями, и
-- каждая часть — отдельный запрос к провайдеру.
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

INSERT INTO schema_migrations (version)
VALUES ('088_telegram_audio_route')
ON CONFLICT DO NOTHING;

COMMIT;
