-- Откат шага 15. Исходные строки memory_nodes и memory_edges не
-- уничтожаются: снимаются только добавленные столбцы и новые таблицы.

BEGIN;

DROP TABLE IF EXISTS memory_backfill_state;
DROP TABLE IF EXISTS memory_conflicts;
DROP TABLE IF EXISTS memory_entity_merges;
DROP TABLE IF EXISTS memory_entity_aliases;
DROP TABLE IF EXISTS memory_evidence;
DROP TABLE IF EXISTS memory_edge_versions;
DROP TABLE IF EXISTS memory_node_versions;

DROP INDEX IF EXISTS memory_edges_valid_idx;
DROP INDEX IF EXISTS memory_nodes_valid_idx;
DROP INDEX IF EXISTS memory_nodes_entity_idx;
DROP INDEX IF EXISTS memory_nodes_fact_key_idx;

-- Строки со статусами шага 15 возвращаются к прежнему словарю, иначе
-- восстановленное ограничение не примет уже записанные значения.
--
-- Блок выполняется, только пока графовые таблицы существуют: миграция
-- 053 сняла графовую память целиком, и на полном откате этот файл
-- отрабатывает уже после неё. Возвращать словарь статусов таблице,
-- которой нет, нечему — но и падать на этом откат не должен.
DO $do$
BEGIN
  IF to_regclass('public.memory_nodes') IS NULL THEN RETURN; END IF;
  EXECUTE $sql$
  UPDATE memory_nodes SET status = 'unconfirmed'
   WHERE status IN ('candidate', 'quarantined');
  UPDATE memory_nodes SET status = 'disputed'
   WHERE status = 'refuted';
  UPDATE memory_nodes SET status = 'archived'
   WHERE status IN ('rejected', 'forgotten', 'deleted');

  ALTER TABLE memory_nodes DROP CONSTRAINT IF EXISTS memory_nodes_status_check;
  ALTER TABLE memory_nodes ADD CONSTRAINT memory_nodes_status_check CHECK (status IN (
      'active', 'unconfirmed', 'disputed', 'superseded', 'archived'
  ));

  UPDATE memory_edges SET status = 'disputed'
   WHERE status IN ('candidate', 'refuted', 'quarantined');
  UPDATE memory_edges SET status = 'archived'
   WHERE status IN ('superseded', 'rejected', 'forgotten', 'deleted');

  ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS memory_edges_status_check;
  ALTER TABLE memory_edges ADD CONSTRAINT memory_edges_status_check CHECK (status IN (
      'active', 'disputed', 'archived'
  ));

  ALTER TABLE memory_edges
      DROP COLUMN IF EXISTS current_version_id,
      DROP COLUMN IF EXISTS event_at,
      DROP COLUMN IF EXISTS observed_at,
      DROP COLUMN IF EXISTS valid_to,
      DROP COLUMN IF EXISTS valid_from,
      DROP COLUMN IF EXISTS version;

  ALTER TABLE memory_nodes
      DROP COLUMN IF EXISTS current_version_id,
      DROP COLUMN IF EXISTS entity_id,
      DROP COLUMN IF EXISTS event_at,
      DROP COLUMN IF EXISTS observed_at,
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS fact_key;
  $sql$;
END
$do$;

DELETE FROM schema_migrations WHERE version = '042_temporal_memory';

COMMIT;
