BEGIN;
DROP TABLE IF EXISTS telegram_sticker_cache;
DELETE FROM schema_migrations WHERE version = '064_telegram_sticker_cache';
COMMIT;
