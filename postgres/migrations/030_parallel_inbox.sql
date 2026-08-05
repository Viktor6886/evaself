-- =====================================================================
-- Индексы claim для параллельного диспетчера durable inbox.
--
-- Таблица `telegram_updates` не меняется: ни одного нового столбца, ни
-- одного изменённого ограничения. Меняется только то, как по ней ищут.
--
-- Прежний воркер брал одну запись и упорядочивал очередь целиком, ему
-- хватало `telegram_updates_delivery_idx (status, available_at,
-- received_at)`. Параллельный диспетчер задаёт другой вопрос: «первое
-- незавершённое сообщение каждого человека», и внутри он проверяет,
-- нет ли у того же человека сообщения раньше. Первый индекс отвечает за
-- сам батч и его порядок, второй — за эту проверку.
--
-- ВНИМАНИЕ: файл намеренно без BEGIN/COMMIT. `CREATE INDEX
-- CONCURRENTLY` внутри транзакции невозможен, а таблица здесь не пустая
-- — в отличие от таблиц шага 3, которые заводились той же миграцией.
-- Правило `CLAUDE.md` про CONCURRENTLY относится ровно к этому случаю.
--
-- Оговорка про повторный запуск: если построение CONCURRENTLY когда-то
-- прервалось, в схеме остаётся невалидный индекс, и `IF NOT EXISTS` его
-- пропустит. Признак — `pg_index.indisvalid = false`; лечится ручным
-- `DROP INDEX` и повторным применением миграции.
-- =====================================================================

-- Батч и его порядок: статус, срок доступности, порядок приёма и
-- арендатор. Отдельного столбца приоритета в таблице нет и этот шаг его
-- не заводит — трогать `telegram_updates` ему запрещено; порядок
-- задаётся временем приёма.
CREATE INDEX CONCURRENTLY IF NOT EXISTS telegram_updates_claim_idx
    ON telegram_updates (status, available_at, received_at, update_id, telegram_user_id)
    WHERE status IN ('queued', 'retry', 'processing');

-- Строгий порядок внутри человека: есть ли у него незавершённое
-- сообщение раньше этого.
CREATE INDEX CONCURRENTLY IF NOT EXISTS telegram_updates_user_pending_idx
    ON telegram_updates (telegram_user_id, received_at, update_id)
    WHERE status IN ('queued', 'retry', 'processing');

INSERT INTO schema_migrations (version)
VALUES ('030_parallel_inbox')
ON CONFLICT (version) DO NOTHING;
