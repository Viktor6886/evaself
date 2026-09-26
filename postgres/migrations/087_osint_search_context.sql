-- =====================================================================
-- 087 — уточнение поиска OSINT-исследования
--
-- Город и место работы из просьбы человека: по распространённому имени
-- без них выдача состоит из тёзок. Колонка новая, со значением по
-- умолчанию: старый код её не читает и не пишет.
-- =====================================================================

BEGIN;

ALTER TABLE osint_investigations
    ADD COLUMN IF NOT EXISTS search_context jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO schema_migrations (version)
VALUES ('087_osint_search_context')
ON CONFLICT DO NOTHING;

COMMIT;
