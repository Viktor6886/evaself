-- =====================================================================
-- База знаний: жизненный цикл документа (docs/knowledge-base.md, K3b).
--
--   * загрузка в общую базу администратором: владельца нет, есть
--     коллекция;
--   * исход загрузки для человека: новый документ, дубликат уже
--     загруженного или новая версия прежнего;
--   * начало построения версии эмбеддингов — от него считается прогресс
--     перестройки индекса;
--   * расписание сверки PostgreSQL ↔ Qdrant (выключено, включает человек).
--
-- Совместимость со старым кодом: только новые колонки, индексы и
-- ослабление NOT NULL. Прежняя загрузка человека пишет `user_id` и не
-- знает про коллекцию — проверка области её пропускает.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Загрузка: личная (владелец) или в коллекцию общей базы (администратор).
-- ---------------------------------------------------------------------
ALTER TABLE knowledge_uploads
    -- Коллекция удаляется только пустой (RESTRICT у документов), так что
    -- каскад снимает лишь записи приёма без документа: неудачные и
    -- дубликаты.
    ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES knowledge_collections (id) ON DELETE CASCADE,
    --   new          новый документ
    --   duplicate    тот же файл уже есть: второй документ не заводится
    --   new_version  заменяет прежний документ; тот снимается после
    --                индексации нового
    ADD COLUMN IF NOT EXISTS outcome text
        CHECK (outcome IS NULL OR outcome IN ('new', 'duplicate', 'new_version')),
    -- Явная замена: «загрузить новую версию этого документа». Без неё
    -- новая версия в личной базе не угадывается по имени — у разных
    -- записей бывает одно имя файла.
    ADD COLUMN IF NOT EXISTS replaces_document_id uuid REFERENCES knowledge_documents (id) ON DELETE SET NULL;

ALTER TABLE knowledge_uploads ALTER COLUMN user_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_uploads_scope'
    ) THEN
        ALTER TABLE knowledge_uploads
            ADD CONSTRAINT knowledge_uploads_scope
            CHECK ((user_id IS NULL) = (collection_id IS NOT NULL));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS knowledge_uploads_collection_idx
    ON knowledge_uploads (collection_id, created_at DESC) WHERE collection_id IS NOT NULL;
-- Удаление документа снимает и записи приёма, которые на него ссылаются
-- (исходный файл и дубликаты).
CREATE INDEX IF NOT EXISTS knowledge_uploads_document_idx
    ON knowledge_uploads (document_id) WHERE document_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Документы общей базы: дубликат и прежняя версия ищутся внутри
-- коллекции. Документов общей базы немного — индексы строятся сразу.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS knowledge_documents_collection_hash_idx
    ON knowledge_documents (collection_id, content_hash) WHERE collection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_documents_collection_name_idx
    ON knowledge_documents (collection_id, name) WHERE collection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_documents_replaces_idx
    ON knowledge_documents (replaces_document_id) WHERE replaces_document_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Построение версии эмбеддингов. Идёт, пока `build_started_at` позже
-- `built_at`; прогресс — доля фрагментов, чьи точки уже в коллекциях
-- версии. Перестройка активной версии не меняет её статус: поиск
-- продолжает на неё смотреть.
-- ---------------------------------------------------------------------
ALTER TABLE knowledge_embedding_versions
    ADD COLUMN IF NOT EXISTS build_started_at timestamptz;

-- ---------------------------------------------------------------------
-- Сверка PostgreSQL ↔ Qdrant. Одно расписание на назначение
-- (инвариант 9); выключено, как и все расписания: включает человек
-- вместе с индексацией.
-- ---------------------------------------------------------------------
INSERT INTO job_schedules (code, queue, job_type, schema_version, cron, timezone, enabled, dedup_mode, payload)
VALUES ('knowledge_reconcile', 'memory', 'knowledge_reconcile', 1,
        '23 * * * *', 'UTC', false, 'keep_last_if_active', '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('092_knowledge_lifecycle')
ON CONFLICT (version) DO NOTHING;

COMMIT;
