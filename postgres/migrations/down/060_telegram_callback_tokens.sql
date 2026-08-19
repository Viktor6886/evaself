-- Откат токенов inline-кнопок. Таблица операционная: непрожатые кнопки
-- после отката просто перестанут отвечать, разговор и память не
-- затрагиваются.
BEGIN;
DROP TABLE IF EXISTS telegram_callback_tokens;
DELETE FROM schema_migrations WHERE version = '060_telegram_callback_tokens';
COMMIT;
