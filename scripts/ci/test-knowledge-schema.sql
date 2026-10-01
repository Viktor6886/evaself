-- =====================================================================
-- Схема базы знаний (миграции 090–092) — на настоящем PostgreSQL.
--
-- Правила, которые держит сама схема и которые не проверить на фейках:
-- коллекция бывает только у документа общей базы, активная версия
-- эмбеддингов одна, запасной провайдер задаётся вместе с моделью,
-- провайдера под индексом не удалить, русская морфология находит слово
-- в другой форме, а триграммы — фамилию с опечаткой; загрузка — либо
-- человека, либо в коллекцию общей базы, а исход загрузки — из
-- закрытого списка (092).
--
-- Скрипт ничего не оставляет после себя: всё в транзакции с ROLLBACK.
-- =====================================================================

BEGIN;

INSERT INTO users (id, telegram_id) VALUES (910001, 910001);

INSERT INTO llm_providers (id, name, protocol, base_url, model, context_window, api_key_encrypted)
VALUES
  ('00000000-0000-0000-0000-00000000e001', 'ci-embeddings', 'openai-compatible', 'http://127.0.0.1:1/v1', 'ci-chat', 8192, 'ci-not-a-key'),
  ('00000000-0000-0000-0000-00000000e002', 'ci-embeddings-fallback', 'openai-compatible', 'http://127.0.0.1:2/v1', 'ci-chat', 8192, 'ci-not-a-key');

INSERT INTO knowledge_collections (id, code, title)
VALUES ('00000000-0000-0000-0000-0000000c0001', 'faq', 'FAQ');

-- Коллекция — только у документа общей базы.
INSERT INTO knowledge_documents (id, user_id, product_verified, name, mime, content_hash, status, collection_id)
VALUES ('00000000-0000-0000-0000-0000000d0001', NULL, true, 'FAQ.md', 'text/markdown', 'h1', 'ready',
        '00000000-0000-0000-0000-0000000c0001');

DO $$
BEGIN
  BEGIN
    INSERT INTO knowledge_documents (id, user_id, product_verified, name, mime, content_hash, status, collection_id)
    VALUES ('00000000-0000-0000-0000-0000000d0002', 910001, false, 'Мой.md', 'text/markdown', 'h2', 'ready',
            '00000000-0000-0000-0000-0000000c0001');
    RAISE EXCEPTION 'личный документ попал в коллекцию общей базы';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Код коллекции — латиница в нижнем регистре: он уходит в payload Qdrant.
DO $$
BEGIN
  BEGIN
    INSERT INTO knowledge_collections (id, code, title)
    VALUES ('00000000-0000-0000-0000-0000000c0002', 'Не код', 'x');
    RAISE EXCEPTION 'код коллекции не проверяется';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Коллекцию с документами удалить нельзя: документы не должны молча
-- выпасть из общей базы.
DO $$
BEGIN
  BEGIN
    DELETE FROM knowledge_collections WHERE code = 'faq';
    RAISE EXCEPTION 'удалилась коллекция с документами';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Версии эмбеддингов: одна активная.
INSERT INTO knowledge_embedding_versions (version, provider_id, model, dimension, status)
VALUES (1, '00000000-0000-0000-0000-00000000e001', 'text-embedding-3-small', 1536, 'active');

DO $$
BEGIN
  BEGIN
    INSERT INTO knowledge_embedding_versions (version, provider_id, model, dimension, status)
    VALUES (2, '00000000-0000-0000-0000-00000000e001', 'bge-m3', 1024, 'active');
    RAISE EXCEPTION 'вторая активная версия эмбеддингов';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Запасной провайдер — только вместе с моделью.
DO $$
BEGIN
  BEGIN
    INSERT INTO knowledge_embedding_versions (version, provider_id, model, dimension, fallback_provider_id)
    VALUES (3, '00000000-0000-0000-0000-00000000e001', 'bge-m3', 1024, '00000000-0000-0000-0000-00000000e002');
    RAISE EXCEPTION 'запасной провайдер без модели';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Запасного провайдера версии тоже не удалить: версия без резерва,
-- снятого молча, — это отказ поиска при первом сбое основного.
INSERT INTO knowledge_embedding_versions (version, provider_id, model, dimension, fallback_provider_id, fallback_model)
VALUES (4, '00000000-0000-0000-0000-00000000e001', 'bge-m3', 1024, '00000000-0000-0000-0000-00000000e002', 'baai/bge-m3');

DO $$
BEGIN
  BEGIN
    DELETE FROM llm_providers WHERE id = '00000000-0000-0000-0000-00000000e002';
    RAISE EXCEPTION 'удалился запасной провайдер версии';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Номер версии выдаёт последовательность: выданный не повторяется.
DO $$
DECLARE first bigint; second bigint;
BEGIN
  first := nextval('knowledge_embedding_version_seq');
  second := nextval('knowledge_embedding_version_seq');
  IF second <= first THEN RAISE EXCEPTION 'последовательность версий не растёт'; END IF;
END $$;

-- Провайдера, на котором стоит индекс, не удалить.
DO $$
BEGIN
  BEGIN
    DELETE FROM llm_providers WHERE id = '00000000-0000-0000-0000-00000000e001';
    RAISE EXCEPTION 'удалился провайдер под индексом';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Новый фрагмент может не иметь вектора pgvector: векторы — в Qdrant.
INSERT INTO knowledge_chunks (document_id, user_id, product_verified, ordinal, content, content_hash, embedding_model,
                              page_start, page_end, section, heading)
VALUES
  ('00000000-0000-0000-0000-0000000d0001', NULL, true, 0,
   'Договоры аренды продлеваются автоматически', 'c1', 'text-embedding-3-small', 1, 1, 'Аренда', 'Продление'),
  ('00000000-0000-0000-0000-0000000d0001', NULL, true, 1,
   'Ответственный инженер — Иваницкий, станция Р-168-5УН', 'c2', 'text-embedding-3-small', 2, 2, 'Связь', NULL);

-- Русская морфология: «договор» находит «Договоры», словарь simple — нет.
DO $$
DECLARE russian integer; simple integer;
BEGIN
  SELECT count(*) INTO russian FROM knowledge_chunks
  WHERE document_id = '00000000-0000-0000-0000-0000000d0001'
    AND to_tsvector('russian', content) @@ websearch_to_tsquery('russian', 'договор');
  SELECT count(*) INTO simple FROM knowledge_chunks
  WHERE document_id = '00000000-0000-0000-0000-0000000d0001'
    AND to_tsvector('simple', content) @@ websearch_to_tsquery('simple', 'договор');
  IF russian <> 1 OR simple <> 0 THEN
    RAISE EXCEPTION 'морфология: russian=%, simple=%', russian, simple;
  END IF;
END $$;

-- Триграммы: фамилия с опечаткой и обозначение оборудования.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE 'Иваницкий' <% content AND document_id = '00000000-0000-0000-0000-0000000d0001' AND ordinal = 1) THEN
    RAISE EXCEPTION 'триграммы не нашли фамилию';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE 'Иваницкй' <% content AND document_id = '00000000-0000-0000-0000-0000000d0001' AND ordinal = 1) THEN
    RAISE EXCEPTION 'триграммы не нашли фамилию с опечаткой';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE 'Р-168-5УН' <% content AND document_id = '00000000-0000-0000-0000-0000000d0001') THEN
    RAISE EXCEPTION 'триграммы не нашли обозначение оборудования';
  END IF;
END $$;

-- Индексы построены и валидны: прерванный CONCURRENTLY оставил бы
-- невалидный индекс, по которому поиск идёт полным перебором.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
  FROM unnest(ARRAY['knowledge_chunks_fts_russian_idx', 'knowledge_chunks_trgm_idx',
                    'knowledge_documents_name_trgm_idx']) AS name
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = name AND i.indisvalid
  );
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'нет валидных индексов: %', missing; END IF;
END $$;

-- 092: загрузка принадлежит либо человеку, либо коллекции общей базы.
INSERT INTO knowledge_uploads (id, user_id, collection_id, name, mime, size_bytes, content_hash, storage_path, status, outcome)
VALUES
  ('00000000-0000-0000-0000-0000000a0001', 910001, NULL, 'личное.md', 'text/markdown', 10, 'h2', '/data/knowledge-uploads/910001/a1', 'ready', 'new'),
  ('00000000-0000-0000-0000-0000000a0002', NULL, '00000000-0000-0000-0000-0000000c0001', 'FAQ.md', 'text/markdown', 10, 'h1', '/data/knowledge-uploads/global/a2', 'ready', 'duplicate');

DO $$
BEGIN
  BEGIN
    INSERT INTO knowledge_uploads (id, user_id, collection_id, name, mime, size_bytes, content_hash, storage_path, status)
    VALUES ('00000000-0000-0000-0000-0000000a0003', NULL, NULL, 'ничей.md', 'text/markdown', 1, 'h', '/x', 'queued');
    RAISE EXCEPTION 'загрузка без владельца и без коллекции принята';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO knowledge_uploads (id, user_id, collection_id, name, mime, size_bytes, content_hash, storage_path, status)
    VALUES ('00000000-0000-0000-0000-0000000a0004', 910001, '00000000-0000-0000-0000-0000000c0001', 'и то и другое.md', 'text/markdown', 1, 'h', '/x', 'queued');
    RAISE EXCEPTION 'личная загрузка в коллекции общей базы принята';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE knowledge_uploads SET outcome = 'guess' WHERE id = '00000000-0000-0000-0000-0000000a0001';
    RAISE EXCEPTION 'исход загрузки вне списка принят';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Начало построения версии и выключенное расписание сверки.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'knowledge_embedding_versions' AND column_name = 'build_started_at') THEN
    RAISE EXCEPTION 'нет knowledge_embedding_versions.build_started_at';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM job_schedules
                 WHERE code = 'knowledge_reconcile' AND queue = 'memory' AND NOT enabled) THEN
    RAISE EXCEPTION 'расписание сверки базы знаний не заведено выключенным';
  END IF;
END $$;

ROLLBACK;

\echo 'knowledge schema: коллекции, версии эмбеддингов, морфология и триграммы — PASS'
