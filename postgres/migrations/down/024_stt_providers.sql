-- Откат 024: убрать реестр STT-провайдеров.
--
-- Порядок обратный созданию: сначала таблицы, которые ссылаются на
-- stt_provider_configs, потом она сама. Иначе FK не дадут удалить.
--
-- Секреты в Secret Store НЕ трогаются. Записи sec_stt_* остаются: они
-- принадлежат Secret Store, а не этой миграции, и удалять чужой ключ при
-- откате схемы — не то, чего оператор ждёт от `down`. Осиротевшие ссылки
-- видны в разделе секретов и снимаются оттуда осознанно.
--
-- Распознавание после отката продолжает работать: fallback на
-- MEDIA_ASR_* остаётся в media-service (см. 12 в постановке — поддержку
-- переменных окружения в том же релизе не убираем).

BEGIN;

DROP TABLE IF EXISTS stt_transcript_cache;
DROP TABLE IF EXISTS stt_usage_events;
DROP TABLE IF EXISTS stt_config_versions;
DROP TABLE IF EXISTS stt_routes;
DROP TABLE IF EXISTS stt_provider_configs;

-- Функция триггера общая только для этих двух таблиц, обе удалены выше.
DROP FUNCTION IF EXISTS stt_touch_updated_at();

DELETE FROM schema_migrations WHERE version = '024_stt_providers';

COMMIT;
