-- =====================================================================
-- Токен inline-кнопки: один клик, свой владелец, свой срок.
--
-- Поддельная база в тестах TypeScript повторяет правила, но не сам
-- запрос, а здесь всё держится именно на нём: выборка кандидата и
-- пометка «использован» идут одним оператором, чтобы между ними не было
-- окна, в котором двойной клик заводит два хода.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================
BEGIN;

CREATE TEMP TABLE probe_tokens (LIKE telegram_callback_tokens INCLUDING ALL) ON COMMIT DROP;

INSERT INTO probe_tokens
  (token, user_id, chat_id, conversation_id, message_id, choice_label, choice_value, one_shot, expires_at)
VALUES
  ('tok-live', 100, 42, 'c1', 7, 'Да',  'yes', true, now() + interval '10 minutes'),
  ('tok-dead', 100, 42, 'c1', 7, 'Нет', 'no',  true, now() - interval '1 minute');

CREATE OR REPLACE FUNCTION pg_temp.probe(p_token text, p_user bigint)
RETURNS TABLE (value text, was_used boolean, expired boolean) AS $fn$
WITH candidate AS (
  SELECT token, used_at IS NOT NULL AS was_used, expires_at <= now() AS expired
    FROM probe_tokens WHERE token = p_token AND user_id = p_user
),
taken AS (
  UPDATE probe_tokens t SET used_at = now() FROM candidate c
   WHERE t.token = c.token AND t.user_id = p_user AND NOT c.was_used AND NOT c.expired
  RETURNING t.choice_value
)
SELECT taken.choice_value, candidate.was_used, candidate.expired
  FROM candidate LEFT JOIN taken ON true;
$fn$ LANGUAGE sql;

DO $$
DECLARE v text; used boolean; exp boolean; rows_seen int;
BEGIN
  SELECT value, was_used INTO v, used FROM pg_temp.probe('tok-live', 100);
  IF v IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'первый клик не забрал выбор: %', v; END IF;
  IF used THEN RAISE EXCEPTION 'свежий токен объявлен использованным'; END IF;

  -- Двойной клик по той же кнопке: выбор уже забран, второго хода нет.
  SELECT value, was_used INTO v, used FROM pg_temp.probe('tok-live', 100);
  IF v IS NOT NULL THEN RAISE EXCEPTION 'повторный клик завёл второй выбор: %', v; END IF;
  IF NOT used THEN RAISE EXCEPTION 'повторный клик не увидел отметку'; END IF;

  SELECT value, expired INTO v, exp FROM pg_temp.probe('tok-dead', 100);
  IF v IS NOT NULL THEN RAISE EXCEPTION 'просроченный токен сработал'; END IF;
  IF NOT exp THEN RAISE EXCEPTION 'просроченный токен не распознан'; END IF;

  -- Чужой человек прислал тот же токен: он не существует для него.
  SELECT count(*) INTO rows_seen FROM pg_temp.probe('tok-live', 200);
  IF rows_seen <> 0 THEN RAISE EXCEPTION 'токен виден не своему человеку'; END IF;
END $$;

ROLLBACK;
