-- =====================================================================
-- Поиск по базе знаний — на настоящем PostgreSQL.
--
-- Поддельная база в тестах TypeScript проверяет форму запросов, слияние
-- рангов и границу арендатора, но не сам SQL: ни `websearch_to_tsquery`
-- с русской морфологией, ни триграммный `<%` с порогом сеанса, ни
-- оператор `<=>` pgvector. Здесь — те же запросы, что в
-- `src/knowledge/search.ts` (прежний поиск) и `search-queries.ts`
-- (конвейер K4), с подставленными параметрами. Главное в них: чужой
-- документ и выключенная коллекция не находятся никогда.
--
-- Скрипт ничего не оставляет после себя: всё в транзакции с ROLLBACK.
-- =====================================================================

BEGIN;
INSERT INTO users (id, telegram_id) VALUES (920100, 920100), (920200, 920200);
INSERT INTO knowledge_collections (id, code, title, enabled)
VALUES
  ('c1111111-0000-0000-0000-000000000001', 'ci-search-on', 'Включённая', true),
  ('c1111111-0000-0000-0000-000000000002', 'ci-search-off', 'Выключенная', false);

-- Документ либо принадлежит человеку, либо входит в общую базу знаний:
-- схема требует этого ограничением `(user_id IS NOT NULL) <> product_verified`.
INSERT INTO knowledge_documents (id, user_id, product_verified, collection_id, name, mime, content_hash, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', 920100, false, NULL, 'Мой договор.pdf', 'application/pdf', 'h1', 'ready'),
  ('22222222-2222-2222-2222-222222222222', 920200, false, NULL, 'Чужой договор.pdf', 'application/pdf', 'h2', 'ready'),
  ('33333333-3333-3333-3333-333333333333', NULL, true, 'c1111111-0000-0000-0000-000000000001', 'Справочник Евы.md', 'text/markdown', 'h3', 'ready'),
  ('44444444-4444-4444-4444-444444444444', NULL, true, 'c1111111-0000-0000-0000-000000000002', 'Скрытая коллекция.md', 'text/markdown', 'h4', 'ready'),
  -- Фамилия только в имени файла, в тексте её нет.
  ('55555555-5555-5555-5555-555555555555', 920100, false, NULL, 'Петров — расписка.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'h5', 'ready'),
  ('66666666-6666-6666-6666-666666666666', NULL, true, NULL, 'Без коллекции.md', 'text/markdown', 'h6', 'ready');

-- Векторы простые и различимые: важна не близость сама по себе, а то,
-- что она вообще участвует в отборе. Фрагмент без вектора (новые векторы
-- живут в Qdrant) в векторный список попадать не должен.
INSERT INTO knowledge_chunks
  (document_id, user_id, product_verified, ordinal, content, content_hash, embedding, embedding_model, page_start, page_end, section)
VALUES
  ('11111111-1111-1111-1111-111111111111', 920100, false, 0,
   'Договоры аренды продлены до марта. Арендатор Иванов обслуживает станцию Р-168-5УН.', 'c1',
   ('[' || 1 || repeat(',0', 1535) || ']')::vector, 'router', 4, 4, '2. Оплата'),
  ('11111111-1111-1111-1111-111111111111', 920100, false, 1,
   'Штраф за просрочку платежа — один процент в день.', 'c1b',
   NULL, 'qdrant', 5, 5, '2. Оплата'),
  ('22222222-2222-2222-2222-222222222222', 920200, false, 0,
   'Договор аренды склада: Иванов, станция Р-168-5УН.', 'c2',
   ('[' || 1 || repeat(',0', 1535) || ']')::vector, 'router', 1, 1, NULL),
  ('33333333-3333-3333-3333-333333333333', NULL, true, 0,
   'Общая заметка: аренда оформляется договором.', 'c3',
   ('[' || 0.9 || repeat(',0', 1535) || ']')::vector, 'router', NULL, NULL, NULL),
  ('44444444-4444-4444-4444-444444444444', NULL, true, 0,
   'Скрытая коллекция: договор аренды и Иванов.', 'c4',
   ('[' || 1 || repeat(',0', 1535) || ']')::vector, 'router', NULL, NULL, NULL),
  ('55555555-5555-5555-5555-555555555555', 920100, false, 0,
   'Получил сумму полностью, претензий не имею.', 'c5',
   NULL, 'qdrant', NULL, NULL, NULL),
  ('55555555-5555-5555-5555-555555555555', 920100, false, 1,
   'Подпись и дата.', 'c5b',
   NULL, 'qdrant', NULL, NULL, NULL),
  ('66666666-6666-6666-6666-666666666666', NULL, true, 0,
   'Договор аренды: Иванов, станция Р-168-5УН.', 'c6',
   ('[' || 1 || repeat(',0', 1535) || ']')::vector, 'router', NULL, NULL, NULL);

-- ---------------------------------------------------------------------
-- Прежний поиск (режим legacy): человек 920100, обе базы включены.
-- ---------------------------------------------------------------------
CREATE TEMP VIEW legacy_probe AS
WITH ask AS (
  SELECT websearch_to_tsquery('simple', 'аренды') AS tsq
),
visible AS (
  SELECT c.id, c.document_id, c.ordinal, c.content, c.embedding
    FROM knowledge_chunks c
    JOIN knowledge_documents d
      ON d.id = c.document_id AND (d.user_id = 920100 OR d.product_verified)
    LEFT JOIN knowledge_collections k ON k.id = d.collection_id
   WHERE (c.user_id = 920100 AND true)
      OR (c.product_verified AND true AND COALESCE(k.enabled, false))
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
   WHERE v.embedding IS NOT NULL
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
SELECT d.name AS document_name, c.ordinal, c.content, fused.score, fused.matched
  FROM fused
  JOIN knowledge_chunks c ON c.id = fused.id
  JOIN knowledge_documents d
    ON d.id = c.document_id AND (d.user_id = 920100 OR d.product_verified)
 WHERE c.user_id = 920100 OR c.product_verified
 ORDER BY fused.score DESC, c.document_id, c.ordinal;

DO $$
DECLARE
  found integer;
  leaked integer;
  hybrid integer;
BEGIN
  SELECT count(*) INTO found FROM legacy_probe;
  IF found <> 2 THEN
    RAISE EXCEPTION 'прежний поиск: ожидались свой документ и общая заметка, найдено %', found;
  END IF;
  SELECT count(*) INTO leaked FROM legacy_probe
   WHERE document_name IN ('Чужой договор.pdf', 'Скрытая коллекция.md', 'Без коллекции.md');
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'прежний поиск отдал чужой документ или общую базу вне включённой коллекции';
  END IF;
  SELECT count(*) INTO hybrid FROM legacy_probe WHERE matched = 'both';
  IF hybrid < 1 THEN
    RAISE EXCEPTION 'прежний поиск: ни один фрагмент не нашёлся обоими способами';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Конвейер K4: лексическая половина — русская морфология и триграммы.
-- ---------------------------------------------------------------------
-- Порог задаётся на транзакцию, как в `lexicalCandidates`: оператор `<%`
-- читает его из настройки сеанса.
SET LOCAL pg_trgm.word_similarity_threshold = 0.5;

CREATE TEMP TABLE probe_lexical (label text, signal text, document_name text, ordinal integer) ON COMMIT DROP;

-- Запросы — те же, что строит `lexicalCandidates`, с подставленными
-- параметрами; CI сверяет блок с кодом.
-- >>> сгенерировано scripts/ci/gen-knowledge-search-probes.mjs — не править руками
-- morphology: «договор аренда»
PREPARE probe_1 AS
  WITH ask AS (
    SELECT websearch_to_tsquery('russian', $4) AS tsq,
           regexp_replace(plainto_tsquery('russian', $4)::text, ' & ', ' | ', 'g')::tsquery AS anyq
  ),
  fts_strict AS (
    SELECT sample.id, 1 + ts_rank_cd(to_tsvector('russian', sample.content), ask.tsq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE to_tsvector('russian', c.content) @@ ask.tsq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts_loose AS (
    SELECT sample.id, ts_rank_cd(to_tsvector('russian', sample.content), ask.anyq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE NOT EXISTS (SELECT 1 FROM fts_strict)
           AND to_tsvector('russian', c.content) @@ ask.anyq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts AS (
    SELECT id, score FROM fts_strict
    UNION ALL
    SELECT id, score FROM fts_loose
  )
  SELECT 'fts' AS signal, id::text AS id, score FROM fts;
CREATE TEMP TABLE probe_1_rows ON COMMIT DROP AS EXECUTE probe_1(920100, true, true, 'договор аренда', 30);
INSERT INTO probe_lexical
SELECT 'morphology', q.signal, d.name, c.ordinal
  FROM probe_1_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_1;

-- question: «какие сроки оплаты по договору квартиры»
PREPARE probe_2 AS
  WITH ask AS (
    SELECT websearch_to_tsquery('russian', $4) AS tsq,
           regexp_replace(plainto_tsquery('russian', $4)::text, ' & ', ' | ', 'g')::tsquery AS anyq
  ),
  fts_strict AS (
    SELECT sample.id, 1 + ts_rank_cd(to_tsvector('russian', sample.content), ask.tsq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE to_tsvector('russian', c.content) @@ ask.tsq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts_loose AS (
    SELECT sample.id, ts_rank_cd(to_tsvector('russian', sample.content), ask.anyq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE NOT EXISTS (SELECT 1 FROM fts_strict)
           AND to_tsvector('russian', c.content) @@ ask.anyq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts AS (
    SELECT id, score FROM fts_strict
    UNION ALL
    SELECT id, score FROM fts_loose
  )
  SELECT 'fts' AS signal, id::text AS id, score FROM fts;
CREATE TEMP TABLE probe_2_rows ON COMMIT DROP AS EXECUTE probe_2(920100, true, true, 'какие сроки оплаты по договору квартиры', 30);
INSERT INTO probe_lexical
SELECT 'question', q.signal, d.name, c.ordinal
  FROM probe_2_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_2;

-- trigram: «Иваноф Р-168-5УН», триграммы: Иваноф, Р-168-5УН
PREPARE probe_3 AS
  WITH ask AS (
    SELECT websearch_to_tsquery('russian', $4) AS tsq,
           regexp_replace(plainto_tsquery('russian', $4)::text, ' & ', ' | ', 'g')::tsquery AS anyq
  ),
  fts_strict AS (
    SELECT sample.id, 1 + ts_rank_cd(to_tsvector('russian', sample.content), ask.tsq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE to_tsvector('russian', c.content) @@ ask.tsq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts_loose AS (
    SELECT sample.id, ts_rank_cd(to_tsvector('russian', sample.content), ask.anyq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE NOT EXISTS (SELECT 1 FROM fts_strict)
           AND to_tsvector('russian', c.content) @@ ask.anyq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts AS (
    SELECT id, score FROM fts_strict
    UNION ALL
    SELECT id, score FROM fts_loose
  )
  SELECT 'fts' AS signal, id::text AS id, score FROM fts;
CREATE TEMP TABLE probe_3_rows ON COMMIT DROP AS EXECUTE probe_3(920100, true, true, 'Иваноф Р-168-5УН', 30);
INSERT INTO probe_lexical
SELECT 'trigram', q.signal, d.name, c.ordinal
  FROM probe_3_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_3;

-- trigram: «Иваноф Р-168-5УН», триграммы: Иваноф, Р-168-5УН
PREPARE probe_4 AS
  WITH trgm_text AS (
    SELECT c.id, (word_similarity($5, c.content) + word_similarity($6, c.content)) AS score
      FROM knowledge_chunks c
      JOIN knowledge_documents d
        ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
      LEFT JOIN knowledge_collections k ON k.id = d.collection_id
     WHERE ($5 <% c.content OR $6 <% c.content)
       AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
     ORDER BY score DESC, c.id
     LIMIT $4
  ),
  trgm_name AS (
    SELECT first.id, (word_similarity($5, d.name) + word_similarity($6, d.name)) AS score
      FROM knowledge_documents d
      LEFT JOIN knowledge_collections k ON k.id = d.collection_id
     CROSS JOIN LATERAL (
       SELECT c.id
         FROM knowledge_chunks c
        WHERE c.document_id = d.id
          AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
        ORDER BY c.ordinal
        LIMIT 1
     ) first
     WHERE ($5 <% d.name OR $6 <% d.name)
       AND (d.user_id = $1 OR d.product_verified)
     ORDER BY score DESC, d.id
     LIMIT $4
  ),
  trgm AS (
    SELECT id, max(score) AS score
      FROM (SELECT id, score FROM trgm_text UNION ALL SELECT id, score FROM trgm_name) found
     GROUP BY id
     ORDER BY score DESC, id
     LIMIT $4
  )
  SELECT 'trgm' AS signal, id::text AS id, score FROM trgm;
CREATE TEMP TABLE probe_4_rows ON COMMIT DROP AS EXECUTE probe_4(920100, true, true, 30, 'Иваноф', 'Р-168-5УН');
INSERT INTO probe_lexical
SELECT 'trigram', q.signal, d.name, c.ordinal
  FROM probe_4_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_4;

-- name: «Петрову», триграммы: Петрову
PREPARE probe_5 AS
  WITH ask AS (
    SELECT websearch_to_tsquery('russian', $4) AS tsq,
           regexp_replace(plainto_tsquery('russian', $4)::text, ' & ', ' | ', 'g')::tsquery AS anyq
  ),
  fts_strict AS (
    SELECT sample.id, 1 + ts_rank_cd(to_tsvector('russian', sample.content), ask.tsq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE to_tsvector('russian', c.content) @@ ask.tsq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts_loose AS (
    SELECT sample.id, ts_rank_cd(to_tsvector('russian', sample.content), ask.anyq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE NOT EXISTS (SELECT 1 FROM fts_strict)
           AND to_tsvector('russian', c.content) @@ ask.anyq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts AS (
    SELECT id, score FROM fts_strict
    UNION ALL
    SELECT id, score FROM fts_loose
  )
  SELECT 'fts' AS signal, id::text AS id, score FROM fts;
CREATE TEMP TABLE probe_5_rows ON COMMIT DROP AS EXECUTE probe_5(920100, true, true, 'Петрову', 30);
INSERT INTO probe_lexical
SELECT 'name', q.signal, d.name, c.ordinal
  FROM probe_5_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_5;

-- name: «Петрову», триграммы: Петрову
PREPARE probe_6 AS
  WITH trgm_text AS (
    SELECT c.id, (word_similarity($5, c.content)) AS score
      FROM knowledge_chunks c
      JOIN knowledge_documents d
        ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
      LEFT JOIN knowledge_collections k ON k.id = d.collection_id
     WHERE ($5 <% c.content)
       AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
     ORDER BY score DESC, c.id
     LIMIT $4
  ),
  trgm_name AS (
    SELECT first.id, (word_similarity($5, d.name)) AS score
      FROM knowledge_documents d
      LEFT JOIN knowledge_collections k ON k.id = d.collection_id
     CROSS JOIN LATERAL (
       SELECT c.id
         FROM knowledge_chunks c
        WHERE c.document_id = d.id
          AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
        ORDER BY c.ordinal
        LIMIT 1
     ) first
     WHERE ($5 <% d.name)
       AND (d.user_id = $1 OR d.product_verified)
     ORDER BY score DESC, d.id
     LIMIT $4
  ),
  trgm AS (
    SELECT id, max(score) AS score
      FROM (SELECT id, score FROM trgm_text UNION ALL SELECT id, score FROM trgm_name) found
     GROUP BY id
     ORDER BY score DESC, id
     LIMIT $4
  )
  SELECT 'trgm' AS signal, id::text AS id, score FROM trgm;
CREATE TEMP TABLE probe_6_rows ON COMMIT DROP AS EXECUTE probe_6(920100, true, true, 30, 'Петрову');
INSERT INTO probe_lexical
SELECT 'name', q.signal, d.name, c.ordinal
  FROM probe_6_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_6;

-- private_off: «аренда», личная база выключена
PREPARE probe_7 AS
  WITH ask AS (
    SELECT websearch_to_tsquery('russian', $4) AS tsq,
           regexp_replace(plainto_tsquery('russian', $4)::text, ' & ', ' | ', 'g')::tsquery AS anyq
  ),
  fts_strict AS (
    SELECT sample.id, 1 + ts_rank_cd(to_tsvector('russian', sample.content), ask.tsq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE to_tsvector('russian', c.content) @@ ask.tsq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts_loose AS (
    SELECT sample.id, ts_rank_cd(to_tsvector('russian', sample.content), ask.anyq) AS score
      FROM (
        SELECT c.id, c.content
          FROM knowledge_chunks c
          JOIN knowledge_documents d
            ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
          LEFT JOIN knowledge_collections k ON k.id = d.collection_id
         CROSS JOIN ask
         WHERE NOT EXISTS (SELECT 1 FROM fts_strict)
           AND to_tsvector('russian', c.content) @@ ask.anyq
           AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, false)))
         LIMIT 2000
      ) sample
     CROSS JOIN ask
     ORDER BY score DESC, sample.id
     LIMIT $5
  ),
  fts AS (
    SELECT id, score FROM fts_strict
    UNION ALL
    SELECT id, score FROM fts_loose
  )
  SELECT 'fts' AS signal, id::text AS id, score FROM fts;
CREATE TEMP TABLE probe_7_rows ON COMMIT DROP AS EXECUTE probe_7(920100, false, true, 'аренда', 30);
INSERT INTO probe_lexical
SELECT 'private_off', q.signal, d.name, c.ordinal
  FROM probe_7_rows q
  JOIN knowledge_chunks c ON c.id = q.id::bigint
  JOIN knowledge_documents d ON d.id = c.document_id;
DEALLOCATE probe_7;
-- <<< конец сгенерированного блока

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM probe_lexical WHERE label = 'morphology' AND document_name = 'Мой договор.pdf') THEN
    RAISE EXCEPTION 'морфология: «договор аренда» не нашёл «Договоры аренды»';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM probe_lexical WHERE label = 'trigram' AND document_name = 'Мой договор.pdf') THEN
    RAISE EXCEPTION 'триграммы: опечатка в фамилии и обозначение не нашлись';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM probe_lexical WHERE label = 'name' AND document_name = 'Петров — расписка.docx' AND ordinal = 0) THEN
    RAISE EXCEPTION 'триграммы: фамилия из названия документа не нашлась';
  END IF;
  -- Документ, найденный по названию, — одним первым фрагментом: иначе все
  -- его фрагменты с одной оценкой вытеснили бы совпадения по тексту.
  IF (SELECT count(*) FROM probe_lexical WHERE label = 'name' AND document_name = 'Петров — расписка.docx') <> 1 THEN
    RAISE EXCEPTION 'триграммы: документ, найденный по названию, отдан не одним фрагментом';
  END IF;
  -- Длинный вопрос: все слова сразу не встречаются, запасной запрос
  -- находит по любому из них.
  IF NOT EXISTS (SELECT 1 FROM probe_lexical WHERE label = 'question' AND document_name = 'Мой договор.pdf') THEN
    RAISE EXCEPTION 'длинный вопрос не нашёл ничего: запасной запрос по любому слову не сработал';
  END IF;
  IF EXISTS (SELECT 1 FROM probe_lexical WHERE document_name IN ('Чужой договор.pdf', 'Скрытая коллекция.md', 'Без коллекции.md')) THEN
    RAISE EXCEPTION 'лексический поиск отдал чужой документ или общую базу вне включённой коллекции';
  END IF;
  IF EXISTS (SELECT 1 FROM probe_lexical WHERE label = 'private_off' AND document_name = 'Мой договор.pdf')
     OR NOT EXISTS (SELECT 1 FROM probe_lexical WHERE label = 'private_off' AND document_name = 'Справочник Евы.md') THEN
    RAISE EXCEPTION 'переключатель личной базы не действует';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Конвейер K4: векторная половина на pgvector, чтение по id, соседи.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  vector_ids bigint[];
  hydrated integer;
  neighbor text;
  neighbor_count integer;
BEGIN
  SELECT array_agg(id ORDER BY position) INTO vector_ids FROM (
    SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> ('[' || 1 || repeat(',0', 1535) || ']')::vector, c.id) AS position
      FROM knowledge_chunks c
      JOIN knowledge_documents d
        ON d.id = c.document_id AND (d.user_id = 920100 OR d.product_verified)
      LEFT JOIN knowledge_collections k ON k.id = d.collection_id
     WHERE c.embedding IS NOT NULL
       AND ((c.user_id = 920100 AND true) OR (c.product_verified AND true AND COALESCE(k.enabled, false)))
     ORDER BY c.embedding <=> ('[' || 1 || repeat(',0', 1535) || ']')::vector, c.id
     LIMIT 30
  ) ranked;
  IF coalesce(array_length(vector_ids, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'pgvector: ожидались два фрагмента с вектором (свой и общий), найдено %', coalesce(array_length(vector_ids, 1), 0);
  END IF;

  -- Чтение по id перепроверяет видимость: id чужого фрагмента и
  -- выключенной коллекции, пришедшие из индекса, не читаются.
  SELECT count(*) INTO hydrated
    FROM knowledge_chunks c
    JOIN knowledge_documents d
      ON d.id = c.document_id AND (d.user_id = 920100 OR d.product_verified)
    LEFT JOIN knowledge_collections k ON k.id = d.collection_id
   WHERE c.id = ANY(ARRAY(SELECT id FROM knowledge_chunks WHERE content_hash IN ('c1', 'c2', 'c3', 'c4', 'c6')))
     AND ((c.user_id = 920100 AND true) OR (c.product_verified AND true AND COALESCE(k.enabled, false)));
  IF hydrated <> 2 THEN
    RAISE EXCEPTION 'чтение по id отдало % фрагментов вместо двух: видимость не перепроверена', hydrated;
  END IF;

  -- Сосед — ordinal ± 1 того же документа, и только видимого.
  SELECT count(*), max(c.content) INTO neighbor_count, neighbor
    FROM knowledge_chunks c
    JOIN unnest(ARRAY['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666']::uuid[], ARRAY[1, 0, 0, 0]::integer[])
         AS want(document_id, ordinal)
      ON want.document_id = c.document_id AND want.ordinal = c.ordinal
    JOIN knowledge_documents d
      ON d.id = c.document_id AND (d.user_id = 920100 OR d.product_verified)
    LEFT JOIN knowledge_collections k ON k.id = d.collection_id
   WHERE (c.user_id = 920100 AND true) OR (c.product_verified AND true AND COALESCE(k.enabled, false));
  IF neighbor_count <> 1 OR neighbor IS NULL OR neighbor NOT LIKE 'Штраф%' THEN
    RAISE EXCEPTION 'соседи: найдено % фрагментов вместо одного видимого личного', neighbor_count;
  END IF;
END $$;

ROLLBACK;
