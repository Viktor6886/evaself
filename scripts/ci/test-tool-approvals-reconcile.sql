-- =====================================================================
-- Примирение незакрытых подтверждений — на настоящем PostgreSQL.
--
-- Закрытие подтверждения идёт после самого действия и может не
-- состояться. Без примирения строка остаётся `approved_once` навсегда:
-- восстановление открывает её conversation при каждом старте, а разовое
-- разрешение висит выданным.
--
-- Поддельная база в тестах TypeScript повторяет правило по своим часам,
-- но самого запроса не выполняет: ни `make_interval(secs => …)`, ни
-- `COALESCE(decided_at, created_at)`, ни перечисление статусов. Здесь
-- проверяется именно поведение запросов — что снимается, что остаётся
-- нетронутым и что после этого видит выборка восстановления.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================

BEGIN;

CREATE TEMP TABLE approval_probe (LIKE tool_approvals INCLUDING ALL) ON COMMIT DROP;

DO $$
DECLARE
    digest    text := repeat('a', 64);
    reconciled int;
    reopened   int;
    stale      interval := interval '1 hour';
    found      record;
BEGIN
    -- Разовое разрешение, чьё закрытие не состоялось час назад.
    INSERT INTO approval_probe (user_id, conversation_id, sdk_request_id, tool_name, risk,
                                argument_fingerprint, status, decision, action_description,
                                created_at, decided_at)
    VALUES (42, 'conversation-stranded', 'stranded', 'delete_tasks', 'destructive',
            digest, 'approved_once', 'allow', 'подтверждение',
            now() - interval '3 hours', now() - interval '2 hours');

    -- Ожидание, на которое никто не ответил.
    INSERT INTO approval_probe (user_id, conversation_id, sdk_request_id, tool_name, risk,
                                argument_fingerprint, status, action_description, created_at)
    VALUES (42, 'conversation-stranded', 'unanswered', 'delete_tasks', 'destructive',
            digest, 'pending', 'подтверждение', now() - interval '2 hours');

    -- Отказ человека: его решение, и примирение его не переписывает.
    INSERT INTO approval_probe (user_id, conversation_id, sdk_request_id, tool_name, risk,
                                argument_fingerprint, status, decision, action_description,
                                created_at, decided_at)
    VALUES (42, 'conversation-stranded', 'refused', 'delete_tasks', 'destructive',
            digest, 'denied', 'deny', 'подтверждение',
            now() - interval '3 hours', now() - interval '2 hours');

    -- Свежее решение живого хода: его трогать нельзя.
    INSERT INTO approval_probe (user_id, conversation_id, sdk_request_id, tool_name, risk,
                                argument_fingerprint, status, decision, action_description,
                                created_at, decided_at)
    VALUES (42, 'conversation-live', 'fresh', 'delete_tasks', 'destructive',
            digest, 'approved_once', 'allow', 'подтверждение',
            now() - interval '2 minutes', now() - interval '1 minute');

    UPDATE approval_probe
       SET status = 'expired', decision = 'deny',
           decided_at = COALESCE(decided_at, now())
     WHERE status IN ('pending', 'approved_once', 'approved_session')
       AND COALESCE(decided_at, created_at) < now() - stale;
    GET DIAGNOSTICS reconciled = ROW_COUNT;

    IF reconciled <> 2 THEN
        RAISE EXCEPTION 'примирение задело % строк вместо двух застрявших', reconciled;
    END IF;

    SELECT status, decision INTO found FROM approval_probe
     WHERE user_id = 42 AND sdk_request_id = 'stranded';
    IF found.status <> 'expired' OR found.decision <> 'deny' THEN
        RAISE EXCEPTION 'разовое разрешение осталось выданным: % / %', found.status, found.decision;
    END IF;

    -- Отметка решения сохраняется: по ней видно, когда человек ответил.
    SELECT decided_at < now() - interval '90 minutes' AS kept INTO found
      FROM approval_probe WHERE user_id = 42 AND sdk_request_id = 'stranded';
    IF NOT found.kept THEN
        RAISE EXCEPTION 'примирение переписало отметку решения';
    END IF;

    SELECT status INTO found FROM approval_probe
     WHERE user_id = 42 AND sdk_request_id = 'refused';
    IF found.status <> 'denied' THEN
        RAISE EXCEPTION 'отказ человека переписан: %', found.status;
    END IF;

    SELECT status INTO found FROM approval_probe
     WHERE user_id = 42 AND sdk_request_id = 'fresh';
    IF found.status <> 'approved_once' THEN
        RAISE EXCEPTION 'свежее решение снято: %', found.status;
    END IF;

    -- Восстановление после примирения открывает только живую
    -- conversation: застрявшая больше не возвращается ни при одном старте.
    SELECT count(DISTINCT conversation_id) INTO reopened FROM approval_probe
     WHERE status IN ('pending', 'approved_once', 'approved_session', 'denied')
       AND conversation_id IS NOT NULL
       AND COALESCE(decided_at, created_at) >= now() - stale;

    IF reopened <> 1 THEN
        RAISE EXCEPTION 'восстановление открыло % conversations вместо одной живой', reopened;
    END IF;

    SELECT conversation_id INTO found FROM approval_probe
     WHERE status IN ('pending', 'approved_once', 'approved_session', 'denied')
       AND conversation_id IS NOT NULL
       AND COALESCE(decided_at, created_at) >= now() - stale;
    IF found.conversation_id <> 'conversation-live' THEN
        RAISE EXCEPTION 'открыта не та conversation: %', found.conversation_id;
    END IF;
END $$;

ROLLBACK;
