-- =====================================================================
-- Откат 030: убрать индексы claim.
--
-- Строк не трогает вовсе — индекс данных не хранит. После отката
-- диспетчер продолжает работать, просто медленнее: запросы вернутся к
-- `telegram_updates_delivery_idx` и последовательному сканированию по
-- пользователю.
--
-- Без BEGIN/COMMIT по той же причине, что и forward: `DROP INDEX
-- CONCURRENTLY` внутри транзакции невозможен.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS telegram_updates_user_pending_idx;
DROP INDEX CONCURRENTLY IF EXISTS telegram_updates_claim_idx;

DELETE FROM schema_migrations WHERE version = '030_parallel_inbox';
