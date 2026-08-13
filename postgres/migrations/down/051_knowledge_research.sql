BEGIN;
-- Operational rollback MUST run scripts/rollback-knowledge-research.sh first;
-- SQL cannot safely remove owned files from the agent-service filesystem.
ALTER TABLE IF EXISTS research_requests DROP CONSTRAINT IF EXISTS research_requests_report_fk;
DROP TABLE IF EXISTS research_claim_sources;
DROP TABLE IF EXISTS research_sources;
DROP TABLE IF EXISTS research_requests;
DROP TABLE IF EXISTS research_reports;
DROP TABLE IF EXISTS knowledge_chunks;
DROP TABLE IF EXISTS knowledge_documents;
DROP TABLE IF EXISTS knowledge_uploads;
DELETE FROM schema_migrations WHERE version='051_knowledge_research';
COMMIT;
