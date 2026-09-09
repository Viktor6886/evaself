BEGIN;

-- Строки не удаляются. Событие, которого старая схема не допускает,
-- переводится в допустимое, а прежнее сохраняется в метаданных: откат
-- не должен стирать историю задач.
UPDATE task_events
   SET metadata = metadata || jsonb_build_object('reverted_event_type', event_type),
       event_type = 'updated'
 WHERE event_type = 'action_awaiting_approval';

ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_event_type_check;
ALTER TABLE task_events
    ADD CONSTRAINT task_events_event_type_check CHECK (event_type IN (
        'created', 'updated', 'reminder_generated', 'reminder_sent',
        'delivery_failed', 'user_replied', 'snoozed', 'completed',
        'cancelled', 'reopened', 'action_done', 'action_failed'
    ));

-- Незакрытые фоновые вопросы отменяются: после отката спросить их
-- заново будет некому, а «pending» без спрашивающего висел бы вечно.
UPDATE tool_approvals
   SET status = 'cancelled', decision = 'deny', decided_at = now()
 WHERE status = 'pending' AND unattended;

DROP INDEX IF EXISTS tool_approvals_unattended_pending_idx;
ALTER TABLE tool_approvals DROP COLUMN IF EXISTS unattended;

DELETE FROM schema_migrations WHERE version = '082_background_approvals';

COMMIT;
