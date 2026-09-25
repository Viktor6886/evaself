BEGIN;

-- Таблицы появились в этой миграции и ничего старше себя не содержат:
-- откат снимает только их, чужих строк здесь нет.
DROP TABLE IF EXISTS osint_frontier;
DROP TABLE IF EXISTS osint_collector_runs;
DROP TABLE IF EXISTS osint_entity_matches;
DROP TABLE IF EXISTS osint_relationships;
DROP TABLE IF EXISTS osint_claims;
DROP TABLE IF EXISTS osint_entity_identifiers;
DROP TABLE IF EXISTS osint_evidence;
DROP TABLE IF EXISTS osint_sources;
DROP TABLE IF EXISTS osint_identifiers;
DROP TABLE IF EXISTS osint_investigation_entities;
DROP TABLE IF EXISTS osint_entities;
DROP TABLE IF EXISTS osint_investigations;

DELETE FROM schema_migrations WHERE version = '084_osint_foundation';

COMMIT;
