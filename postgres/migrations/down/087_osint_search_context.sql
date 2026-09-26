BEGIN;

-- Откат снимает только уточнение поиска: исследования и всё найденное
-- остаются на месте.
ALTER TABLE osint_investigations DROP COLUMN IF EXISTS search_context;

DELETE FROM schema_migrations WHERE version = '087_osint_search_context';

COMMIT;
