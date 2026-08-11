-- =====================================================================
-- Откат 044: снять индексы temporal-памяти.
--
-- Строк не трогает: индекс данных не хранит. После отката запросы к
-- памяти продолжают работать, просто медленнее — по индексам, которые
-- были на `memory_nodes` и `memory_edges` до шага 15.
--
-- Без BEGIN/COMMIT по той же причине, что и forward: `DROP INDEX
-- CONCURRENTLY` внутри транзакции невозможен.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS memory_edges_valid_idx;
DROP INDEX CONCURRENTLY IF EXISTS memory_nodes_valid_idx;
DROP INDEX CONCURRENTLY IF EXISTS memory_nodes_entity_idx;
DROP INDEX CONCURRENTLY IF EXISTS memory_nodes_fact_key_idx;

DELETE FROM schema_migrations WHERE version = '044_temporal_memory_indexes';
