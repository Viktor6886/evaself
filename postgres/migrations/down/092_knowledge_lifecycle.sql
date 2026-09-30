BEGIN;

-- Откат 092 снимает только то, что она завела. Документы, фрагменты и
-- записи приёма остаются.

DELETE FROM job_schedules WHERE code = 'knowledge_reconcile';

ALTER TABLE knowledge_embedding_versions DROP COLUMN IF EXISTS build_started_at;

DROP INDEX IF EXISTS knowledge_documents_replaces_idx;
DROP INDEX IF EXISTS knowledge_documents_collection_name_idx;
DROP INDEX IF EXISTS knowledge_documents_collection_hash_idx;
DROP INDEX IF EXISTS knowledge_uploads_document_idx;
DROP INDEX IF EXISTS knowledge_uploads_collection_idx;

ALTER TABLE knowledge_uploads DROP CONSTRAINT IF EXISTS knowledge_uploads_scope;

-- NOT NULL у владельца возвращается, только если загрузок общей базы
-- нет: удалить их ради отката значило бы потерять записи о документах
-- администратора. Старый код такие строки не читает — он всегда ищет
-- загрузку по владельцу.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM knowledge_uploads WHERE user_id IS NULL) THEN
        ALTER TABLE knowledge_uploads ALTER COLUMN user_id SET NOT NULL;
    ELSE
        RAISE NOTICE 'knowledge_uploads.user_id остаётся необязательным: есть загрузки общей базы';
    END IF;
END $$;

ALTER TABLE knowledge_uploads
    DROP COLUMN IF EXISTS replaces_document_id,
    DROP COLUMN IF EXISTS outcome,
    DROP COLUMN IF EXISTS collection_id;

DELETE FROM schema_migrations WHERE version = '092_knowledge_lifecycle';

COMMIT;
