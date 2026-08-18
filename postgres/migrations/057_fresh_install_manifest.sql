BEGIN;

-- Опора для чистой установки.
--
-- Новая установка больше не создаёт подсистемы, которые тут же удаляет
-- миграция 053: графовую и temporal-память, Memory Curator, Memory
-- Doctor, Hybrid Retrieval и индекс навыков. Список пропускаемых
-- миграций — `postgres/migrations/fresh-install-skip.txt`, и пропуск
-- работает только на пустой базе; существующая установка по-прежнему
-- идёт всей цепочкой, ничего не теряя.
--
-- Одна вещь из пропускаемых миграций переживает удаление: уникальный
-- индекс на версии артефактов, заведённый в 047 вместе с навыками. Он
-- нужен реестру артефактов и потому создаётся здесь — для существующей
-- установки это пустая операция, для новой единственный способ его
-- получить.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_versions_artifact_checksum_uidx
    ON artifact_versions(artifact_id, checksum);

INSERT INTO schema_migrations (version) VALUES ('057_fresh_install_manifest')
ON CONFLICT (version) DO NOTHING;

COMMIT;
