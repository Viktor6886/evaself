BEGIN;

-- Откат снимает только признак. Задачи, у которых напоминания были
-- выключены, снова начнут напоминать по своему расписанию: старая схема
-- выключать их не умеет, а стирать сроки ради отката значило бы терять
-- данные человека.
ALTER TABLE tasks DROP COLUMN IF EXISTS reminders_enabled;

DELETE FROM schema_migrations WHERE version = '093_task_reminders_enabled';

COMMIT;
