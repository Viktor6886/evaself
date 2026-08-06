-- =====================================================================
-- Откат 031: убрать журналы побочных эффектов и восстановления.
--
-- Существующих строк не трогает: обе таблицы заведены миграцией 031 и
-- ничем, кроме неё, не пишутся. После отката восстановление хода
-- перестаёт быть наблюдаемым, а защита от повторного побочного эффекта
-- исчезает — включать флаг EVA_TURN_RECOVERY после этого нельзя.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS turn_recovery_attempts_run_idx;
DROP INDEX IF EXISTS tool_effects_stale_idx;
DROP INDEX IF EXISTS tool_effects_run_idx;

DROP TABLE IF EXISTS turn_recovery_attempts;
DROP TABLE IF EXISTS tool_effects;

DELETE FROM schema_migrations WHERE version = '031_turn_recovery';

COMMIT;
