-- Тарифы: правила, которые держит схема, а не договорённость кода.
--
-- Проверяется на живой базе после полного прогона миграций — как раз
-- потому, что здесь важны уникальные индексы и CHECK, которых поддельный
-- пул в TypeScript-тестах не повторяет.
\set ON_ERROR_STOP on

-- Переименование pro → max доехало и не оставило дублей.
DO $$
DECLARE leftovers int;
BEGIN
    SELECT count(*) INTO leftovers FROM quotas WHERE plan = 'pro';
    IF leftovers > 0 THEN
        RAISE EXCEPTION 'после миграции остались квоты pro: %', leftovers;
    END IF;
    SELECT count(*) INTO leftovers
      FROM (SELECT plan, metric, period FROM quotas GROUP BY 1,2,3 HAVING count(*) > 1) d;
    IF leftovers > 0 THEN
        RAISE EXCEPTION 'квоты задвоились: % пар', leftovers;
    END IF;
END $$;

-- Цена: одна на пару «тариф и срок».
INSERT INTO plan_prices (plan, period, stars) VALUES ('plus', 'week', 150);
DO $$
BEGIN
    BEGIN
        INSERT INTO plan_prices (plan, period, stars) VALUES ('plus', 'week', 200);
        RAISE EXCEPTION 'вторая цена на ту же пару принята';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- Ноль звёзд — это «цена не задана», а не «бесплатно».
    BEGIN
        INSERT INTO plan_prices (plan, period, stars) VALUES ('plus', 'month', 0);
        RAISE EXCEPTION 'нулевая цена принята';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO plan_prices (plan, period, stars) VALUES ('plus', 'year', 100);
        RAISE EXCEPTION 'неизвестный срок подписки принят';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Пробные не бывают отрицательными.
    BEGIN
        UPDATE quotas SET free_value = -1 WHERE plan = 'plus';
        RAISE EXCEPTION 'отрицательные пробные приняты';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

DELETE FROM plan_prices WHERE plan = 'plus' AND period = 'week';

\echo 'тарифы: переименование, уникальность цены и границы значений — в порядке'
