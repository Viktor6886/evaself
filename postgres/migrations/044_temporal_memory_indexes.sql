-- =====================================================================
-- Индексы temporal-памяти по УЖЕ СУЩЕСТВУЮЩИМ таблицам.
--
-- Столбцы завела миграция 042 — она транзакционная, и это правильно:
-- `ADD COLUMN` с константным умолчанием в PostgreSQL 17 таблицу не
-- переписывает. А вот индексы по `memory_nodes` и `memory_edges` строятся
-- по непустым таблицам живой установки, и обычный `CREATE INDEX` держал
-- бы на них ACCESS EXCLUSIVE до конца построения: писатели графа
-- памяти встали бы все разом.
--
-- ВНИМАНИЕ: файл намеренно без BEGIN/COMMIT. `CREATE INDEX CONCURRENTLY`
-- внутри транзакции невозможен. Правило `CLAUDE.md` про большие индексы
-- относится ровно к этому случаю — и не относится к индексам по таблицам,
-- заведённым той же миграцией 042: они пусты в момент создания.
--
-- Оговорка про повторный запуск, та же что у миграции 030: прерванное
-- построение CONCURRENTLY оставляет в схеме невалидный индекс, и
-- `IF NOT EXISTS` его не пересоздаёт. Такой индекс снимается вручную
-- (`DROP INDEX CONCURRENTLY <имя>`), после чего миграция запускается
-- снова.
-- =====================================================================

-- Поиск по личности факта: «покажи все версии этого факта» и весь
-- temporal-путь начинаются с fact_key. Индекс частичный — у не
-- перенесённых узлов fact_key пуст, и держать их в индексе незачем.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_nodes_fact_key_idx
    ON memory_nodes (user_id, fact_key) WHERE fact_key IS NOT NULL;

-- Состояние сущности на дату собирается по entity_id. Тоже частичный:
-- у большинства узлов сущность не проставлена.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_nodes_entity_idx
    ON memory_nodes (user_id, entity_id) WHERE entity_id IS NOT NULL;

-- Отбор снимка по периоду действительности.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_nodes_valid_idx
    ON memory_nodes (user_id, valid_from, valid_to);

-- Дедупликация связи ищет пересечение периодов.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_edges_valid_idx
    ON memory_edges (user_id, valid_from, valid_to);

INSERT INTO schema_migrations (version) VALUES ('044_temporal_memory_indexes')
ON CONFLICT (version) DO NOTHING;
