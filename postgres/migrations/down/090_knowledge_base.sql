BEGIN;

-- Откат 090 снимает только то, что она завела. Строки документов и
-- фрагментов остаются: колонки состояния индекса и места в документе
-- производные и восстанавливаются повторной индексацией.

-- NOT NULL у вектора pgvector возвращается, только если все фрагменты
-- его имеют: удалить фрагменты без вектора ради отката значило бы
-- потерять документы человека.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE embedding IS NULL) THEN
        ALTER TABLE knowledge_chunks ALTER COLUMN embedding SET NOT NULL;
    ELSE
        RAISE NOTICE 'knowledge_chunks.embedding остаётся необязательным: есть фрагменты без вектора pgvector';
    END IF;
END $$;

ALTER TABLE knowledge_chunks
    DROP COLUMN IF EXISTS token_count,
    DROP COLUMN IF EXISTS heading,
    DROP COLUMN IF EXISTS subsection,
    DROP COLUMN IF EXISTS section,
    DROP COLUMN IF EXISTS page_end,
    DROP COLUMN IF EXISTS page_start;

DROP INDEX IF EXISTS knowledge_documents_user_hash_idx;
DROP INDEX IF EXISTS knowledge_documents_index_status_idx;
DROP INDEX IF EXISTS knowledge_documents_collection_idx;
ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_collection_scope;

ALTER TABLE knowledge_documents
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS replaces_document_id,
    DROP COLUMN IF EXISTS revision,
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS size_bytes,
    DROP COLUMN IF EXISTS chunk_count,
    DROP COLUMN IF EXISTS index_error,
    DROP COLUMN IF EXISTS indexed_at,
    DROP COLUMN IF EXISTS indexed_version,
    DROP COLUMN IF EXISTS index_status,
    DROP COLUMN IF EXISTS collection_id;

DROP SEQUENCE IF EXISTS knowledge_embedding_version_seq;
DROP TABLE IF EXISTS knowledge_embedding_versions;
DROP TABLE IF EXISTS knowledge_collections;

DELETE FROM schema_migrations WHERE version = '090_knowledge_base';

COMMIT;
