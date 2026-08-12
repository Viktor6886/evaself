-- Откат шага 18. Память остаётся на месте: здесь снимаются только
-- векторы и состояние переиндексации. Пересчитать их можно заново —
-- исходные тексты лежат в memory_nodes и memory_node_versions, а
-- полнотекстовый поиск и триграммы работают и без этой таблицы.

BEGIN;

DROP TABLE IF EXISTS memory_embedding_reindex;
DROP TABLE IF EXISTS memory_embeddings;

DELETE FROM schema_migrations WHERE version = '046_hybrid_retrieval';

COMMIT;
