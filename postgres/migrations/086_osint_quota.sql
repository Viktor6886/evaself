-- =====================================================================
-- 086 — квота OSINT-исследований по тарифу
--
-- Метрика `osint` ведётся так же, как поиск и документы: лимит в
-- `quotas`, расход в `usage_counters`, остаток в `v_quota_status`.
-- Исследование списывает единицу при создании.
--
-- Начальные значения — за месяц и скромные: исследование делает сотни
-- внешних запросов, и тариф без явной строки был бы безлимитным.
-- Владелец меняет их в панели, раздел «Тарифы». Уже существующие строки
-- не трогаются.
-- =====================================================================
BEGIN;

INSERT INTO quotas (plan, metric, period, limit_value, free_value, description) VALUES
    ('free', 'osint', 'month', 1,  0, 'OSINT-исследования'),
    ('plus', 'osint', 'month', 10, 1, 'OSINT-исследования'),
    ('max',  'osint', 'month', 30, 1, 'OSINT-исследования')
ON CONFLICT (plan, metric, period) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('086_osint_quota')
ON CONFLICT DO NOTHING;

COMMIT;
