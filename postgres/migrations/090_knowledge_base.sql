-- =====================================================================
-- База знаний: коллекции общей базы, версии эмбеддингов, состояние
-- векторного индекса документа, структура фрагментов
-- (docs/knowledge-base.md, batch K2).
--
-- PostgreSQL остаётся источником истины (инвариант 14): здесь всё, из чего
-- индекс Qdrant перестраивается целиком, — фрагменты с их местом в
-- документе, владелец или коллекция, модель и размерность векторов.
--
-- Совместимость со старым кодом: только новые таблицы и новые колонки с
-- умолчаниями. Прежняя запись фрагмента (с вектором pgvector) проходит
-- как раньше; снятие NOT NULL с `embedding` ей не мешает.
--
-- Индексы по живым `knowledge_chunks` строятся отдельно, CONCURRENTLY —
-- миграция 091.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Коллекции общей базы: «Методические материалы», «FAQ» и так далее.
-- Личная база коллекций не имеет — её граница задаётся владельцем.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_collections (
    id          uuid        PRIMARY KEY,
    code        text        NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    title       text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description text        CHECK (description IS NULL OR length(description) <= 2000),
    -- Выключенная коллекция не ищется, но её документы и векторы целы.
    enabled     boolean     NOT NULL DEFAULT true,
    position    integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Версии эмбеддингов. Версия — это пространство векторов: модель,
-- размерность и мера близости. Векторы разных версий несравнимы, поэтому
-- у каждой версии своя пара коллекций Qdrant (`eva_knowledge_*_v<N>`), а
-- поиск смотрит на активную через alias.
--
-- Реестр артефактов (`artifact_versions`) для этого не подходит: он
-- хранит неизменяемый авторский текст (промпты, навыки), а здесь —
-- состояние построения индекса с жизненным циклом.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_embedding_versions (
    version              integer     PRIMARY KEY CHECK (version > 0),
    -- Провайдер из реестра Router: ключ и адрес не дублируются. Удалить
    -- провайдера, на котором стоит индекс, нельзя — поиск потерял бы
    -- способ считать вектор запроса.
    provider_id          uuid        NOT NULL REFERENCES llm_providers (id) ON DELETE RESTRICT,
    model                text        NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
    dimension            integer     NOT NULL CHECK (dimension BETWEEN 8 AND 8192),
    distance             text        NOT NULL DEFAULT 'Cosine' CHECK (distance IN ('Cosine', 'Dot', 'Euclid')),
    -- Передавать ли `dimensions` в запрос: text-embedding-3 и часть
    -- моделей умеют укорачивать вектор, остальные на параметр ругаются.
    request_dimensions   boolean     NOT NULL DEFAULT false,
    -- Запасной провайдер обязан давать то же пространство: ту же модель у
    -- другого поставщика. Совместимость проверяет «Проверить модель».
    -- RESTRICT, а не SET NULL: запасной задаётся вместе с моделью (CHECK
    -- ниже), и молча снять его значило бы оставить версию без резерва.
    fallback_provider_id uuid        REFERENCES llm_providers (id) ON DELETE RESTRICT,
    fallback_model       text        CHECK (fallback_model IS NULL OR length(fallback_model) BETWEEN 1 AND 200),
    -- Граф HNSW фиксируется при построении версии («Дополнительно»).
    hnsw_m               integer     NOT NULL DEFAULT 16 CHECK (hnsw_m BETWEEN 4 AND 128),
    hnsw_ef_construct    integer     NOT NULL DEFAULT 100 CHECK (hnsw_ef_construct BETWEEN 16 AND 1024),
    on_disk              boolean     NOT NULL DEFAULT false,
    --   draft     заведена, индекс не строился
    --   building  идёт индексация
    --   ready     построена и проверена, поиск на неё ещё не смотрит
    --   active    поиск смотрит сюда (одна на установку)
    --   retired   была активной; хранится для отката
    --   failed    построение не удалось
    status               text        NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'building', 'ready', 'active', 'retired', 'failed')),
    error_code           text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    built_at             timestamptz,
    activated_at         timestamptz,
    retired_at           timestamptz,
    CHECK ((fallback_provider_id IS NULL) = (fallback_model IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_embedding_versions_one_active
    ON knowledge_embedding_versions ((true)) WHERE status = 'active';

-- Номера версий не переиспользуются: версия — имя коллекций Qdrant
-- (`eva_knowledge_*_v<N>`) и ключ кэша в роутере, и удалённый черновик не
-- должен отдать свой номер другой модели. `max(version) + 1` отдал бы.
CREATE SEQUENCE IF NOT EXISTS knowledge_embedding_version_seq
    OWNED BY knowledge_embedding_versions.version;

-- ---------------------------------------------------------------------
-- Документ: коллекция общей базы и состояние векторного индекса.
--
-- `status` — разбор файла (как было); `index_status` — есть ли векторы
-- документа в Qdrant активной версии. Это разные вещи: документ готов к
-- лексическому поиску раньше, чем проиндексирован, и остаётся готовым,
-- когда индекс перестраивается.
-- ---------------------------------------------------------------------
ALTER TABLE knowledge_documents
    ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES knowledge_collections (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS index_status text NOT NULL DEFAULT 'pending'
        CHECK (index_status IN ('pending', 'indexing', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS indexed_version integer
        REFERENCES knowledge_embedding_versions (version) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS indexed_at timestamptz,
    ADD COLUMN IF NOT EXISTS index_error text,
    ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    ADD COLUMN IF NOT EXISTS size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'upload'
        CHECK (source IN ('upload', 'audio', 'url', 'admin')),
    -- Новая версия того же документа (тот же файл по имени, другой хэш)
    -- ссылается на прежнюю; прежняя снимается после индексации новой.
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN IF NOT EXISTS replaces_document_id uuid REFERENCES knowledge_documents (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Коллекция — только у документа общей базы: личный документ в
-- коллекции нашёлся бы всем, у кого она включена.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_collection_scope'
    ) THEN
        ALTER TABLE knowledge_documents
            ADD CONSTRAINT knowledge_documents_collection_scope
            CHECK (collection_id IS NULL OR product_verified);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS knowledge_documents_collection_idx
    ON knowledge_documents (collection_id) WHERE collection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_documents_index_status_idx
    ON knowledge_documents (index_status) WHERE index_status <> 'ready';
CREATE INDEX IF NOT EXISTS knowledge_documents_user_hash_idx
    ON knowledge_documents (user_id, content_hash) WHERE user_id IS NOT NULL;

-- Число фрагментов существующих документов: сверка PostgreSQL↔Qdrant
-- сравнивает его с числом точек документа.
UPDATE knowledge_documents d
SET chunk_count = counted.total
FROM (
    SELECT document_id, count(*)::integer AS total
    FROM knowledge_chunks
    GROUP BY document_id
) counted
WHERE counted.document_id = d.id
  AND d.chunk_count = 0;

-- ---------------------------------------------------------------------
-- Фрагмент: место в документе. Соседи — это `ordinal ± 1` внутри
-- документа по уникальному (document_id, ordinal): отдельные
-- previous/next-ссылки дублировали бы его и могли бы разойтись.
-- ---------------------------------------------------------------------
ALTER TABLE knowledge_chunks
    ADD COLUMN IF NOT EXISTS page_start integer CHECK (page_start IS NULL OR page_start > 0),
    ADD COLUMN IF NOT EXISTS page_end integer CHECK (page_end IS NULL OR page_end > 0),
    ADD COLUMN IF NOT EXISTS section text,
    ADD COLUMN IF NOT EXISTS subsection text,
    ADD COLUMN IF NOT EXISTS heading text,
    ADD COLUMN IF NOT EXISTS token_count integer CHECK (token_count IS NULL OR token_count >= 0);

-- Вектор pgvector становится необязательным: новые фрагменты получают
-- векторы в Qdrant. pgvector остаётся откатом, пока поиск не переключён
-- (docs/knowledge-base.md, K8), и прежние векторы никуда не деваются.
ALTER TABLE knowledge_chunks ALTER COLUMN embedding DROP NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('090_knowledge_base')
ON CONFLICT (version) DO NOTHING;

COMMIT;
