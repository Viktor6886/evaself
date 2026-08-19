-- Откат журнала вызовов нативных инструментов.
--
-- Таблица содержит только метаданные наблюдений: продуктовых данных, на
-- которые кто-то ссылается, в ней нет, и её удаление ничего не рвёт.
BEGIN;
DROP TABLE IF EXISTS agent_tool_calls;
DELETE FROM schema_migrations WHERE version = '059_agent_tool_calls';
COMMIT;
