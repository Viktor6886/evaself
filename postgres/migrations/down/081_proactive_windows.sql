BEGIN;

-- Запланированные, но ещё не отправленные сообщения закрываются, а не
-- удаляются: строка слота защищает от повторной отправки, и её потеря
-- означала бы второе сообщение после отката.
UPDATE proactive_messages
   SET status = 'skipped', reason = COALESCE(reason, 'schema_rollback')
 WHERE status = 'scheduled';

UPDATE proactive_messages
   SET status = 'skipped',
       reason = COALESCE(reason, 'schema_rollback')
 WHERE kind = 'initiative' AND status = 'planned';

-- Строки инициативы переводятся в вид, который допускает старая схема,
-- а прежний вид сохраняется в причине: откат не должен стирать факт
-- отправленного человеку сообщения.
UPDATE proactive_messages
   SET kind = 'heartbeat',
       reason = COALESCE(reason, '') || ' reverted_kind=initiative'
 WHERE kind = 'initiative';

DROP INDEX IF EXISTS proactive_messages_due_idx;

ALTER TABLE proactive_messages DROP CONSTRAINT IF EXISTS proactive_messages_kind_check;
ALTER TABLE proactive_messages
    ADD CONSTRAINT proactive_messages_kind_check
        CHECK (kind IN ('reminder', 'heartbeat', 'checkin_morning',
                        'checkin_evening', 'daily_insight', 'weekly_review'));

ALTER TABLE proactive_messages DROP CONSTRAINT IF EXISTS proactive_messages_status_check;
ALTER TABLE proactive_messages
    ADD CONSTRAINT proactive_messages_status_check
        CHECK (status IN ('planned', 'sent', 'skipped', 'failed'));

ALTER TABLE proactive_messages
    DROP COLUMN IF EXISTS window_id,
    DROP COLUMN IF EXISTS valid_until,
    DROP COLUMN IF EXISTS scheduled_for;

-- Conversation инициативы архивируется, а не удаляется: её история
-- принадлежит человеку. Активной она быть перестаёт, поэтому частичный
-- уникальный индекс по (agent_id, purpose) не конфликтует.
UPDATE agent_conversations
   SET status = 'archived',
       archived_at = COALESCE(archived_at, now()),
       purpose = 'scheduler'
 WHERE purpose = 'initiative';

ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_purpose_check;
ALTER TABLE agent_conversations
    ADD CONSTRAINT agent_conversations_purpose_check CHECK (purpose IN (
        'chat', 'scheduler', 'maintenance', 'profile',
        'goal_review', 'partner_analysis', 'research', 'task_action'
    ));

-- Таблица окон удаляется целиком: её создала эта же миграция, и вне её
-- у строк нет ни потребителя, ни смысла.
DROP TABLE IF EXISTS proactive_windows;

DELETE FROM schema_migrations WHERE version = '081_proactive_windows';

COMMIT;
