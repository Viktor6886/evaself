-- Откат шага 17. Память не трогается: Memory Doctor её и не писал —
-- здесь снимаются только отчёты диагностики и журнал предложений.
-- Уже применённые предложения остались версиями в memory_node_versions
-- и откатываются пользовательским откатом, а не этой миграцией.

BEGIN;

DELETE FROM job_schedules WHERE code = 'memory_doctor_sweep';

DROP TABLE IF EXISTS memory_doctor_actions;
DROP TABLE IF EXISTS memory_doctor_reports;

DELETE FROM schema_migrations WHERE version = '045_memory_doctor';

COMMIT;
