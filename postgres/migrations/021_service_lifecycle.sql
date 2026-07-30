-- =====================================================================
-- Панель управляет сервисами не только перезапуском.
--
-- До этой миграции admin_operations.kind допускал единственную операцию
-- над сервисом — restart. Перезапуск работает только над существующим
-- контейнером, поэтому остановленный или ни разу не запущенный сервис
-- нельзя было поднять из панели вообще: кнопка отправляла restart в
-- Docker API, тот отвечал 404, и наружу это выглядело как «кнопка не
-- нажимается».
--
-- Добавляются start и stop. Миграция идемпотентна.
-- =====================================================================

BEGIN;

ALTER TABLE admin_operations DROP CONSTRAINT IF EXISTS admin_operations_kind_check;
ALTER TABLE admin_operations ADD CONSTRAINT admin_operations_kind_check
    CHECK (kind IN (
        'restart', 'start', 'stop',
        'backup', 'restore',
        'update-check', 'update', 'rollback', 'migration'
    ));

INSERT INTO schema_migrations (version) VALUES ('021_service_lifecycle')
ON CONFLICT (version) DO NOTHING;

COMMIT;
