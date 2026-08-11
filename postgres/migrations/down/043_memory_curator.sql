-- Откат шага 16. Память, накопленная через Curator, остаётся на месте:
-- она живёт в memory_nodes и memory_node_versions, а здесь снимаются
-- только эпизоды и журнал прогонов.

BEGIN;

DROP TABLE IF EXISTS memory_curator_runs;
DROP TABLE IF EXISTS memory_episodes;

DELETE FROM schema_migrations WHERE version = '043_memory_curator';

COMMIT;
