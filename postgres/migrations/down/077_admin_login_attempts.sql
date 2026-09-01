BEGIN;

-- Колонка только служебная: в ней нет данных, которые нельзя восстановить
-- следующей неудачной попыткой. Но исходные строки down-миграция не
-- трогает — снимается лишь добавленная отметка.
ALTER TABLE admin_users
    DROP COLUMN IF EXISTS last_failed_at;

DELETE FROM schema_migrations WHERE version = '077_admin_login_attempts';

COMMIT;
