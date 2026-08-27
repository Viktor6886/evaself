-- Откат: снимается цена в звёздах и пробные, тариф возвращает прежнее имя.
--
-- Строки quotas для новых метрик не удаляются: у них лимит -1, они ничего
-- не ограничивают, а их удаление вслепую задело бы и то, что владелец мог
-- успеть настроить. Прежний код их просто не читает.

BEGIN;

UPDATE quotas       SET plan = 'pro' WHERE plan = 'max';
UPDATE subscriptions SET plan = 'pro' WHERE plan = 'max';

DROP TABLE IF EXISTS plan_prices;

ALTER TABLE quotas DROP CONSTRAINT IF EXISTS quotas_free_check;
ALTER TABLE quotas DROP COLUMN IF EXISTS free_value;

DELETE FROM schema_migrations WHERE version = '071_plan_pricing_and_usage';

COMMIT;
