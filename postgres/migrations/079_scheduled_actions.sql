BEGIN;

-- =====================================================================
-- Задача, которую Ева выполняет сама
-- =====================================================================
--
-- До сих пор наступившая задача означала одно: сочинить напоминание и
-- отправить его человеку. Просьба «через десять минут найди новости в
-- Перми» приводила к тексту «напоминаю: найти новости в Перми» — работа
-- возвращалась тому, кто просил её сделать.
--
-- `kind` называет, что происходит в момент срабатывания:
--   reminder — как раньше, сообщение человеку;
--   action   — Ева выполняет задачу своими инструментами и отдаёт
--              человеку результат.
--
-- Forward-совместимо: у колонки есть значение по умолчанию, и старый код,
-- который о ней не знает, продолжает создавать напоминания.
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'reminder',
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('reminder', 'action'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_attempts_check;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_attempts_check CHECK (attempts >= 0);

COMMENT ON COLUMN tasks.kind IS
    'reminder — напомнить человеку; action — выполнить самой и отдать результат.';
COMMENT ON COLUMN tasks.attempts IS
    'Неудачные попытки подряд по текущему сроку. Обнуляется удачей и переносом срока.';

-- Исход выполнения — такое же событие задачи, как отправленное
-- напоминание. Без него «Ева сделала и вот что вышло» негде хранить:
-- история задачи знала только про напоминания.
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_event_type_check;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_event_type_check CHECK (event_type IN (
        'created', 'updated', 'reminder_generated', 'reminder_sent',
        'delivery_failed', 'user_replied', 'snoozed', 'completed',
        'cancelled', 'reopened', 'action_done', 'action_failed'
    ));

-- Один срок — одно выполнение. Тот же уникальный индекс, что защищает
-- напоминание от повторной отправки, теперь защищает и действие: оно
-- дороже напоминания, и повтор виден человеку как «Ева сделала это
-- дважды».
DROP INDEX IF EXISTS task_events_delivery_once_idx;
CREATE UNIQUE INDEX IF NOT EXISTS task_events_delivery_once_idx
    ON task_events (task_id, event_type, scheduled_at)
    WHERE event_type IN ('reminder_generated', 'reminder_sent', 'action_done');

-- Служебная conversation для выполнения задач.
--
-- У conversation назначения `scheduler` инструменты запрещены полностью:
-- она сочиняет текст напоминания, и больше ей ничего не нужно. Действию
-- инструменты нужны все, поэтому оно живёт в своём назначении, а не
-- ослабляет политику планировщика (инвариант 5: изолированные
-- conversations по назначению).
ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_purpose_check;
ALTER TABLE agent_conversations
    ADD CONSTRAINT agent_conversations_purpose_check CHECK (purpose IN (
        'chat', 'scheduler', 'maintenance', 'profile',
        'goal_review', 'partner_analysis', 'research', 'task_action'
    ));

INSERT INTO schema_migrations (version)
VALUES ('079_scheduled_actions')
ON CONFLICT DO NOTHING;

COMMIT;
