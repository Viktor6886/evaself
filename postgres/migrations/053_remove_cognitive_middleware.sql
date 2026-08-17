BEGIN;

-- Снятие самописного когнитивного слоя.
--
-- Память агента остаётся за Letta: собственные версии фактов, граф,
-- эпизоды, выжимки разговора, диагностика памяти, эмбеддинги и теневая
-- синхронизация блоков больше не пишутся и не читаются ни одним модулем.
-- Вместе с ними уходит собственный отбор навыков и инструментов: их
-- набор определяет Letta, а PostgreSQL хранит только подтверждения
-- действий человеком и политику MCP-серверов.
--
-- Проект находится в разработке: перенос содержимого этих таблиц не
-- выполняется, потому что переносить его некуда — у Letta своя память.

-- 1. Теневая память и её обслуживание.
DROP TABLE IF EXISTS memory_template_application_items;
DROP TABLE IF EXISTS memory_template_applications;
DROP TABLE IF EXISTS letta_memory_block_sync;

-- 2. Диагностика памяти.
DROP TABLE IF EXISTS memory_doctor_actions;
DROP TABLE IF EXISTS memory_doctor_reports;

-- 3. Гибридный поиск по памяти. Расширения `vector` и `pg_trgm`
--    остаются: на них живут knowledge-фрагменты продуктовой базы знаний.
DROP TABLE IF EXISTS memory_embedding_reindex;
DROP TABLE IF EXISTS memory_embeddings;

-- 4. Temporal-память, Curator и эпизоды.
DROP TABLE IF EXISTS memory_backfill_state;
DROP TABLE IF EXISTS memory_conflicts;
DROP TABLE IF EXISTS memory_entity_merges;
DROP TABLE IF EXISTS memory_entity_aliases;
DROP TABLE IF EXISTS memory_evidence;
DROP TABLE IF EXISTS memory_edge_versions;
DROP TABLE IF EXISTS memory_node_versions;
DROP TABLE IF EXISTS memory_curator_runs;
DROP TABLE IF EXISTS memory_episodes;

-- 5. Графовая память и выжимки разговора.
DROP TABLE IF EXISTS memory_edges;
DROP TABLE IF EXISTS memory_nodes;
DROP TABLE IF EXISTS conversation_highlights;

-- 6. Собственный роутинг навыков и его индекс.
DROP TABLE IF EXISTS skill_routing_events;
DROP TABLE IF EXISTS skill_routing_state;
DROP TABLE IF EXISTS skill_search_index;

-- 7. Tool Gateway: kill switch, аренды и отбор инструментов на
--    conversation. Подтверждения действий (`tool_approvals`,
--    `tool_approval_rules`) и политика MCP остаются — это продуктовая
--    авторизация, а не выбор инструментов моделью.
DROP TABLE IF EXISTS tool_gateway_leases;
DROP TABLE IF EXISTS tool_gateway_state;
ALTER TABLE agent_conversations
  DROP COLUMN IF EXISTS current_task_tools,
  DROP COLUMN IF EXISTS selected_skill_tools;

-- 8. Собственное управление контекстом: ротация conversation и
--    compaction по числу сообщений. Контекстом распоряжается Letta.
ALTER TABLE sdk_settings DROP CONSTRAINT IF EXISTS sdk_settings_context_management_check;
ALTER TABLE sdk_settings DROP COLUMN IF EXISTS automatic_context_management;

-- 9. Расписания заданий снятых подсистем.
DELETE FROM job_schedules WHERE job_type IN ('memory_doctor_sweep', 'memory_temporal_backfill');

INSERT INTO schema_migrations (version) VALUES ('053_remove_cognitive_middleware')
ON CONFLICT (version) DO NOTHING;

COMMIT;
