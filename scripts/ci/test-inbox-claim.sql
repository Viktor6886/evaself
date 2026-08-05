-- =====================================================================
-- Claim параллельного диспетчера — на настоящем PostgreSQL.
--
-- Поддельный inbox в тестах TypeScript повторяет правила выборки, но не
-- проверяет сам SQL: ни `FOR UPDATE OF t SKIP LOCKED`, ни сравнение пар
-- `(received_at, update_id)`, ни `IS NOT DISTINCT FROM` для записи без
-- опознанного отправителя. Здесь проверяется именно запрос.
--
-- Скрипт ничего не оставляет после себя: работает во временной таблице
-- с той же структурой, что и `telegram_updates`, и падает с ошибкой,
-- если правило нарушено.
-- =====================================================================

BEGIN;

CREATE TEMP TABLE claim_probe (LIKE telegram_updates INCLUDING ALL) ON COMMIT DROP;

-- Трое пишут почти одновременно. У первого два сообщения подряд, у
-- второго одно, у третьего одно уже обработанное и одно новое.
INSERT INTO claim_probe
  (update_id, telegram_user_id, chat_id, message_id, message_kind,
   status, payload, received_at, available_at)
VALUES
  (1, 100, 100, 1, 'text', 'queued',    '{"update_id":1}'::jsonb, now() - interval '5 s', now()),
  (2, 100, 100, 2, 'text', 'queued',    '{"update_id":2}'::jsonb, now() - interval '4 s', now()),
  (3, 200, 200, 1, 'text', 'queued',    '{"update_id":3}'::jsonb, now() - interval '3 s', now()),
  (4, 300, 300, 1, 'text', 'completed', '{"update_id":4}'::jsonb, now() - interval '9 s', now()),
  (5, 300, 300, 2, 'text', 'queued',    '{"update_id":5}'::jsonb, now() - interval '2 s', now()),
  -- Срок доступности ещё не наступил: запись брать нельзя.
  (6, 400, 400, 1, 'text', 'retry',     '{"update_id":6}'::jsonb, now() - interval '1 s',
   now() + interval '1 h'),
  -- Попытки исчерпаны.
  (7, 500, 500, 1, 'text', 'queued',    '{"update_id":7}'::jsonb, now() - interval '1 s', now()),
  -- Живая аренда чужого воркера.
  (8, 600, 600, 1, 'text', 'processing','{"update_id":8}'::jsonb, now() - interval '1 s', now()),
  -- Аренда истекла: запись возвращается в работу.
  (9, 700, 700, 1, 'text', 'processing','{"update_id":9}'::jsonb, now() - interval '1 s', now());

UPDATE claim_probe SET attempts = 3 WHERE update_id = 7;
UPDATE claim_probe SET locked_at = now(), locked_by = 'живой' WHERE update_id = 8;
UPDATE claim_probe SET locked_at = now() - interval '10 min', locked_by = 'умерший'
 WHERE update_id = 9;

DO $$
DECLARE
    claimed bigint[];
BEGIN
    SELECT array_agg(update_id ORDER BY update_id) INTO claimed
      FROM (
        SELECT t.update_id
          FROM claim_probe t
         WHERE t.attempts < 3
           AND t.payload IS NOT NULL
           AND (
             (t.status IN ('queued', 'retry') AND t.available_at <= now())
             OR (t.status = 'processing'
                 AND t.locked_at < now() - make_interval(secs => 30))
           )
           AND NOT (t.telegram_user_id = ANY(ARRAY[]::bigint[]))
           AND NOT EXISTS (
             SELECT 1
               FROM claim_probe earlier
              WHERE earlier.status IN ('queued', 'processing', 'retry')
                AND earlier.telegram_user_id IS NOT DISTINCT FROM t.telegram_user_id
                AND (earlier.received_at, earlier.update_id) < (t.received_at, t.update_id)
           )
         ORDER BY t.received_at, t.update_id
         FOR UPDATE OF t SKIP LOCKED
         LIMIT 10
      ) picked;

    -- 1 — первое сообщение первого человека (2 блокируется им же);
    -- 3 — единственное второго;
    -- 5 — новое третьего (завершённое 4 не блокирует);
    -- 9 — запись с истёкшей арендой.
    -- Не взяты: 2 (есть более раннее), 6 (не наступил срок),
    -- 7 (исчерпаны попытки), 8 (живая аренда).
    IF claimed IS DISTINCT FROM ARRAY[1, 3, 5, 9]::bigint[] THEN
        RAISE EXCEPTION 'claim вернул % вместо {1,3,5,9}', claimed;
    END IF;
END $$;

-- Исключение пользователей, чей ход уже идёт в этом процессе.
DO $$
DECLARE
    claimed bigint[];
BEGIN
    SELECT array_agg(update_id ORDER BY update_id) INTO claimed
      FROM (
        SELECT t.update_id
          FROM claim_probe t
         WHERE t.attempts < 3
           AND t.payload IS NOT NULL
           AND (t.status IN ('queued', 'retry') AND t.available_at <= now())
           AND NOT (t.telegram_user_id = ANY(ARRAY[100, 200]::bigint[]))
           AND NOT EXISTS (
             SELECT 1
               FROM claim_probe earlier
              WHERE earlier.status IN ('queued', 'processing', 'retry')
                AND earlier.telegram_user_id IS NOT DISTINCT FROM t.telegram_user_id
                AND (earlier.received_at, earlier.update_id) < (t.received_at, t.update_id)
           )
         ORDER BY t.received_at, t.update_id
         LIMIT 10
      ) picked;

    IF claimed IS DISTINCT FROM ARRAY[5]::bigint[] THEN
        RAISE EXCEPTION 'исключение занятых людей вернуло % вместо {5}', claimed;
    END IF;
END $$;

-- Следующие сообщения того же человека — выборка для объединения.
DO $$
DECLARE
    followed bigint[];
BEGIN
    SELECT array_agg(update_id ORDER BY update_id) INTO followed
      FROM (
        SELECT t.update_id
          FROM claim_probe t
         WHERE t.telegram_user_id = 100
           AND t.update_id > 1
           AND t.attempts < 3
           AND t.payload IS NOT NULL
           AND t.status IN ('queued', 'retry')
           AND t.available_at <= now()
         ORDER BY t.received_at, t.update_id
         LIMIT 5
      ) picked;

    IF followed IS DISTINCT FROM ARRAY[2]::bigint[] THEN
        RAISE EXCEPTION 'follow-up вернул % вместо {2}', followed;
    END IF;
END $$;

-- Индексы claim действительно созданы миграцией 030, а не забыты.
-- План здесь не проверяется намеренно: у временной таблицы своей
-- статистики нет, и планировщик на ней покажет не то, что в production.
DO $$
BEGIN
    IF (SELECT count(*) FROM pg_indexes
         WHERE tablename = 'telegram_updates'
           AND indexname IN ('telegram_updates_claim_idx',
                             'telegram_updates_user_pending_idx')) <> 2 THEN
        RAISE EXCEPTION 'индексы claim не созданы миграцией 030';
    END IF;
END $$;

ROLLBACK;
