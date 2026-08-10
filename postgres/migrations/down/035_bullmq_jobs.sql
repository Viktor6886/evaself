-- =====================================================================
-- Откат 035: убрать слой фоновых заданий.
--
-- Существующих строк не трогает: все четыре таблицы заведены миграцией
-- 035 и ничем, кроме неё, не пишутся. Продуктовых задач на этот слой
-- ещё не переносили, поэтому после отката теряется только неопубликованная
-- очередь намерений — включать флаг EVA_BULLMQ_JOBS после этого нельзя.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS job_dead_letters_queue_idx;
DROP INDEX IF EXISTS job_runs_job_idx;
DROP INDEX IF EXISTS job_runs_lease_idx;
DROP INDEX IF EXISTS job_outbox_dedup_idx;
DROP INDEX IF EXISTS job_outbox_pending_idx;

DROP TABLE IF EXISTS job_dead_letters;
DROP TABLE IF EXISTS job_schedules;
DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS job_outbox;

DELETE FROM schema_migrations WHERE version = '035_bullmq_jobs';

COMMIT;
