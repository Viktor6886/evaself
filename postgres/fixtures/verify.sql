-- =====================================================================
-- Evaself — проверка baseline-фикстуры (шаг 00)
-- ---------------------------------------------------------------------
-- Каждая строка результата — один пункт задания шага 00. Скрипт
-- завершается ошибкой, если хотя бы у одной строки ok = false, поэтому
-- его можно использовать как гейт в CI.
--
-- Набор проверок объявлен ровно один раз, во временной таблице
-- fixture_checks. И вывод для человека, и гейт читают её же: список
-- условий и список того, что реально блокирует, не могут разойтись.
-- =====================================================================

\set ON_ERROR_STOP on

-- Явный pg_temp: скрипт не должен задеть одноимённую таблицу в public,
-- если такая когда-нибудь появится.
DROP TABLE IF EXISTS pg_temp.fixture_checks;

CREATE TEMP TABLE fixture_checks AS
WITH fixture_users AS (
    SELECT id FROM users WHERE telegram_id IN (900000001, 900000002)
),
checks(item, actual, expected_min) AS (
    VALUES
        ('пользователей',
         (SELECT count(*) FROM fixture_users), 2),
        ('агентов',
         (SELECT count(*) FROM agent_links a JOIN fixture_users u ON u.id = a.user_id
          WHERE a.status = 'active'), 2),
        ('conversations',
         (SELECT count(*) FROM agent_conversations c
          JOIN fixture_users u ON u.id = c.user_id), 4),
        ('назначений conversations',
         (SELECT count(DISTINCT purpose) FROM agent_conversations c
          JOIN fixture_users u ON u.id = c.user_id), 2),
        ('полей профиля',
         (SELECT count(*) FROM onboarding_fields f JOIN fixture_users u ON u.id = f.user_id), 3),
        ('настроек профиля',
         (SELECT count(*) FROM user_preferences p JOIN fixture_users u ON u.id = p.user_id), 2),
        ('ориентиров профиля',
         (SELECT count(*) FROM user_north n JOIN fixture_users u ON u.id = n.user_id), 1),
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
        ('заметок от инструмента save_note',
         (SELECT count(*) FROM eva_notes n JOIN fixture_users u ON u.id = n.user_id), 1),
        ('событий от инструмента save_task',
         (SELECT count(*) FROM task_events e JOIN fixture_users u ON u.id = e.user_id
          WHERE e.event_type = 'created'), 1)
)
SELECT item,
       actual,
       expected_min,
       actual >= expected_min AS ok
FROM checks;

SELECT item, actual, expected_min, ok
FROM fixture_checks
ORDER BY ok, item;

DO $$
DECLARE
    failed_items text;
    failed_count int;
BEGIN
    SELECT count(*), string_agg(item || ' (' || actual || ' < ' || expected_min || ')', '; ' ORDER BY item)
      INTO failed_count, failed_items
      FROM fixture_checks
     WHERE NOT ok;

    IF failed_count > 0 THEN
        RAISE EXCEPTION 'baseline-фикстура неполна, не выполнено проверок % из %: %',
            failed_count,
            (SELECT count(*) FROM fixture_checks),
            failed_items;
    END IF;

    RAISE NOTICE 'baseline-фикстура на месте: пройдено проверок %',
        (SELECT count(*) FROM fixture_checks);
END
$$;
