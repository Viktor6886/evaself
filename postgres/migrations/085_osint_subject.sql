BEGIN;

-- Субъект исследования — сущность, с которой сверяется всё найденное.
--
-- Ссылка нужна оркестратору: найденный аккаунт сравнивается именно с
-- субъектом, а не со «всеми сущностями исследования», иначе два случайно
-- найденных профиля склеивались бы между собой в обход решения о
-- тождестве. Ссылка идёт по паре (id, user_id), как и всё в графе OSINT:
-- субъектом не может стать сущность другого пользователя.
--
-- Колонка допускает NULL: исследование создаётся раньше субъекта в той же
-- транзакции, а удаление сущности не должно уносить само исследование.
ALTER TABLE osint_investigations
    ADD COLUMN IF NOT EXISTS subject_entity_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'osint_investigations_subject_fkey'
    ) THEN
        ALTER TABLE osint_investigations
            ADD CONSTRAINT osint_investigations_subject_fkey
            FOREIGN KEY (subject_entity_id, user_id)
            REFERENCES osint_entities (id, user_id)
            ON DELETE SET NULL (subject_entity_id);
    END IF;
END $$;

-- Политика хранения выбирает завершённые исследования по дате создания;
-- дневной лимит пользователя обслуживает osint_investigations_user_idx.
CREATE INDEX IF NOT EXISTS osint_investigations_retention_idx
    ON osint_investigations (created_at)
    WHERE status IN ('completed', 'failed', 'cancelled');

INSERT INTO schema_migrations (version)
VALUES ('085_osint_subject')
ON CONFLICT DO NOTHING;

COMMIT;
