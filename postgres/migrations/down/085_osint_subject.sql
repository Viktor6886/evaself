BEGIN;

-- Откат снимает только ссылку на субъект и индекс хранения: сами
-- исследования, сущности и доказательства остаются на месте.
ALTER TABLE osint_investigations DROP CONSTRAINT IF EXISTS osint_investigations_subject_fkey;
DROP INDEX IF EXISTS osint_investigations_retention_idx;
ALTER TABLE osint_investigations DROP COLUMN IF EXISTS subject_entity_id;

DELETE FROM schema_migrations WHERE version = '085_osint_subject';

COMMIT;
