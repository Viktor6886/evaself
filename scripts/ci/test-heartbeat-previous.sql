-- =====================================================================
-- Отметка сообщения человека возвращает ПРЕДЫДУЩУЮ — на настоящем
-- PostgreSQL.
--
-- По этому значению считается промежуток между сообщениями: без него
-- модель достраивает время по смыслу слов и спрашивает о результате
-- дела, на которое прошло девять секунд. Прежняя отметка читается тем же
-- запросом, что и обновление, и держится это на одной особенности
-- PostgreSQL: CTE видит снимок таблицы ДО изменяющей части того же
-- запроса. Поддельная база в тестах TypeScript такого не проверяет —
-- там прежнее значение просто возвращается из карты.
--
-- Проверяется ровно это: что вернулось, что осталось в таблице и что
-- изменяющая часть выполняется, хотя из неё никто не выбирает.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================

BEGIN;

CREATE TEMP TABLE heartbeat_probe (LIKE heartbeat_state INCLUDING ALL) ON COMMIT DROP;

DO $$
DECLARE
    returned timestamptz;
    stored   timestamptz;
    first_at timestamptz := now() - interval '3 minutes';
BEGIN
    -- Первое сообщение: предыдущего нет, но строка обязана появиться —
    -- изменяющая часть выполняется, даже когда из неё не выбирают.
    WITH previous AS (
        SELECT last_user_message_at FROM heartbeat_probe WHERE user_id = 42
    ), touched AS (
        INSERT INTO heartbeat_probe (user_id, last_user_message_at)
        VALUES (42, first_at)
        ON CONFLICT (user_id) DO UPDATE SET last_user_message_at = first_at
        RETURNING user_id
    )
    SELECT previous.last_user_message_at INTO returned FROM previous;

    IF returned IS NOT NULL THEN
        RAISE EXCEPTION 'у первого сообщения не может быть предыдущего: %', returned;
    END IF;

    SELECT last_user_message_at INTO stored FROM heartbeat_probe WHERE user_id = 42;
    IF stored IS DISTINCT FROM first_at THEN
        RAISE EXCEPTION 'первое сообщение не записано: %', stored;
    END IF;

    -- Второе сообщение: возвращается отметка первого, а в таблице
    -- остаётся отметка второго.
    WITH previous AS (
        SELECT last_user_message_at FROM heartbeat_probe WHERE user_id = 42
    ), touched AS (
        INSERT INTO heartbeat_probe (user_id, last_user_message_at)
        VALUES (42, now())
        ON CONFLICT (user_id) DO UPDATE SET last_user_message_at = now()
        RETURNING user_id
    )
    SELECT previous.last_user_message_at INTO returned FROM previous;

    IF returned IS DISTINCT FROM first_at THEN
        RAISE EXCEPTION 'вернулась не отметка предыдущего сообщения: %', returned;
    END IF;

    SELECT last_user_message_at INTO stored FROM heartbeat_probe WHERE user_id = 42;
    IF stored <= first_at THEN
        RAISE EXCEPTION 'отметка не обновилась: %', stored;
    END IF;

    -- Чужая строка своей отметкой не делится: промежуток считается по
    -- владельцу, а не по последнему писавшему в установке.
    INSERT INTO heartbeat_probe (user_id, last_user_message_at)
    VALUES (43, now() - interval '10 days');

    WITH previous AS (
        SELECT last_user_message_at FROM heartbeat_probe WHERE user_id = 42
    )
    SELECT previous.last_user_message_at INTO returned FROM previous;

    IF returned <= first_at THEN
        RAISE EXCEPTION 'прочитана чужая отметка: %', returned;
    END IF;
END $$;

ROLLBACK;
