-- =====================================================================
-- Нативные опросы Telegram.
--
-- Ответ в опросе приходит отдельным апдейтом, в котором есть только
-- идентификатор опроса, автор и номера выбранных вариантов. Ни чата, ни
-- разговора, ни текстов вариантов в нём нет — значит, соответствие
-- должно жить здесь: иначе владельца и разговор пришлось бы угадывать,
-- а тексты брать от клиента.
--
-- Запись заводится до отправки, по идентификатору вызова инструмента:
-- повтор того же вызова после сбоя находит её и второго опроса не
-- создаёт. `poll_id` появляется после отправки — до неё его не знает
-- никто.
--
-- Ответы хранятся отдельно: один человек — одна строка на опрос.
-- Telegram присылает изменение голоса тем же апдейтом, и повтор того же
-- выбора не должен становиться вторым ходом.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS telegram_polls (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id          bigint      NOT NULL,
    conversation_id  text        NOT NULL,
    -- Вызов инструмента, которым опрос создан. Повтор вызова — тот же опрос.
    tool_call_id     text        NOT NULL,
    run_id           text,
    -- Идентификатор опроса в Telegram. Пусто, пока опрос не отправлен.
    poll_id          text,
    message_id       bigint,
    question         text        NOT NULL,
    options          text[]      NOT NULL,
    is_anonymous     boolean     NOT NULL DEFAULT false,
    allows_multiple  boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);

-- Идемпотентность вызова инструмента: второй раз тот же вызов опрос не создаёт.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_polls_call_idx
    ON telegram_polls (user_id, tool_call_id);
-- Поиск по ответу: апдейт приносит только идентификатор опроса.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_polls_poll_idx
    ON telegram_polls (poll_id) WHERE poll_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_polls_user_idx
    ON telegram_polls (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_poll_answers (
    poll_id     text        NOT NULL,
    user_id     bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Номера вариантов, а не их тексты: тексты уже лежат в telegram_polls,
    -- и второй копии смысла заводить не нужно.
    option_ids  integer[]   NOT NULL,
    answered_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (poll_id, user_id)
);

INSERT INTO schema_migrations (version)
VALUES ('062_telegram_polls')
ON CONFLICT DO NOTHING;

COMMIT;
