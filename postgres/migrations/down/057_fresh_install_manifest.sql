BEGIN;
-- Индекс не удаляем: он принадлежит реестру артефактов, а не удалённым
-- подсистемам, и на существующей установке его завела миграция 047.
DELETE FROM schema_migrations WHERE version='057_fresh_install_manifest';
COMMIT;
