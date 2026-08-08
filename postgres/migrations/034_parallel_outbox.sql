-- Priority is additive and backward compatible: old application versions do
-- not name the column and therefore keep the ready-answer default.

BEGIN;

ALTER TABLE telegram_outbox
    ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 10;

ALTER TABLE telegram_outbox
    DROP CONSTRAINT IF EXISTS telegram_outbox_priority_check;
ALTER TABLE telegram_outbox
    ADD CONSTRAINT telegram_outbox_priority_check
        CHECK (priority IN (0, 10, 20, 30, 40)) NOT VALID;

-- Only service methods are unambiguous in historical rows. Existing messages
-- stay ready answers; inventing whether their text was a command or crisis
-- alert after the fact would be less safe than the conservative default.
UPDATE telegram_outbox
   SET priority = 40
 WHERE telegram_method IN ('sendChatAction', 'sendMessageDraft')
   AND priority = 10;

INSERT INTO schema_migrations (version) VALUES ('034_parallel_outbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;
