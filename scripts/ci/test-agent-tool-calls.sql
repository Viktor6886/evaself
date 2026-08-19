-- =====================================================================
-- Журнал вызовов нативных инструментов — на настоящем PostgreSQL.
--
-- Проверяется то, чего не видно в тестах на подделках: повторная запись
-- того же вызова не создаёт вторую строку, а поздно пришедший исход
-- дописывается к уже записанному вызову.
--
-- Скрипт ничего не оставляет после себя: работает во временной копии
-- таблицы и падает с ошибкой, если правило нарушено.
-- =====================================================================

BEGIN;

CREATE TEMP TABLE calls (LIKE agent_tool_calls INCLUDING ALL) ON COMMIT DROP;

-- Ход открыл навык; результат в этом же потоке ещё не пришёл.
INSERT INTO calls (user_id, conversation_id, tool_name, skill_name, tool_call_id, run_id, succeeded)
VALUES (100, 'conv-1', 'Skill', 'cbt', 'call-1', 'run-1', NULL);

-- Тот же ход разобран второй раз — например, при восстановлении.
INSERT INTO calls (user_id, conversation_id, tool_name, skill_name, tool_call_id, run_id, succeeded)
VALUES (100, 'conv-1', 'Skill', 'cbt', 'call-1', 'run-1', true)
ON CONFLICT (user_id, tool_call_id) DO UPDATE
   SET succeeded = COALESCE(EXCLUDED.succeeded, calls.succeeded);

-- Разные люди могут иметь одинаковый идентификатор вызова: ключ
-- составной, и вторая строка обязана появиться.
INSERT INTO calls (user_id, conversation_id, tool_name, skill_name, tool_call_id, run_id, succeeded)
VALUES (200, 'conv-2', 'Skill', 'act', 'call-1', 'run-2', false);

DO $$
DECLARE rows_for_100 integer; outcome boolean; total integer;
BEGIN
  SELECT count(*) INTO rows_for_100 FROM calls WHERE user_id = 100;
  IF rows_for_100 <> 1 THEN
    RAISE EXCEPTION 'повторный разбор хода создал % строк вместо одной', rows_for_100;
  END IF;

  SELECT succeeded INTO outcome FROM calls WHERE user_id = 100 AND tool_call_id = 'call-1';
  IF outcome IS NOT TRUE THEN
    RAISE EXCEPTION 'поздний исход вызова не дописался к записи';
  END IF;

  SELECT count(*) INTO total FROM calls;
  IF total <> 2 THEN
    RAISE EXCEPTION 'одинаковый идентификатор вызова у разных людей слился в одну строку';
  END IF;
END $$;

ROLLBACK;
