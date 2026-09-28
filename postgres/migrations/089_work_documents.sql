-- =====================================================================
-- 089 — рабочие документы на сутки: расшифровки и документы Евы
--
-- Полная расшифровка длинной записи не помещается в ход Евы целиком, а
-- человек просит переделать её — «сделай тезисами», «убери повторы» — и
-- прислать новым файлом. Для этого текст хранится сутки: Ева читает его
-- по частям (`document_read`) и присылает новый документ
-- (`document_send`), который тоже хранится сутки для следующих правок.
--
-- Проверка эквивалента (правило 20). `knowledge_uploads` — постоянная
-- база знаний под флагом EVA_KNOWLEDGE_UPLOADS, с проверкой ClamAV и
-- эмбеддингами: другой срок жизни и другое назначение. `telegram_outbox`
-- — доставка, а не хранение. Заметки и дневник — данные человека без
-- срока. Рабочей копии на сутки среди них нет.
--
-- Сами файлы DOCX здесь не хранятся: после доставки их байты вычищаются
-- из очереди отправки, а текст удаляется по `expires_at` таймером агента.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS work_documents (
    id           uuid        PRIMARY KEY,
    user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    title        text        NOT NULL,
    content      text        NOT NULL,
    source_name  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    CONSTRAINT work_documents_kind_check CHECK (kind IN ('transcript', 'document')),
    CONSTRAINT work_documents_title_check CHECK (length(title) BETWEEN 1 AND 300),
    CONSTRAINT work_documents_expiry_check CHECK (expires_at > created_at)
);

-- Последний документ человека — самый частый запрос: «переделай то, что
-- ты прислала».
CREATE INDEX IF NOT EXISTS work_documents_user_created_idx
    ON work_documents (user_id, created_at DESC);
-- Удаление по сроку идёт по всем пользователям сразу.
CREATE INDEX IF NOT EXISTS work_documents_expires_idx
    ON work_documents (expires_at);

INSERT INTO schema_migrations (version)
VALUES ('089_work_documents')
ON CONFLICT (version) DO NOTHING;

COMMIT;
