-- =====================================================================
-- Приоритет доставки Telegram.
--
-- Доставка перестаёт быть очередью в порядке поступления. Сообщение
-- кризисного монитора и «печатает…» — не равноценные события, и когда
-- очередь длинная, разница между ними становится разницей между
-- вовремя и никогда.
--
-- Числа, а не имена: сортировать очередь по тексту значило бы завести
-- порядок, который не виден в самом значении. Меньшее число — выше
-- приоритет, шаг 10 оставляет место между ступенями.
--
--    10  кризис
--    20  готовый ответ пользователю
--    30  команды и платежи
--    40  напоминания
--    50  typing и служебные статусы
--
-- Умолчание 20: строка, которую поставили в очередь, ничего о себе не
-- сказав, — это ответ человеку. Ошибиться в эту сторону безопаснее.
--
-- =====================================================================

BEGIN;

ALTER TABLE telegram_outbox
    ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 20;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_priority_check;
ALTER TABLE telegram_outbox
    ADD CONSTRAINT telegram_outbox_priority_check
    CHECK (priority IN (10, 20, 30, 40, 50));

-- Порядок выборки: приоритет, затем готовность, затем возраст.
-- `chat_id` в индексе — для проверки «нет ли у этого чата более
-- раннего незавершённого сообщения», без которой параллельная выборка
-- переставила бы части одного ответа местами.
CREATE INDEX IF NOT EXISTS telegram_outbox_priority_idx
    ON telegram_outbox (priority, available_at, id)
    WHERE status IN ('pending', 'sending', 'retry');

CREATE INDEX IF NOT EXISTS telegram_outbox_chat_pending_idx
    ON telegram_outbox (chat_id, priority, id)
    WHERE status IN ('pending', 'sending', 'retry');

INSERT INTO schema_migrations (version)
VALUES ('034_outbox_priority')
ON CONFLICT (version) DO NOTHING;

COMMIT;
