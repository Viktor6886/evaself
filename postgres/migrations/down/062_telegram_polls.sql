-- Откат опросов. Таблицы операционные: уже отправленные опросы после
-- отката перестанут возвращать ответы в разговор, но ни память, ни
-- переписка от этого не меняются.
BEGIN;
DROP TABLE IF EXISTS telegram_poll_answers;
DROP TABLE IF EXISTS telegram_polls;
DELETE FROM schema_migrations WHERE version = '062_telegram_polls';
COMMIT;
