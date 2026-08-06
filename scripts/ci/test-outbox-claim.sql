-- =====================================================================
-- Выборка параллельной доставки: приоритет обгоняет очередь, порядок
-- внутри чата сохраняется.
--
-- Проверяется настоящим запросом на настоящем PostgreSQL. Поддельная
-- база в тестах повторяет его логику, но не его семантику: сравнение
-- кортежей, частичные индексы и SKIP LOCKED подделкой не проверяются.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (telegram_id, username) VALUES (900001, 'проба-доставки')
ON CONFLICT (telegram_id) DO NOTHING;

-- Чат 100: три части одного ответа плюс служебный статус и кризис.
-- Чат 200: одно сообщение.
INSERT INTO telegram_outbox (idempotency_key, chat_id, telegram_method, payload, priority)
VALUES
    ('проба:100:1', 100, 'sendMessage',    '{}'::jsonb, 20),
    ('проба:100:2', 100, 'sendMessage',    '{}'::jsonb, 20),
    ('проба:100:3', 100, 'sendMessage',    '{}'::jsonb, 20),
    ('проба:100:s', 100, 'sendChatAction', '{}'::jsonb, 50),
    ('проба:100:k', 100, 'sendMessage',    '{}'::jsonb, 10),
    ('проба:200:1', 200, 'sendMessage',    '{}'::jsonb, 20);

-- Тот же запрос, что у воркера: одна строка на чат, без чатов, занятых
-- этим процессом, и без строк, у которых есть более раннее
-- незавершённое сообщение того же чата.
CREATE TEMP VIEW claimable AS
SELECT t.id, t.chat_id, t.priority, t.idempotency_key
  FROM telegram_outbox t
 WHERE t.attempts < 5
   AND t.status IN ('pending', 'retry')
   AND t.available_at <= now()
   AND NOT (t.chat_id = ANY(ARRAY[]::bigint[]))
   AND NOT EXISTS (
     SELECT 1 FROM telegram_outbox earlier
      WHERE earlier.chat_id = t.chat_id
        AND earlier.status IN ('pending', 'sending', 'retry')
        AND (earlier.priority, earlier.id) < (t.priority, t.id)
   )
 ORDER BY t.priority, t.available_at, t.id;

DO $$
DECLARE
    picked text[];
BEGIN
    SELECT array_agg(idempotency_key ORDER BY priority, id) INTO picked FROM claimable;

    -- Доступны ровно две строки: кризис чата 100 и единственное
    -- сообщение чата 200. Остальные ждут своей очереди в своём чате.
    IF picked <> ARRAY['проба:100:k', 'проба:200:1'] THEN
        RAISE EXCEPTION 'выборка вернула не то: %', picked;
    END IF;
END $$;

-- Кризис ушёл — следующей становится первая часть ответа, а не вторая
-- и не служебный статус.
UPDATE telegram_outbox SET status = 'sent' WHERE idempotency_key = 'проба:100:k';

DO $$
DECLARE
    next_key text;
BEGIN
    SELECT idempotency_key INTO next_key
      FROM claimable WHERE chat_id = 100;
    IF next_key <> 'проба:100:1' THEN
        RAISE EXCEPTION 'порядок внутри чата нарушен: %', next_key;
    END IF;
END $$;

-- Пока первая часть доставляется, вторая недоступна: иначе человек
-- получил бы ответ в переставленном порядке.
UPDATE telegram_outbox SET status = 'sending' WHERE idempotency_key = 'проба:100:1';

DO $$
DECLARE
    blocked bigint;
BEGIN
    SELECT count(*) INTO blocked FROM claimable WHERE chat_id = 100;
    IF blocked <> 0 THEN
        RAISE EXCEPTION 'чат отдал вторую часть, не доставив первую';
    END IF;
END $$;

-- Служебный статус пропускает вперёд весь ответ.
UPDATE telegram_outbox SET status = 'sent'
 WHERE idempotency_key IN ('проба:100:1', 'проба:100:2', 'проба:100:3');

DO $$
DECLARE
    last_key text;
BEGIN
    SELECT idempotency_key INTO last_key FROM claimable WHERE chat_id = 100;
    IF last_key <> 'проба:100:s' THEN
        RAISE EXCEPTION 'служебный статус вышел не последним: %', last_key;
    END IF;
END $$;

ROLLBACK;
