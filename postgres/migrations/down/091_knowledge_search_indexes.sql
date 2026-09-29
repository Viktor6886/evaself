-- Откат 091: только индексы, данных они не содержат.
-- Без BEGIN/COMMIT: DROP INDEX CONCURRENTLY внутри транзакции невозможен.

DROP INDEX CONCURRENTLY IF EXISTS knowledge_documents_name_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS knowledge_chunks_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS knowledge_chunks_fts_russian_idx;

DELETE FROM schema_migrations WHERE version = '091_knowledge_search_indexes';
