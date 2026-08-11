-- =====================================================================
-- Шаг 08: перенос фоновой работы в очереди, agent jobs и проактивность.
--
-- Проверка отсутствия эквивалента (инвариант 20):
--   * `tasks` / `task_events` — напоминания одного пользователя и их
--     история; в них нет ни решения «не писать», ни суточного эпизода;
--   * `heartbeat_state` — одна строка на пользователя, только последний
--     heartbeat; она не отвечает на вопрос «отправляли ли мы сегодня
--     утренний check-in» и не различает виды проактивных сообщений;
--   * `user_checkins` — то, что заполнил САМ человек в Mini App; это
--     ответ пользователя, а не наше проактивное обращение;
--   * `notifications` — доставленные уведомления интерфейса;
--   * `job_runs` (шаг 07) — факт запуска задания, безопасные метаданные;
--     класть в него предложение агента значило бы смешать журнал
--     исполнения с содержательным результатом.
-- Ни одна из них не отвечает на вопросы «writing ли мы это сегодня уже
-- отправляли» и «чем кончился ход агента», поэтому таблицы новые.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Проактивные сообщения.
--
-- Одна строка = одно решение выйти на связь: и «отправили», и «решили
-- не отправлять». Второе так же важно, как первое: без записи отказа
-- следующий заход не отличит «сегодня уже подумали и решили молчать» от
-- «ещё не думали», и человек получит два сообщения подряд.
--
-- Идемпотентность держится на `slot_key` — это локальный слот времени
-- (дата и вид), а не отметка времени запуска. Повторный запуск задания
-- по тому же расписанию попадает в тот же слот и второго сообщения не
-- создаёт (требование 10 шага 8).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proactive_messages (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    -- Локальный слот: `2026-08-10:morning`, `2026-08-10:heartbeat:2`.
    -- Считается в часовом поясе человека, а не в UTC: «сегодня утром»
    -- — это его сегодня.
    slot_key     text        NOT NULL,
    local_date   date        NOT NULL,
    timezone     text        NOT NULL,
    status       text        NOT NULL,
    -- Почему промолчали. Код, а не текст: причина уходит в метрики.
    reason       text,
    -- Строка durable outbox, если сообщение отправлено. Доставку делает
    -- outbox, а не воркер (требование 9 шага 8). Тип — `bigint`, потому
    -- что `telegram_outbox.id` это `bigserial`: ключ доставки счётный, а
    -- не uuid, и ссылка обязана совпадать с ним по типу.
    outbox_id    bigint      REFERENCES telegram_outbox (id) ON DELETE SET NULL,
    run_id       uuid,
    -- Ссылка на суточный эпизод без внешнего ключа: `checkin_episodes`
    -- ссылается на эту таблицу и создаётся ниже, поэтому объявить FK в
    -- обе стороны нельзя без отложенного ограничения.
    episode_id   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT proactive_messages_slot_uidx UNIQUE (user_id, kind, slot_key),
    CONSTRAINT proactive_messages_status_check
        CHECK (status IN ('planned', 'sent', 'skipped', 'failed')),
    CONSTRAINT proactive_messages_kind_check
        CHECK (kind IN ('reminder', 'heartbeat', 'checkin_morning',
                        'checkin_evening', 'daily_insight', 'weekly_review'))
);

DROP TRIGGER IF EXISTS trg_proactive_messages_updated_at ON proactive_messages;
CREATE TRIGGER trg_proactive_messages_updated_at
    BEFORE UPDATE ON proactive_messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS proactive_messages_user_recent_idx
    ON proactive_messages (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Суточный эпизод check-in.
--
-- Утро и вечер — не два независимых сообщения, а один день: вечерний
-- check-in ссылается на утреннее намерение, следующий утренний — на итог
-- вечера (требование 6 шага 8). Связь хранится ссылкой на предыдущий
-- эпизод, а не пересказом: пересказ разошёлся бы с оригиналом.
--
-- Содержательного текста здесь нет — только ссылки и короткие
-- структурированные отметки. Сам разговор живёт в conversation Letta,
-- выжимки — в `conversation_highlights` (инвариант 13).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkin_episodes (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    local_date        date        NOT NULL,
    timezone          text        NOT NULL,
    -- Предыдущий эпизод того же человека: по нему утро узнаёт, чем
    -- кончился вечер.
    previous_id       uuid        REFERENCES checkin_episodes (id) ON DELETE SET NULL,
    morning_message_id uuid       REFERENCES proactive_messages (id) ON DELETE SET NULL,
    evening_message_id uuid       REFERENCES proactive_messages (id) ON DELETE SET NULL,
    -- Намерение на день и итог вечера: ссылки на узлы памяти или
    -- короткие безопасные отметки, а не переписка.
    morning_intent_ref text,
    evening_outcome_ref text,
    -- Ответил ли человек. Неотвеченный утренний check-in не повторяется
    -- вечером как ни в чём не бывало.
    morning_answered  boolean     NOT NULL DEFAULT false,
    evening_answered  boolean     NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT checkin_episodes_day_uidx UNIQUE (user_id, local_date)
);

DROP TRIGGER IF EXISTS trg_checkin_episodes_updated_at ON checkin_episodes;
CREATE TRIGGER trg_checkin_episodes_updated_at
    BEFORE UPDATE ON checkin_episodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Результат фонового хода агента.
--
-- Agent job возвращает предложение или отчёт и НЕ пишет каноническую
-- память сам (инвариант 18). Предложение живёт здесь до тех пор, пока
-- его не примет серверный код или человек. На этом же механизме позже
-- строятся рефлексия, отчёты и исследования — отдельных таблиц для них
-- заводить нельзя.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_job_results (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id         uuid        NOT NULL,
    user_id        bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    job_type       text        NOT NULL,
    conversation_id text,
    purpose        text,
    status         text        NOT NULL,
    -- Типизированное предложение: `{kind, items[], confidence}`. Схему
    -- проверяет серверный код, а не модель.
    result         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Что израсходовано. Бюджет объявляется до хода и проверяется после.
    tokens_used    integer     NOT NULL DEFAULT 0,
    duration_ms    integer     NOT NULL DEFAULT 0,
    cost_micros    bigint      NOT NULL DEFAULT 0,
    budget_exceeded boolean    NOT NULL DEFAULT false,
    error_code     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_job_results_status_check
        CHECK (status IN ('succeeded', 'empty', 'budget_exceeded', 'invalid_result', 'failed')),
    CONSTRAINT agent_job_results_run_uidx UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS agent_job_results_user_idx
    ON agent_job_results (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Сверка старого и нового механизмов (режим зеркала).
--
-- Старый интервал отключается не по решению «вроде работает», а по
-- доказанному совпадению выборки: сколько строк выбрал каждый механизм
-- и чем именно они разошлись. Строка сверки — это и есть доказательство
-- из требования 3 шага 8.
--
-- Идентификаторы сущностей хранятся списком текстов: это ключи задач и
-- пользователей, не содержание.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_mirror_samples (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type     text        NOT NULL,
    legacy_count integer     NOT NULL,
    queue_count  integer     NOT NULL,
    matched      boolean     NOT NULL,
    only_legacy  text[]      NOT NULL DEFAULT '{}',
    only_queue   text[]      NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_mirror_samples_type_idx
    ON job_mirror_samples (job_type, created_at DESC);

-- ---------------------------------------------------------------------
-- Расписания перенесённых задач.
--
-- Каноническая копия расписания живёт в PostgreSQL (инвариант 9), и эти
-- строки — она. Все выключены: `enabled = false` означает, что при
-- старте они не попадут в очередь и ничего не выполнят. Включает
-- человек, отдельным решением и после сверки в режиме зеркала.
--
-- Время указано в UTC-полях cron с зоной `Europe/Moscow`: локальный час
-- каждого пользователя проверяет уже сама выборка check-in, а задание
-- лишь заходит достаточно часто, чтобы застать нужный час у каждого.
-- ---------------------------------------------------------------------
INSERT INTO job_schedules (code, queue, job_type, schema_version, cron, timezone, enabled, dedup_mode, payload)
VALUES
    ('maintenance_reconcile', 'maintenance', 'maintenance_reconcile', 1,
     '*/15 * * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb),
    ('proactive_reminder', 'proactive', 'proactive_reminder', 1,
     '* * * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb),
    ('proactive_heartbeat', 'proactive', 'proactive_heartbeat', 1,
     '*/10 * * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb),
    ('checkin_morning', 'proactive', 'checkin_morning', 1,
     '*/30 * * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb),
    ('checkin_evening', 'proactive', 'checkin_evening', 1,
     '*/30 * * * *', 'Europe/Moscow', false, 'keep_last_if_active', '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('036_jobs_proactive')
ON CONFLICT (version) DO NOTHING;

COMMIT;
