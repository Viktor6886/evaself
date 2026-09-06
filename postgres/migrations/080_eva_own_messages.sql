BEGIN;

-- =====================================================================
-- Ева помнит, что написала сама
-- =====================================================================
--
-- Сообщение, которое Ева отправила по своей инициативе или по
-- наступившему сроку, сочиняется в служебной conversation и уходит в
-- Telegram. Основной диалог о нём не знает никогда: человек спрашивает
-- «ты же мне писала утром?», а для Евы этого утра не было.
--
-- Проверка отсутствия эквивалента (инвариант 20):
--   * `task_events.generated_text` хранит текст, но только у задач:
--     heartbeat и check-in туда не попадают вовсе;
--   * `heartbeat_state.last_message_hash` — sha256 последнего
--     сообщения. Его хватает на защиту от дубля и не хватает ни на что
--     другое: хэш нельзя прочитать;
--   * `proactive_messages` знает, что сообщение было, и не знает, каким
--     оно было;
--   * `telegram_outbox.payload` вычищается политикой хранения через
--     семь дней и не различает, кто был инициатором.
-- Ни одна из них не отвечает на вопрос «что именно я отправила с
-- прошлого сообщения человека». Новой таблицы при этом не нужно: не
-- хватает двух колонок у существующей.
--
-- Forward-совместимо: колонки необязательные, старый код продолжает
-- писать строки без них.
ALTER TABLE proactive_messages
    ADD COLUMN IF NOT EXISTS message_text text,
    ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- Потолок стоит в схеме, а не только в коде: длину ограничивает
-- composer (1200 знаков), но политика хранения и контекст хода читают
-- колонку напрямую, и строка на мегабайт из будущего вызова обошлась бы
-- им дороже, чем стоит само сообщение.
ALTER TABLE proactive_messages DROP CONSTRAINT IF EXISTS proactive_messages_text_len_check;
ALTER TABLE proactive_messages
    ADD CONSTRAINT proactive_messages_text_len_check
        CHECK (message_text IS NULL OR char_length(message_text) <= 4000);

COMMENT ON COLUMN proactive_messages.message_text IS
    'Текст отправленного сообщения Евы. Слова человека здесь не хранятся.';
COMMENT ON COLUMN proactive_messages.sent_at IS
    'Когда сообщение ушло в доставку. NULL — сообщения не было.';

-- Выборка «что я отправила после такого-то момента» идёт по владельцу и
-- времени отправки. Частичный индекс: строки отказа («сегодня решили
-- промолчать») составляют большинство и в эту выборку не попадают
-- никогда.
CREATE INDEX IF NOT EXISTS proactive_messages_sent_idx
    ON proactive_messages (user_id, sent_at DESC)
 WHERE sent_at IS NOT NULL;

-- Та же выборка по задачам. `sent_at` у события задачи уже есть.
CREATE INDEX IF NOT EXISTS task_events_sent_idx
    ON task_events (user_id, sent_at DESC)
 WHERE sent_at IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('080_eva_own_messages')
ON CONFLICT DO NOTHING;

COMMIT;
