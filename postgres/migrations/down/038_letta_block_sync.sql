-- =====================================================================
-- Откат 038: убрать состояние синхронизации memory blocks.
--
-- Существующих строк не трогает: таблица заведена миграцией 038, до неё
-- её содержимого нигде не было. Сами memory blocks живут в Letta и в
-- проекциях памяти PostgreSQL — их этот откат не касается.
--
-- Что теряется вместе с таблицей: знание о том, какие блоки записаны
-- официальным путём, а какие держатся runtime override. После отката
-- система снова не сможет отличить одно от другого, поэтому включать
-- запись блоков через control plane на откаченной схеме нельзя.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS letta_memory_block_sync_retry_idx;
DROP INDEX IF EXISTS letta_memory_block_sync_user_idx;

DROP TABLE IF EXISTS letta_memory_block_sync;

DELETE FROM schema_migrations WHERE version = '038_letta_block_sync';

COMMIT;
