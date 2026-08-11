-- =====================================================================
-- Откат 039: убрать единый реестр артефактов.
--
-- Существующих строк не трогает: все четыре таблицы заведены миграцией 039.
-- Настройки в `system_settings` и журнал `config_versions` этим откатом не
-- затрагиваются — это разные механизмы, реестр их не замещал.
--
-- Что теряется вместе с таблицами: связь прогонов с версиями артефактов.
-- После отката вопрос «на какой версии промпта выполнялся этот ход» снова
-- останется без ответа, поэтому включать фиксацию версий на откаченной
-- схеме нельзя.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS artifact_usages_version_idx;
DROP INDEX IF EXISTS artifact_usages_run_idx;
DROP TABLE IF EXISTS artifact_usages;

DROP INDEX IF EXISTS artifact_publications_history_idx;
DROP INDEX IF EXISTS artifact_publications_active_uidx;
DROP TABLE IF EXISTS artifact_publications;

DROP TRIGGER IF EXISTS artifact_versions_immutable_trg ON artifact_versions;
DROP FUNCTION IF EXISTS artifact_versions_immutable();

DROP INDEX IF EXISTS artifact_versions_checksum_idx;
DROP INDEX IF EXISTS artifact_versions_artifact_idx;
DROP TABLE IF EXISTS artifact_versions;

DROP TABLE IF EXISTS artifacts;

DELETE FROM schema_migrations WHERE version = '039_artifact_registry';

COMMIT;
