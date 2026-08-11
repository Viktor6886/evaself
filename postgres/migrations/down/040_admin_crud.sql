-- =====================================================================
-- Откат 040: убрать журнал применений шаблона memory block.
--
-- Существующих строк не трогает: обе таблицы заведены миграцией 040.
-- `letta_memory_block_sync` этим откатом не затрагивается — намерения,
-- записанные применением шаблона, остаются на месте и продолжают
-- синхронизироваться. Теряется только объяснение: «откуда взялось это
-- намерение и каким прогоном его откатывать».
--
-- Поэтому после отката массовое применение шаблонов включать нельзя:
-- применить будет можно, откатить одним действием — нет.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS memory_template_items_user_idx;
DROP INDEX IF EXISTS memory_template_items_agent_idx;
DROP TABLE IF EXISTS memory_template_application_items;

DROP INDEX IF EXISTS memory_template_applications_version_idx;
DROP INDEX IF EXISTS memory_template_applications_recent_idx;
DROP TABLE IF EXISTS memory_template_applications;

DELETE FROM schema_migrations WHERE version = '040_admin_crud';

COMMIT;
