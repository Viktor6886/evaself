BEGIN;
-- Записи дневника, карточки людей и связи каналов удаляются вместе с
-- таблицами: собственных строк в чужих таблицах шаг 25 не заводил, и
-- eva_notes он не трогал — рабочие заметки остаются на месте.
DROP TABLE IF EXISTS channel_message_links;
DROP TABLE IF EXISTS journal_voice_notes;
DROP TABLE IF EXISTS journal_entry_people;
DROP TABLE IF EXISTS journal_people;
DROP TABLE IF EXISTS journal_entry_links;
DROP TABLE IF EXISTS journal_entries;
DELETE FROM schema_migrations WHERE version='052_miniapp_journal';
COMMIT;
