-- =====================================================================
-- Откат 037: убрать задержки удаления и журнал прогонов.
--
-- Существующих строк не трогает: обе таблицы заведены миграцией 037.
-- Сами политики хранения живут в `system_settings` и этим откатом не
-- затрагиваются — их версии и аудит остаются на месте.
--
-- После отката автоматическое удаление включать нельзя: без
-- `retention_holds` пропадает единственный способ приостановить
-- удаление на время инцидента, а без `retention_runs` — возможность
-- возобновить прерванный прогон.
-- =====================================================================

BEGIN;

-- Строка расписания, засеянная этой миграцией.
DELETE FROM job_schedules WHERE code = 'retention_enforce';

DROP INDEX IF EXISTS retention_runs_class_idx;
DROP INDEX IF EXISTS retention_holds_active_idx;

DROP TABLE IF EXISTS retention_runs;
DROP TABLE IF EXISTS retention_holds;

DELETE FROM schema_migrations WHERE version = '037_retention';

COMMIT;
