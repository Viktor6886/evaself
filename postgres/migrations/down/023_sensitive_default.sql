-- Откат 023: вернуть прежнее умолчание.
--
-- Значения существующих строк не трогаем. Сбросить их в false означало бы
-- заново перекрыть весь трафик роутера, а разрешение оператор к этому
-- моменту мог выставить и осознанно.

BEGIN;

ALTER TABLE llm_providers
    ALTER COLUMN sensitive_data_allowed SET DEFAULT false;

DELETE FROM schema_migrations WHERE version = '023_sensitive_default';

COMMIT;
