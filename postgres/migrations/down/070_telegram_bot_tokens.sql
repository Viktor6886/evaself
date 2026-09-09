-- Откат: снимается только набор токенов. Активный токен при этом не
-- теряется — он лежит в secret_records под sec_eva_telegram_bot_token,
-- как лежал и до этой миграции, и Ева продолжает работать тем же ботом.
-- Теряется лишь возможность переключиться на запасной из панели.

BEGIN;

DROP TABLE IF EXISTS telegram_bot_tokens;

DELETE FROM schema_migrations WHERE version = '070_telegram_bot_tokens';

COMMIT;
