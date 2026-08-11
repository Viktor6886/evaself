-- =====================================================================
-- Откат 036: убрать проактивные сообщения, суточные эпизоды, результаты
-- agent job и сверки режима зеркала.
--
-- Существующих строк не трогает: все четыре таблицы заведены миграцией
-- 036 и ничем, кроме неё, не пишутся. `tasks`, `task_events`,
-- `heartbeat_state` и `user_checkins` остаются нетронутыми, поэтому
-- старый путь напоминаний и heartbeat после отката работает как раньше.
--
-- После отката проактивные задания на очередях включать нельзя: без
-- `proactive_messages` пропадает защита от второго сообщения.
-- =====================================================================

BEGIN;

-- Строки расписаний, засеянные этой миграцией. Удаляются поимённо:
-- расписание, заведённое человеком, откат чужого шага не трогает.
DELETE FROM job_schedules
 WHERE code IN ('maintenance_reconcile', 'proactive_reminder', 'proactive_heartbeat',
                'checkin_morning', 'checkin_evening');

DROP INDEX IF EXISTS job_mirror_samples_type_idx;
DROP INDEX IF EXISTS agent_job_results_user_idx;
DROP INDEX IF EXISTS proactive_messages_user_recent_idx;

DROP TABLE IF EXISTS job_mirror_samples;
DROP TABLE IF EXISTS agent_job_results;
-- Эпизоды ссылаются на проактивные сообщения, поэтому уходят раньше них.
DROP TABLE IF EXISTS checkin_episodes;
DROP TABLE IF EXISTS proactive_messages;

DELETE FROM schema_migrations WHERE version = '036_jobs_proactive';

COMMIT;
