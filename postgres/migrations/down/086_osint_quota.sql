BEGIN;

-- Откат снимает только лимиты метрики: без строки в quotas исследования
-- снова не ограничены тарифом. Счётчики расхода остаются.
DELETE FROM quotas WHERE metric = 'osint';

DELETE FROM schema_migrations WHERE version = '086_osint_quota';

COMMIT;
