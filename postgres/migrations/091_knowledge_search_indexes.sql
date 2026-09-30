-- =====================================================================
-- Лексический поиск по базе знаний: русская морфология и триграммы
-- (docs/knowledge-base.md, batch K2; запросы — K4).
--
-- Прежний индекс FTS — словарь `simple`: «договора» не находит «договор».
-- Словарь `russian` приводит слова к основе. Триграммы нужны там, где
-- морфология бессильна: фамилии, артикулы, обозначения оборудования,
-- номера и опечатки.
--
-- ВНИМАНИЕ: файл намеренно без BEGIN/COMMIT. `knowledge_chunks` на живой
-- установке не пуста, и обычный `CREATE INDEX` держал бы на ней
-- блокировку записи до конца построения: встала бы вся загрузка
-- документов. `CREATE INDEX CONCURRENTLY` внутри транзакции невозможен.
--
-- Прерванное построение оставляет невалидный индекс, и `IF NOT EXISTS`
-- его не пересоздаёт: он снимается вручную (`DROP INDEX CONCURRENTLY
-- <имя>`), после чего миграция запускается снова.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunks_fts_russian_idx
    ON knowledge_chunks USING gin (to_tsvector('russian', content));

CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunks_trgm_idx
    ON knowledge_chunks USING gin (content gin_trgm_ops);

-- Названия документов ищутся по триграммам: «покажи договор Иванова».
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_documents_name_trgm_idx
    ON knowledge_documents USING gin (name gin_trgm_ops);

INSERT INTO schema_migrations (version) VALUES ('091_knowledge_search_indexes')
ON CONFLICT (version) DO NOTHING;
