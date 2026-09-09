BEGIN;

-- Отметка последней неудачной попытки входа в панель.
--
-- Порог теперь считается не «за окно», а подряд: десять ошибок — минута
-- блокировки, каждая следующая ошибка — снова минута. Обнуляется счётчик
-- сам, если с последней ошибки прошло больше суток, — а это ровно то, чего
-- в таблице не хватало: `failed_attempts` не помнил, когда его последний
-- раз трогали.
--
-- Forward-совместимо: колонка nullable, и старый код, который её не знает,
-- продолжает писать `failed_attempts` и `locked_until` как раньше.
ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;

COMMENT ON COLUMN admin_users.last_failed_at IS
    'Время последней неудачной попытки входа. Через сутки тишины счётчик '
    'failed_attempts начинается заново.';

INSERT INTO schema_migrations (version)
VALUES ('077_admin_login_attempts')
ON CONFLICT DO NOTHING;

COMMIT;
