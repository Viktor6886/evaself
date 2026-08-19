-- =====================================================================
-- Опрос: один вызов инструмента — один опрос, один голос — один ход.
--
-- Поддельная база в тестах TypeScript повторяет правила, но не сам
-- запрос. Здесь проверяется именно он: вставка с `ON CONFLICT DO
-- NOTHING` обязана вернуть уже существующую строку, а не пустоту, иначе
-- повтор вызова после обрыва отправил бы второй опрос; условное
-- обновление голоса обязано молчать на том же выборе и отвечать на
-- изменённом.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================
BEGIN;

CREATE TEMP TABLE probe_polls (LIKE telegram_polls INCLUDING ALL) ON COMMIT DROP;
CREATE TEMP TABLE probe_answers (LIKE telegram_poll_answers INCLUDING ALL) ON COMMIT DROP;

-- Те же два оператора, что в db.createPoll. Чтение вынесено из вставки
-- намеренно: внутри одного оператора выборка работает со снимком,
-- снятым до ожидания на уникальном индексе, и строку победителя гонки
-- могла бы не увидеть.
CREATE OR REPLACE FUNCTION pg_temp.create_poll(p_user bigint, p_call text)
RETURNS TABLE (id uuid, poll_id text, created boolean) AS $fn$
DECLARE fresh_id uuid; fresh_poll text;
BEGIN
  INSERT INTO probe_polls
    (user_id, chat_id, conversation_id, tool_call_id, run_id,
     question, options, is_anonymous, allows_multiple)
  VALUES (p_user, 42, 'c1', p_call, 'r1', 'Как ты?', ARRAY['Хорошо','Устал'], false, false)
  ON CONFLICT (user_id, tool_call_id) DO NOTHING
  RETURNING probe_polls.id, probe_polls.poll_id INTO fresh_id, fresh_poll;

  IF fresh_id IS NOT NULL THEN
    RETURN QUERY SELECT fresh_id, fresh_poll, true;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.poll_id, false
    FROM probe_polls p
   WHERE p.user_id = p_user AND p.tool_call_id = p_call;
END;
$fn$ LANGUAGE plpgsql;

-- Тот же запрос, что в db.recordPollAnswer.
CREATE OR REPLACE FUNCTION pg_temp.record_answer(p_poll text, p_user bigint, p_options int[])
RETURNS TABLE (recorded boolean) AS $fn$
INSERT INTO probe_answers (poll_id, user_id, option_ids)
VALUES (p_poll, p_user, p_options)
ON CONFLICT (poll_id, user_id) DO UPDATE
   SET option_ids = EXCLUDED.option_ids, answered_at = now()
 WHERE probe_answers.option_ids IS DISTINCT FROM EXCLUDED.option_ids
RETURNING true;
$fn$ LANGUAGE sql;

DO $$
DECLARE first_id uuid; second_id uuid; was_created boolean; rows_seen int; ok boolean;
BEGIN
  SELECT id, created INTO first_id, was_created FROM pg_temp.create_poll(100, 'call-1');
  IF NOT was_created THEN RAISE EXCEPTION 'первый вызов не создал опрос'; END IF;

  -- Повтор того же вызова инструмента: та же строка, второго опроса нет.
  SELECT id, created INTO second_id, was_created FROM pg_temp.create_poll(100, 'call-1');
  IF was_created THEN RAISE EXCEPTION 'повтор вызова создал второй опрос'; END IF;
  IF second_id IS DISTINCT FROM first_id THEN
    RAISE EXCEPTION 'повтор вызова вернул другую строку: % вместо %', second_id, first_id;
  END IF;
  SELECT count(*) INTO rows_seen FROM probe_polls;
  IF rows_seen <> 1 THEN RAISE EXCEPTION 'в чате оказалось % опросов', rows_seen; END IF;

  -- Другой человек с тем же идентификатором вызова — свой опрос.
  PERFORM pg_temp.create_poll(200, 'call-1');
  SELECT count(*) INTO rows_seen FROM probe_polls;
  IF rows_seen <> 2 THEN RAISE EXCEPTION 'опрос другого человека не создан'; END IF;

  UPDATE probe_polls SET poll_id = 'tg-1', sent_at = now() WHERE id = first_id;
  -- Один опрос Telegram — одна строка: иначе голос связался бы с двумя.
  BEGIN
    UPDATE probe_polls SET poll_id = 'tg-1' WHERE user_id = 200;
    RAISE EXCEPTION 'два опроса получили один идентификатор Telegram';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  SELECT recorded INTO ok FROM pg_temp.record_answer('tg-1', 100, ARRAY[1]);
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'первый голос не записан'; END IF;

  -- Тот же апдейт пришёл повторно: второго хода быть не должно.
  SELECT recorded INTO ok FROM pg_temp.record_answer('tg-1', 100, ARRAY[1]);
  IF ok IS NOT NULL THEN RAISE EXCEPTION 'повтор того же голоса объявлен новым'; END IF;

  -- Человек передумал: это новый выбор.
  SELECT recorded INTO ok FROM pg_temp.record_answer('tg-1', 100, ARRAY[0]);
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'изменённый голос не записан'; END IF;

  SELECT count(*) INTO rows_seen FROM probe_answers;
  IF rows_seen <> 1 THEN RAISE EXCEPTION 'на человека и опрос оказалось % строк', rows_seen; END IF;
END $$;

ROLLBACK;
