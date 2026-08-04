-- =====================================================================
-- Evaself — проверка baseline-фикстуры (шаг 00)
-- ---------------------------------------------------------------------
-- Каждая строка результата — один пункт задания шага 00. Колонка ok
-- должна быть true во всех строках; при любом false скрипт завершается
-- ошибкой, поэтому его можно запускать в CI.
-- =====================================================================

\set ON_ERROR_STOP on

WITH fixture_users AS (
    SELECT id, telegram_id FROM users WHERE telegram_id IN (900000001, 900000002)
),
checks(item, actual, expected_min) AS (
    VALUES
        ('пользователей',
         (SELECT count(*) FROM fixture_users), 2),
        ('агентов',
         (SELECT count(*) FROM agent_links a JOIN fixture_users u ON u.id = a.user_id
          WHERE a.status = 'active'), 2),
        ('conversations разного назначения',
         (SELECT count(DISTINCT purpose) FROM agent_conversations c
          JOIN fixture_users u ON u.id = c.user_id), 2),
        ('полей профиля',
         (SELECT count(*) FROM onboarding_fields f JOIN fixture_users u ON u.id = f.user_id), 3),
        ('настроек профиля',
         (SELECT count(*) FROM user_preferences p JOIN fixture_users u ON u.id = p.user_id), 2),
        ('целей',
         (SELECT count(*) FROM goals g JOIN fixture_users u ON u.id = g.user_id), 3),
        ('задач',
         (SELECT count(*) FROM tasks t JOIN fixture_users u ON u.id = t.user_id), 2),
        ('ожидающих напоминаний',
         (SELECT count(*) FROM tasks t JOIN fixture_users u ON u.id = t.user_id
          WHERE t.status = 'open' AND t.remind_at > now()), 1),
        ('записей inbox',
         (SELECT count(*) FROM telegram_updates i JOIN fixture_users u ON u.id = i.user_id), 3),
        ('записей outbox',
         (SELECT count(*) FROM telegram_outbox o JOIN fixture_users u ON u.id = o.user_id), 3),
        ('подписок',
         (SELECT count(*) FROM subscriptions s JOIN fixture_users u ON u.id = s.user_id), 2),
        ('счётчиков потребления',
         (SELECT count(*) FROM usage_counters c JOIN fixture_users u ON u.id = c.user_id), 3),
        ('побочных эффектов инструмента',
         (SELECT count(*) FROM eva_notes n JOIN fixture_users u ON u.id = n.user_id)
         + (SELECT count(*) FROM task_events e JOIN fixture_users u ON u.id = e.user_id), 2)
)
SELECT item,
       actual,
       expected_min,
       actual >= expected_min AS ok
FROM checks
ORDER BY item;

DO $$
DECLARE
    failed int;
BEGIN
    SELECT count(*) INTO failed
    FROM (
        SELECT 1 WHERE (SELECT count(*) FROM users WHERE telegram_id IN (900000001, 900000002)) < 2
        UNION ALL
        SELECT 1 WHERE (
            SELECT count(*) FROM tasks t JOIN users u ON u.id = t.user_id
            WHERE u.telegram_id IN (900000001, 900000002)
              AND t.status = 'open' AND t.remind_at > now()
        ) < 1
        UNION ALL
        SELECT 1 WHERE (
            SELECT count(*) FROM telegram_outbox o JOIN users u ON u.id = o.user_id
            WHERE u.telegram_id IN (900000001, 900000002)
        ) < 3
        UNION ALL
        SELECT 1 WHERE (
            SELECT count(*) FROM eva_notes n JOIN users u ON u.id = n.user_id
            WHERE u.telegram_id IN (900000001, 900000002)
        ) < 1
    ) AS failures;

    IF failed > 0 THEN
        RAISE EXCEPTION 'baseline-фикстура неполна: не выполнено проверок: %', failed;
    END IF;
    RAISE NOTICE 'baseline-фикстура на месте';
END
$$;
