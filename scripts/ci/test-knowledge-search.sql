-- =====================================================================
-- Гибридный поиск по базе знаний — на настоящем PostgreSQL.
--
-- Поддельная база в тестах TypeScript проверяет форму запроса и слияние
-- рангов, но не сам SQL: ни `websearch_to_tsquery`, ни оператор `<=>`
-- pgvector, ни FULL OUTER JOIN двух половин поиска. Здесь проверяется
-- именно запрос — и главное в нём: чужой документ не находится никогда.
--
-- Скрипт ничего не оставляет после себя: работает во временных копиях
-- таблиц и падает с ошибкой, если правило нарушено.
-- =====================================================================

BEGIN;

CREATE TEMP TABLE search_documents (LIKE knowledge_documents INCLUDING ALL) ON COMMIT DROP;
CREATE TEMP TABLE search_chunks (LIKE knowledge_chunks INCLUDING ALL) ON COMMIT DROP;

-- Документ либо принадлежит человеку, либо входит в общую базу знаний:
-- схема требует этого ограничением `(user_id IS NOT NULL) <> product_verified`.
INSERT INTO search_documents (id, user_id, product_verified, name, mime, content_hash, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', 100, false, 'Мой договор.pdf', 'application/pdf', 'h1', 'ready'),
  ('22222222-2222-2222-2222-222222222222', 200, false, 'Чужой договор.pdf', 'application/pdf', 'h2', 'ready'),
  ('33333333-3333-3333-3333-333333333333', NULL, true, 'Справочник Евы.md', 'text/markdown', 'h3', 'ready');

-- Векторы простые и различимые: важна не близость сама по себе, а то,
-- что она вообще участвует в отборе.
INSERT INTO search_chunks
  (document_id, user_id, product_verified, ordinal, content, content_hash, embedding, embedding_model)
VALUES
  ('11111111-1111-1111-1111-111111111111', 100, false, 0,
   'Аренда квартиры продлена до марта', 'c1',
   ('[' || 1 || repeat(',0', 1535) || ']')::vector, 'router'),
  ('22222222-2222-2222-2222-222222222222', 200, false, 0,
   'Аренда склада продлена до марта', 'c2',
   ('[' || 1 || repeat(',0', 1535) || ']')::vector, 'router'),
  ('33333333-3333-3333-3333-333333333333', NULL, true, 0,
   'Общая заметка про аренду в базе знаний', 'c3',
   ('[' || 0.9 || repeat(',0', 1535) || ']')::vector, 'router');

-- Тот же запрос, что и в KnowledgeSearch, поверх временных копий.
CREATE TEMP VIEW search_probe AS
WITH ask AS (SELECT websearch_to_tsquery('simple', 'аренда') AS tsq),
visible AS (
  SELECT c.id, c.document_id, c.ordinal, c.content, c.embedding
    FROM search_chunks c
   WHERE c.user_id = 100 OR c.product_verified
),
fts AS (
  SELECT v.id,
         row_number() OVER (
           ORDER BY ts_rank(to_tsvector('simple', v.content), ask.tsq) DESC, v.id
         ) AS position
    FROM visible v, ask
   WHERE to_tsvector('simple', v.content) @@ ask.tsq
   LIMIT 5
),
vec AS (
  SELECT v.id,
         row_number() OVER (ORDER BY v.embedding <=> ('[' || 1 || repeat(',0', 1535) || ']')::vector, v.id) AS position
    FROM visible v
   ORDER BY v.embedding <=> ('[' || 1 || repeat(',0', 1535) || ']')::vector
   LIMIT 5
),
fused AS (
  SELECT COALESCE(fts.id, vec.id) AS id,
         COALESCE(1.0 / (60 + fts.position), 0) + COALESCE(1.0 / (60 + vec.position), 0) AS score,
         CASE
           WHEN fts.id IS NOT NULL AND vec.id IS NOT NULL THEN 'both'
           WHEN fts.id IS NOT NULL THEN 'fts'
           ELSE 'vector'
         END AS matched
    FROM fts FULL OUTER JOIN vec ON vec.id = fts.id
)
SELECT d.name AS document_name, c.content, fused.score, fused.matched
  FROM fused
  JOIN search_chunks c ON c.id = fused.id
  JOIN search_documents d ON d.id = c.document_id
 WHERE c.user_id = 100 OR c.product_verified
 ORDER BY fused.score DESC, c.document_id, c.ordinal;

DO $$
DECLARE
  found integer;
  alien integer;
  hybrid integer;
BEGIN
  SELECT count(*) INTO found FROM search_probe;
  IF found <> 2 THEN
    RAISE EXCEPTION 'ожидались свой документ и общая заметка, найдено %', found;
  END IF;

  SELECT count(*) INTO alien FROM search_probe WHERE document_name = 'Чужой договор.pdf';
  IF alien <> 0 THEN
    RAISE EXCEPTION 'поиск отдал документ другого человека';
  END IF;

  SELECT count(*) INTO hybrid FROM search_probe WHERE matched = 'both';
  IF hybrid < 1 THEN
    RAISE EXCEPTION 'ни один фрагмент не нашёлся обоими способами: половина поиска не работает';
  END IF;
END $$;

ROLLBACK;
