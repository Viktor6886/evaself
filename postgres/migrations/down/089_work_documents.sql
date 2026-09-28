BEGIN;

-- Таблица появилась в этой миграции и хранит только копии на сутки:
-- откат снимает её, других строк здесь нет.
DROP TABLE IF EXISTS work_documents;

DELETE FROM schema_migrations WHERE version = '089_work_documents';

COMMIT;
