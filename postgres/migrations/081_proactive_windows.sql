BEGIN;

-- =====================================================================
-- Ева пишет первой в окна, которые выбрал человек
-- =====================================================================
--
-- До сих пор инициатива была привязана к молчанию (heartbeat после
-- шести часов) и к глобальным часам установки
-- (`EVA_CHECKIN_MORNING_HOUR`). Человек не мог сказать «пиши мне с
-- одиннадцати до двенадцати и с пяти до шести» — а именно так живой
-- разговор и выглядит: не по таймеру молчания, а в те часы, когда
-- собеседник свободен.
--
-- Проверка отсутствия эквивалента (инвариант 20):
--   * `user_preferences` хранит согласие (`heartbeat_enabled`) и
--     интервалы молчания, но не расписание: одна строка на человека не
--     вмещает несколько окон;
--   * `tasks` — поручения человека с точным сроком; окно — это не
--     поручение и точного срока у него нет по существу;
--   * `job_schedules` — общесистемные периодические задания, одно на
--     установку; персональное расписание туда не кладётся;
--   * `checkin_episodes` — суточный эпизод утро/вечер, а не то, когда
--     человеку удобно.
-- Таблица новая.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proactive_windows (
    id           bigserial   PRIMARY KEY,
    user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Границы в минутах от местной полуночи. Не `time`, потому что
    -- считать «случайную минуту внутри окна» приходится числом, а не
    -- временем суток, и перевод туда-обратно на каждом заходе — это
    -- ровно та арифметика, на которой теряется час при переходе на
    -- летнее время.
    start_minute integer     NOT NULL,
    end_minute   integer     NOT NULL,
    -- Дни недели по ISO: 1 — понедельник, 7 — воскресенье. Пустой
    -- массив запрещён: окно без дней не сработает никогда, и человек
    -- будет думать, что оно работает.
    weekdays     smallint[]  NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
    enabled      boolean     NOT NULL DEFAULT true,
    -- Как человек назвал окно. Показывается ему же в Mini App.
    label        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT proactive_windows_bounds_check
        CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute),
    -- Окно уже пятнадцати минут — это не окно, а точное время: случайная
    -- минута внутри него перестаёт быть случайной, и «человекоподобно»
    -- превращается в будильник.
    CONSTRAINT proactive_windows_width_check
        CHECK (end_minute - start_minute >= 15),
    CONSTRAINT proactive_windows_weekdays_check
        CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7
               AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
    CONSTRAINT proactive_windows_label_check
        CHECK (label IS NULL OR char_length(label) <= 100)
);

DROP TRIGGER IF EXISTS trg_proactive_windows_updated_at ON proactive_windows;
CREATE TRIGGER trg_proactive_windows_updated_at
    BEFORE UPDATE ON proactive_windows
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS proactive_windows_user_idx
    ON proactive_windows (user_id) WHERE enabled;

COMMENT ON TABLE proactive_windows IS
    'Когда человек разрешил Еве выходить на связь первой. Минуту внутри окна выбирает планировщик.';

-- ---------------------------------------------------------------------
-- Запланированное сообщение инициативы.
--
-- Слот проактивного сообщения до сих пор был только отметкой «сегодня
-- уже решали». Окну нужно больше: минута выбирается заранее и один раз,
-- иначе перезапуск сервиса перекатывал бы её, и сообщение приходило бы
-- дважды или не приходило вовсе.
--
-- `scheduled_for` — выбранная минута, `valid_until` — конец окна. Второе
-- нужно потому, что пропущенное окно не догоняется: сообщение «доброе
-- утро» в три часа дня хуже молчания.
--
-- Статус `scheduled` — новый и предшествует `planned`: минута выбрана,
-- но за работу ещё никто не брался. `planned` по-прежнему означает
-- «прямо сейчас этим занят воркер».
-- ---------------------------------------------------------------------
ALTER TABLE proactive_messages
    ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
    ADD COLUMN IF NOT EXISTS valid_until   timestamptz,
    -- Окно, из которого выбрана минута. `SET NULL`, а не `CASCADE`:
    -- удаление окна не стирает историю уже отправленных сообщений.
    ADD COLUMN IF NOT EXISTS window_id bigint
        REFERENCES proactive_windows (id) ON DELETE SET NULL;

ALTER TABLE proactive_messages DROP CONSTRAINT IF EXISTS proactive_messages_status_check;
ALTER TABLE proactive_messages
    ADD CONSTRAINT proactive_messages_status_check
        CHECK (status IN ('scheduled', 'planned', 'sent', 'skipped', 'failed'));

ALTER TABLE proactive_messages DROP CONSTRAINT IF EXISTS proactive_messages_kind_check;
ALTER TABLE proactive_messages
    ADD CONSTRAINT proactive_messages_kind_check
        CHECK (kind IN ('reminder', 'heartbeat', 'checkin_morning',
                        'checkin_evening', 'daily_insight', 'weekly_review',
                        'initiative'));

-- Выборка диспетчера: наступившие и ещё не просроченные. Частичный
-- индекс — потому что запланированных строк единицы, а отправленных и
-- пропущенных со временем становятся тысячи.
CREATE INDEX IF NOT EXISTS proactive_messages_due_idx
    ON proactive_messages (scheduled_for)
 WHERE status = 'scheduled';

-- ---------------------------------------------------------------------
-- Conversation, в которой Ева сочиняет сообщение своей инициативы.
--
-- У назначения `scheduler` инструменты запрещены целиком: оно сочиняет
-- текст напоминания, и больше ему ничего не нужно. Инициативе нужно
-- посмотреть, что вообще происходит у человека, — иначе получается
-- вежливая пустота, а не разговор. Поэтому своё назначение, как у
-- `task_action`, а не ослабление политики планировщика (инвариант 5).
-- ---------------------------------------------------------------------
ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_purpose_check;
ALTER TABLE agent_conversations
    ADD CONSTRAINT agent_conversations_purpose_check CHECK (purpose IN (
        'chat', 'scheduler', 'maintenance', 'profile',
        'goal_review', 'partner_analysis', 'research', 'task_action',
        'initiative'
    ));

INSERT INTO schema_migrations (version)
VALUES ('081_proactive_windows')
ON CONFLICT DO NOTHING;

COMMIT;
