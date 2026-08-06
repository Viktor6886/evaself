-- =====================================================================
-- Журнал побочных эффектов — на настоящем PostgreSQL.
--
-- Поддельная база в тестах TypeScript повторяет правила журнала, но не
-- проверяет сам SQL: ни `ON CONFLICT DO NOTHING`, ни условное
-- обновление, которым забирается право на повтор. Здесь проверяется
-- именно поведение запросов, включая гонку двух исполнителей.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================

BEGIN;

CREATE TEMP TABLE effect_probe (LIKE tool_effects INCLUDING ALL) ON COMMIT DROP;

DO $$
DECLARE
    claimed int;
    found record;
    next_attempt int;
BEGIN
    -- Первый исполнитель занимает ключ.
    INSERT INTO effect_probe (effect_key, run_id, user_id, tool_name, tool_call_id)
    VALUES ('k1', '00000000-0000-0000-0000-000000000001', 42, 'save_task', 'call-1')
    ON CONFLICT (effect_key) DO NOTHING;
    GET DIAGNOSTICS claimed = ROW_COUNT;
    IF claimed <> 1 THEN RAISE EXCEPTION 'первый вызов не занял ключ'; END IF;

    -- Второй исполнитель того же вызова ключ не занимает.
    INSERT INTO effect_probe (effect_key, run_id, user_id, tool_name, tool_call_id)
    VALUES ('k1', '00000000-0000-0000-0000-000000000001', 42, 'save_task', 'call-1')
    ON CONFLICT (effect_key) DO NOTHING;
    GET DIAGNOSTICS claimed = ROW_COUNT;
    IF claimed <> 0 THEN RAISE EXCEPTION 'второй вызов занял уже занятый ключ'; END IF;

    -- ...и видит running, то есть не выполняет действие.
    SELECT status INTO found FROM effect_probe WHERE effect_key = 'k1' AND user_id = 42;
    IF found.status <> 'running' THEN
        RAISE EXCEPTION 'состояние занятого ключа: %', found.status;
    END IF;

    -- Повторяемый отказ.
    UPDATE effect_probe SET status = 'failed', error_code = 'Error', retryable = true
     WHERE effect_key = 'k1' AND user_id = 42;

    -- Право на повтор забирает ровно один исполнитель.
    UPDATE effect_probe SET status = 'running', attempt = effect_probe.attempt + 1
     WHERE effect_key = 'k1' AND user_id = 42 AND status = 'failed'
     RETURNING effect_probe.attempt INTO next_attempt;
    IF next_attempt IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'первый повтор получил номер попытки %', next_attempt;
    END IF;

    next_attempt := NULL;
    UPDATE effect_probe SET status = 'running', attempt = effect_probe.attempt + 1
     WHERE effect_key = 'k1' AND user_id = 42 AND status = 'failed'
     RETURNING effect_probe.attempt INTO next_attempt;
    IF next_attempt IS NOT NULL THEN
        RAISE EXCEPTION 'право на повтор забрали дважды: попытка %', next_attempt;
    END IF;

    -- Чужая область строку не видит и не правит.
    UPDATE effect_probe SET status = 'succeeded'
     WHERE effect_key = 'k1' AND user_id = 43;
    GET DIAGNOSTICS claimed = ROW_COUNT;
    IF claimed <> 0 THEN RAISE EXCEPTION 'чужой владелец изменил запись эффекта'; END IF;
END $$;

ROLLBACK;
