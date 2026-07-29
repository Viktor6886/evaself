-- =====================================================================
-- Локальное время и язык пользователя
-- =====================================================================

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS city text,
    ADD COLUMN IF NOT EXISTS country_code text,
    ADD COLUMN IF NOT EXISTS timezone_source text,
    ADD COLUMN IF NOT EXISTS timezone_confidence numeric(4,3),
    ADD COLUMN IF NOT EXISTS timezone_updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS language_mode text NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS preferred_language text,
    ADD COLUMN IF NOT EXISTS last_message_language text,
    ADD COLUMN IF NOT EXISTS language_updated_at timestamptz;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_language_mode_check;
ALTER TABLE users
    ADD CONSTRAINT users_language_mode_check
        CHECK (language_mode IN ('auto', 'fixed'));
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_timezone_confidence_check;
ALTER TABLE users
    ADD CONSTRAINT users_timezone_confidence_check
        CHECK (
            timezone_confidence IS NULL
            OR (timezone_confidence >= 0 AND timezone_confidence <= 1)
        );

CREATE TABLE IF NOT EXISTS timezone_aliases (
    alias         text NOT NULL,
    country_code  text NOT NULL DEFAULT '',
    city          text NOT NULL,
    timezone      text NOT NULL,
    priority      integer NOT NULL DEFAULT 100,
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (alias, country_code, timezone)
);

CREATE INDEX IF NOT EXISTS timezone_aliases_lookup_idx
    ON timezone_aliases (lower(alias), country_code, priority)
    WHERE enabled;

INSERT INTO timezone_aliases (alias, country_code, city, timezone, priority)
VALUES
    ('пермь', 'RU', 'Пермь', 'Asia/Yekaterinburg', 10),
    ('perm', 'RU', 'Пермь', 'Asia/Yekaterinburg', 10),
    ('екатеринбург', 'RU', 'Екатеринбург', 'Asia/Yekaterinburg', 10),
    ('yekaterinburg', 'RU', 'Екатеринбург', 'Asia/Yekaterinburg', 10),
    ('москва', 'RU', 'Москва', 'Europe/Moscow', 10),
    ('moscow', 'RU', 'Москва', 'Europe/Moscow', 10),
    ('санкт-петербург', 'RU', 'Санкт-Петербург', 'Europe/Moscow', 10),
    ('saint petersburg', 'RU', 'Санкт-Петербург', 'Europe/Moscow', 10),
    ('хельсинки', 'FI', 'Хельсинки', 'Europe/Helsinki', 10),
    ('helsinki', 'FI', 'Хельсинки', 'Europe/Helsinki', 10),
    ('алматы', 'KZ', 'Алматы', 'Asia/Almaty', 10),
    ('almaty', 'KZ', 'Алматы', 'Asia/Almaty', 10),
    ('ташкент', 'UZ', 'Ташкент', 'Asia/Tashkent', 10),
    ('tashkent', 'UZ', 'Ташкент', 'Asia/Tashkent', 10),
    ('лондон', 'GB', 'Лондон', 'Europe/London', 10),
    ('london', 'GB', 'Лондон', 'Europe/London', 10),
    ('берлин', 'DE', 'Берлин', 'Europe/Berlin', 10),
    ('berlin', 'DE', 'Берлин', 'Europe/Berlin', 10),
    ('нью-йорк', 'US', 'Нью-Йорк', 'America/New_York', 10),
    ('new york', 'US', 'Нью-Йорк', 'America/New_York', 10)
ON CONFLICT (alias, country_code, timezone) DO UPDATE SET
    city = EXCLUDED.city,
    priority = EXCLUDED.priority,
    enabled = true;

DROP TRIGGER IF EXISTS trg_timezone_aliases_updated_at ON timezone_aliases;
CREATE TRIGGER trg_timezone_aliases_updated_at
    BEFORE UPDATE ON timezone_aliases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('009_user_locale')
ON CONFLICT (version) DO NOTHING;

COMMIT;
