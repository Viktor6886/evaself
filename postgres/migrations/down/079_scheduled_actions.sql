BEGIN;

-- Строки не удаляются. Исходные значения, которых старая схема не
-- допускает, переводятся в допустимые, а прежнее значение сохраняется в
-- метаданных — иначе откат стирал бы историю задач.
UPDATE task_events
   SET metadata = metadata || jsonb_build_object('reverted_event_type', event_type),
       event_type = 'updated'
 WHERE event_type IN ('action_done', 'action_failed');

DROP INDEX IF EXISTS task_events_delivery_once_idx;
CREATE UNIQUE INDEX IF NOT EXISTS task_events_delivery_once_idx
    ON task_events (task_id, event_type, scheduled_at)
    WHERE event_type IN ('reminder_generated', 'reminder_sent');

ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_event_type_check;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_event_type_check CHECK (event_type IN (
        'created', 'updated', 'reminder_generated', 'reminder_sent',
        'delivery_failed', 'user_replied', 'snoozed', 'completed',
        'cancelled', 'reopened'
    ));

-- Conversation выполнения задач архивируется, а не удаляется: её история
-- принадлежит человеку. Активной она быть перестаёт, поэтому частичный
-- уникальный индекс по (agent_id, purpose) не конфликтует.
UPDATE agent_conversations
   SET status = 'archived',
       archived_at = COALESCE(archived_at, now()),
       purpose = 'scheduler'
 WHERE purpose = 'task_action';

ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_purpose_check;
ALTER TABLE agent_conversations
    ADD CONSTRAINT agent_conversations_purpose_check CHECK (purpose IN (
        'chat', 'scheduler', 'maintenance', 'profile',
        'goal_review', 'partner_analysis', 'research'
    ));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_attempts_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks DROP COLUMN IF EXISTS attempts;
ALTER TABLE tasks DROP COLUMN IF EXISTS kind;

DELETE FROM schema_migrations WHERE version = '079_scheduled_actions';

COMMIT;
