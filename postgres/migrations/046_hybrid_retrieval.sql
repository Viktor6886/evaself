-- ---------------------------------------------------------------------
-- Шаг 18. Embeddings и гибридный поиск.
--
-- Второй поисковый контур не заводится: полнотекстовый поиск и триграммы
-- уже живут на `memory_nodes`, здесь к ним добавляется только векторная
-- часть. Qdrant, LightRAG и отдельные таблицы LangChain запрещены
-- (инвариант 14) — вектор лежит в PostgreSQL рядом с фактом.
--
-- Колонка `embedding` объявлена БЕЗ фиксированной размерности намеренно.
-- Смена модели — это фоновая переиндексация, а не единовременная
-- перезапись: пока она идёт, в таблице одновременно живут строки старой
-- и новой модели, и у них разная размерность. Индекс при этом обязан
-- быть фиксированным, поэтому он частичный и по приведённому выражению:
-- одна размерность — один индекс.
-- ---------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS memory_embeddings (
    id                bigserial PRIMARY KEY,
    user_id           bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Что именно векторизовано: краткое описание узла, каноническое
    -- представление факта или содержание эпизода.
    subject_kind      text NOT NULL,
    subject_id        bigint NOT NULL,
    model             text NOT NULL,
    dimension         integer NOT NULL,
    -- Версия набора: модель и версия вместе решают, чем считался вектор.
    embedding_version integer NOT NULL DEFAULT 1,
    -- Отпечаток исходного текста. По нему видно, устарел ли вектор,
    -- без хранения самого текста второй раз.
    content_hash      text NOT NULL,
    embedding         vector NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_embeddings_subject_check
        CHECK (subject_kind IN ('node', 'fact', 'episode')),
    CONSTRAINT memory_embeddings_dimension_check CHECK (dimension BETWEEN 1 AND 4096)
);

-- Один вектор на предмет для каждой пары «модель + версия»: во время
-- переиндексации у предмета законно есть и старый, и новый.
CREATE UNIQUE INDEX IF NOT EXISTS memory_embeddings_subject_uidx
    ON memory_embeddings (user_id, subject_kind, subject_id, model, embedding_version);

-- Владелец идёт первым: фильтр по пользователю применяется ДО поиска,
-- а не после него (требование 3 шага).
CREATE INDEX IF NOT EXISTS memory_embeddings_owner_idx
    ON memory_embeddings (user_id, subject_kind, model, embedding_version);

-- Косинусный индекс по приведённому выражению: только для рабочей
-- размерности. Строки чужой размерности в него не попадают и поиск по
-- ним честно идёт последовательно — их немного и только на время
-- переиндексации.
CREATE INDEX IF NOT EXISTS memory_embeddings_cosine_1536_idx
    ON memory_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
    WHERE dimension = 1536;

-- Состояние переиндексации. Строка на модель: она же говорит, какой
-- версией сейчас пользуется поиск.
CREATE TABLE IF NOT EXISTS memory_embedding_reindex (
    id             bigserial PRIMARY KEY,
    model          text NOT NULL,
    dimension      integer NOT NULL,
    target_version integer NOT NULL,
    status         text NOT NULL DEFAULT 'pending',
    -- Курсор переноса. Переиндексация возобновляема: она не обязана
    -- уложиться в один прогон и не имеет права начинать сначала.
    cursor_id      bigint NOT NULL DEFAULT 0,
    processed      bigint NOT NULL DEFAULT 0,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    CONSTRAINT memory_embedding_reindex_status_check
        CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_embedding_reindex_target_uidx
    ON memory_embedding_reindex (model, target_version);

INSERT INTO schema_migrations (version) VALUES ('046_hybrid_retrieval')
ON CONFLICT (version) DO NOTHING;

COMMIT;
