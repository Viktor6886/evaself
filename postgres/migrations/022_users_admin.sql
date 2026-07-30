-- =====================================================================
-- Раздел «Пользователи» административной панели.
--
-- Сама таблица users полная и менять её не нужно: список и карточка
-- собираются существующими представлениями v_user_overview (002, форма
-- расширена в 003) и v_quota_status (002). Миграция добавляет только то,
-- чего для панели действительно не хватает.
--
-- 1. admin_user_notes — заметки оператора о пользователе.
--    В users.notes уже есть одно текстовое поле, но у него нет ни автора,
--    ни времени, ни истории: вторая заметка затирает первую, и через месяц
--    непонятно, кто и когда её написал. Поле не трогаем — его может писать
--    рабочий код, — а заметки панели ведём отдельной таблицей.
--
-- 2. Согласование двух флагов блокировки.
--    Диалог останавливается при is_blocked ИЛИ state='blocked'
--    (eva-workflow.ts), а фоновые рассылки требуют state='active' И NOT
--    is_blocked (background.ts). Строки, где флаги разошлись, ведут себя
--    противоречиво: человек не может писать Еве, но в списке значится
--    активным, — или наоборот, молча перестаёт получать рассылки.
--    Приводим существующие строки к согласию; дальше оба поля пишет
--    UserService одной транзакцией.
--
-- 3. Индекс для поиска по имени. По username триграммный индекс уже есть
--    (001), по first_name не было, а искать в панели будут именно по нему.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_user_notes (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Автор остаётся в журнале, даже если учётку оператора удалили:
    -- ON DELETE SET NULL, а не CASCADE — заметка ценнее ссылки на автора.
    actor_id    uuid REFERENCES admin_users (id) ON DELETE SET NULL,
    actor_name  text NOT NULL,
    note        text NOT NULL,
    -- Блокировка и правка полей идемпотентны сами по себе: они выставляют
    -- состояние, а не изменяют его на шаг. Заметка — нет: повторно
    -- отправленная форма добавила бы дубль, поэтому у неё есть ключ.
    idempotency_key text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT admin_user_notes_note_check CHECK (length(btrim(note)) > 0)
);

CREATE INDEX IF NOT EXISTS admin_user_notes_user_idx
    ON admin_user_notes (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS admin_user_notes_idempotency_uidx
    ON admin_user_notes (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Блокирован по одному флагу — значит блокирован по обоим.
UPDATE users
   SET state = 'blocked', updated_at = now()
 WHERE is_blocked AND state <> 'blocked';

UPDATE users
   SET is_blocked = true, updated_at = now()
 WHERE state = 'blocked' AND NOT is_blocked;

CREATE INDEX IF NOT EXISTS users_first_name_trgm
    ON users USING gin (first_name gin_trgm_ops);

INSERT INTO schema_migrations (version) VALUES ('022_users_admin')
ON CONFLICT (version) DO NOTHING;

COMMIT;
